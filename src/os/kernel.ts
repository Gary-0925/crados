// crados 内核：时钟中断驱动的轮转调度、系统调用分发、真实块设备与内存管理
//
// 存储的真相只有两处：BlockDev 的字节数组（磁盘）与 Memory 的字节数组（内存条）。
// 文件系统的目录、inode、位图都是磁盘字节里的字段；执行程序必须先把磁盘上的
// 映像逐块拷贝进物理页帧，CPU 再从内存取指——没有任何数据"住在" JS 对象里。

import {
  BlockDev,
  diskSpec,
  downloadDev,
  dropDev,
  listStoredDisks,
  loadDev,
  nextDiskName,
  rememberDisk,
  saveDev,
  SPECS,
} from './blockdev'
import { applyLoginPolicy, CRFS, M_OEXEC, T_FILE, UID_ROOT, UID_USER, VFS } from './fs'
import {
  DEVINFO_BASE,
  DEVINFO_SLOTS,
  DEVINFO_STRIDE,
  FRAME_COUNT,
  KERNEL_TEXT_FRAME,
  KERNEL_TEXT_PAGES,
  KMSG_BASE,
  KMSG_SIZE,
  Memory,
  PAGE_SIZE,
  RAM_SIZE,
  RESERVED_FRAME,
  RESERVED_FRAMES,
  USER_FRAME_START,
} from './memory'
import { assemble, disassemble, loadExe } from './isa'
import { ASM_PROGRAMS } from './asmsrc'
import { GUEST_IDLE_SOURCE, GUEST_KERNEL_SOURCE } from './guestkernel'
import { GUEST_POLICY_SOURCE } from './guestpolicy'
import { Fault, NO_IRQ, runExe, VECTOR_TIMER, VECTOR_TTY } from './vm'
import type { Bus } from './vm'
import { deviceCode, deviceName, MAX_PROCS, PCB_BASE, PCB_SIZE, Process } from './process'
import type { VfsHooks } from './process'
import { buildRootImage } from './rootimg'
import { isErr } from './types'
import type { BlkInfo, Err, Gen, Syscall } from './types'

export const QUANTUM = 5
const AUTOSYNC_MS = 1000 // 脏数据自动回写间隔，按真实时间计而非 tick
const TURBO_BUDGET_MS = 6 // 不限速模式每帧允许占用的时间
const SLICES_PER_PUMP = 8
const KERNEL_STACK_VPN = 15
const KERNEL_TEXT_PFN = KERNEL_TEXT_FRAME
const KERNEL_TEXT_BASE = KERNEL_TEXT_PFN * PAGE_SIZE
const MMIO_TTY_OUT = 0xff00
const MMIO_TTY_ERR = 0xff01
const MMIO_TTY_STATUS = 0xff10
const MMIO_TTY_DATA = 0xff11
const MMIO_BLOCK = 0xfe00
const SECTOR_SIZE = 256
// 挂载表：8 项 x 4 字节，CRX 内核的只读 VFS 靠它跨越挂载点
const KCB_MOUNTS = 0x00c0
const KCB_MOUNT_SLOTS = 8
const UTF8_ENCODER = new TextEncoder()


export type SegClass = 'out' | 'err' | 'sys' | 'echo'
export interface Seg {
  t: string
  c: SegClass
}
export interface Line {
  segs: Seg[]
}
// Optional observer; absent observers have no trace storage cost.
export interface KernelObserver {
  changed(): void
  syscall?(tick: number, pid: number, pname: string, call: Syscall, result: unknown, blocked: boolean): void
}

function* unloadedGen(): Gen {
  return
}

type ExecSpec = { entry: number }

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
const hexAddr = (n: number) => '0x' + n.toString(16).padStart(4, '0')
export class Kernel {
  readonly mem = new Memory()
  readonly vfs = new VFS()
  private readonly devs = new Map<string, BlockDev>()
  private readonly fss = new Map<string, CRFS>()
  private readonly procs = new Map<number, Process>()
  private readonly romErrors: string[] = []
  private kernelIvt = 0
  private nextPid = 0

  ticks = 0
  instructions = 0
  hz = 20
  paused = false
  private currentPid = -1
  private lastPicked = -1
  private shellPid = -1
  private fgPid: number | null = null

  private lines: Line[] = []
  private lineBuf = ''
  private lineQueue: (string | null)[] = []
  private inputPacket: Uint8Array | null | undefined
  private inputOffset = 0
  private ttyIrqPending = false
  // TTY 是字节设备，UTF-8 只在驱动边界解码；stream 模式能跨 write 调用保留半个字符。
  private readonly ttyDecoders = {
    out: new TextDecoder('utf-8', { fatal: false }),
    err: new TextDecoder('utf-8', { fatal: false }),
  }
  // Block controller registers (big-endian u16): command, device, block,
  // buffer, status. TypeScript implements DMA only; CRFS remains unknown here.
  private readonly blockRegs = new Uint8Array(10)
  private readonly klog: { tick: number; msg: string }[] = []

  // 可移动设备没有数量上限；键是设备名，值是它当前的挂载点
  private readonly mounts = new Map<string, string>()
  private dirty = false
  private lastSyncMs = 0
  private storageOk = true
  private persist = true

  turbo = false
  private suppress = false // 批量执行时合并通知，避免每 tick 都唤醒观察者

  panic: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  observer: KernelObserver | null = null
  private nextTimerIrq = performance.now()

  constructor() {
    this.boot()
  }

  // ---------- 引导 ----------

  private boot() {
    const stamp = (msg: string) => {
      this.ticks++
      this.log(msg, true)
    }
    stamp('crados 3.0 booting on browser/js')
    stamp(`cpu: 1 core, timer interrupt ${this.hz} Hz, round robin quantum ${QUANTUM}`)
    stamp(`mm: ${FRAME_COUNT} frames of ${PAGE_SIZE} B, ${RAM_SIZE / 1024} KiB`)

    if (!this.installGuestKernel()) {
      this.setPanic('cannot install CRX kernel trap page')
      return
    }

    // ROM：固件镜像，每次上电重新烧写
    const rom = this.makeDev('rom')
    const romfs = this.fss.get('rom')!
    romfs.format('firmware')
    this.vfs.mount('/', romfs) // 临时根，便于写入 ROM 内容
    const compiled = this.installFirmware(romfs)
    stamp(
      `rom: ${rom.blockCount} blocks of ${rom.blockSize} B, ${romfs.usedInodes()} objects, ${compiled} as native CRX code`,
    )

    // sda：根盘，优先从持久化存储恢复整盘字节
    const sda = this.makeDev('sda')
    const sdafs = this.fss.get('sda')!
    const restored = loadDev(sda) && sdafs.valid()
    if (!restored) {
      // 首次上电：把随系统分发的根盘镜像整体写入设备，与从主机导入 .img 等价
      const image = buildRootImage()
      sda.load(image.bytes)
      for (const e of image.errors) this.log(`rootfs image: ${e}`)
    }
    this.vfs.umount('/')
    this.vfs.mount('/', sdafs)
    this.vfs.mount('/bin', romfs)
    this.ensureCreds('sda')
    stamp(
      restored
        ? `sda: superblock valid, ${sdafs.usedInodes()} inodes, ${sdafs.usedBlocks()}/${sda.blockCount} blocks in use`
        : `sda: root image written, ${sdafs.usedInodes()} inodes, ${sdafs.usedBlocks()}/${sda.blockCount} blocks in use`,
    )
    stamp('vfs: mounted /dev/sda on /, /dev/rom on /bin')

    for (const name of listStoredDisks()) {
      const dev = this.makeDev(name, diskSpec(name))
      if (loadDev(dev) && this.fss.get(name)!.valid()) {
        stamp(`${name}: medium present, label "${this.fss.get(name)!.label()}"`)
        continue
      }
      // 内容已失效就撤掉这个设备，避免留下一个读不出内容的空盘
      this.devs.delete(name)
      this.fss.delete(name)
      dropDev(name)
    }

    this.storageOk = this.persist ? saveDev(sda) : false
    stamp('tty0: console ready, canonical mode with echo')

    if (this.romErrors.length) {
      this.panic = `ROM build failed: ${this.romErrors.join('; ')}`
      this.log(`Kernel panic - not syncing: ${this.panic}`, true)
      this.emit()
      return
    }

    if (!this.startIdle()) {
      this.setPanic('cannot execute CRX idle process')
      return
    }
    stamp(this.startInit())
    this.startTimer()
    this.emit()
  }

  // 供 PCB 使用：工作目录以 (设备号, inode 号) 落在内存里，路径靠 parent 链回溯
  private readonly vfsHooks: VfsHooks = {
    pathOf: (dev, ino) => {
      const fs = this.fss.get(deviceName(dev))
      if (!fs || !fs.inodeUsed(ino)) return '/'
      const parts: string[] = []
      let cur = ino
      for (let guard = 0; guard < 32 && cur !== 1; guard++) {
        const parent = fs.iparent(cur)
        const entry = fs.entries(parent).find((e) => e.ino === cur)
        if (!entry) break
        parts.unshift(entry.name)
        cur = parent
      }
      const mount = this.vfs.mounts.find((m) => m.fs === fs)
      const prefix = mount && mount.path !== '/' ? mount.path : ''
      return prefix + '/' + parts.join('/')
    },
    lookup: (path) => {
      const node = this.vfs.resolve(path, '/')
      if ('err' in node) return { dev: deviceCode('sda'), ino: 1 }
      return { dev: deviceCode(node.dev.spec.name) || deviceCode('sda'), ino: node.ino }
    },
  }

  private makeDev(name: string, spec = SPECS[name]): BlockDev {
    const dev = new BlockDev(spec)
    this.devs.set(name, dev)
    this.fss.set(name, new CRFS(dev))
    return dev
  }

  // 烧写 ROM：/bin 里只接受汇编后的 CRX 映像
  private installFirmware(fs: CRFS): number {
    let compiled = 0
    for (const [name, source] of Object.entries(ASM_PROGRAMS)) {
      const r = assemble(source)
      if (r.errors.length) {
        const error = `${name}: ${r.errors[0]}`
        this.romErrors.push(error)
        this.log(`rom: failed to assemble ${error}`)
        continue
      }
      const ino = fs.create(1, name, T_FILE)
      if (typeof ino !== 'number') continue
      fs.writeBytes(ino, r.bytes)
      fs.setExec(ino, true)
      fs.setFlags(ino, fs.iflags(ino) | M_OEXEC)
      compiled++
    }
    return compiled
  }

  // Load the privileged CRX kernel into reserved physical frames. Kernel mode
  // fetches it through the direct physical map, so user page tables never map it.
  private installGuestKernel(): boolean {
    const built = assemble(GUEST_KERNEL_SOURCE + GUEST_POLICY_SOURCE)
    if (built.errors.length || built.bytes.length < 16) {
      for (const e of built.errors) this.log(`kernel asm: ${e}`)
      return false
    }
    const image = built.bytes.slice(16)
    // 文本必须停在 MMIO 窗口前面，否则中断向量会被读成 0。
    if (image.length > PAGE_SIZE * KERNEL_TEXT_PAGES || KERNEL_TEXT_BASE + image.length > 0xff00 || built.symbols.ivt === undefined) {
      this.log(`kernel asm: image ${image.length} B does not fit in ${PAGE_SIZE * KERNEL_TEXT_PAGES} B`)
      return false
    }

    // Relocate absolute symbol references from image offset zero.
    for (const at of built.relocations) {
      if (at < 0 || at + 1 >= image.length) return false
      const relative = (image[at] << 8) | image[at + 1]
      const absolute = KERNEL_TEXT_BASE + relative
      if (absolute > 0xffff) return false
      image[at] = (absolute >> 8) & 0xff
      image[at + 1] = absolute & 0xff
    }

    for (let page = 0; page < KERNEL_TEXT_PAGES; page++) {
      const pfn = KERNEL_TEXT_PFN + page
      this.mem.zero(pfn)
      const chunk = image.subarray(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      this.mem.bytes.set(chunk, pfn * PAGE_SIZE)
    }
    this.kernelIvt = KERNEL_TEXT_BASE + built.symbols.ivt
    return true
  }

  private startIdle(): boolean {
    const built = assemble(GUEST_IDLE_SOURCE)
    if (built.errors.length) {
      for (const e of built.errors) this.log(`idle asm: ${e}`)
      return false
    }
    const exe = loadExe(String.fromCharCode(...built.bytes))
    if (!exe) return false
    return !('err' in this.exec(null, 'idle', '[idle]', [], { entry: exe.entry }, exe.image))
  }

  // init 必须从 ROM 以 CRX 映像启动；不存在函数回退
  private startInit(): string {
    const node = this.vfs.resolve('/bin/init', '/')
    if (!('err' in node)) {
      const image = this.vfs.fsOf(node).readBytes(node.ino)
      const exe = loadExe(String.fromCharCode(...image))
      if (exe) {
        const r = this.exec(null, 'init', '/bin/init', [], { entry: exe.entry }, exe.image)
        if (!('err' in r)) return 'init: pid 1 started from /bin/init as machine code'
      }
    }
    this.setPanic('cannot execute /bin/init: no valid CRX image')
    return 'init: failed to start'
  }

  destroy() {
    if (this.timer) clearInterval(this.timer)
    this.flush(true)
  }

  // 限速模式每个定时器周期推进一拍；不限速模式在时间预算内连续推进，
  // 并抑制中途的快照生成，否则光是渲染就会成为瓶颈
  private startTimer() {
    if (this.timer) clearInterval(this.timer)
    this.nextTimerIrq = performance.now() + 1000 / this.hz
    this.timer = setInterval(
      () => {
        if (this.paused || this.panic) return
        try {
          if (!this.turbo) {
            this.tick()
            return
          }
          const t0 = performance.now()
          this.suppress = true
          do this.tick()
          while (!this.panic && performance.now() - t0 < TURBO_BUDGET_MS)
          this.suppress = false
          this.emit()
        } catch (e) {
          this.suppress = false
          this.setPanic(`host timer failure: ${(e as Error).message}`)
        }
      },
      this.turbo ? 0 : 1000 / this.hz,
    )
  }

  setSpeed(v: number | 'max') {
    this.turbo = v === 'max'
    if (typeof v === 'number') {
      this.hz = v
      this.mem.setU16(0x0024, v)
    }
    this.nextTimerIrq = performance.now() + 1000 / this.hz
    this.startTimer()
    this.emit()
  }
  setPaused(paused: boolean) {
    this.paused = paused
    this.emit()
  }
  step() {
    this.paused = true
    this.tick()
  }
  processes(): Process[] {
    return [...this.procs.values()]
  }
  filesystem(name: string): CRFS | undefined {
    return this.fss.get(name)
  }
  consoleLines(): Line[] {
    return this.lines
  }
  blockDevices(): BlkInfo[] {
    return this.blkInfo()
  }
  fsStats() {
    return this.statfs()
  }
  kmsg(): string[] {
    return this.kmsgLines()
  }
  get runningPid(): number {
    return this.currentPid
  }
  get foregroundPid(): number | null {
    return this.mem.u16(0x002c) || this.fgPid
  }
  get storageReady(): boolean {
    return this.storageOk
  }
  get pendingWriteback(): boolean {
    return this.dirty
  }
  // ---------- 调度 ----------

  private tick() {
    if (this.panic) return
    this.ticks++

    // MAX 只增加 CPU cycle 吞吐。硬件 timer IRQ 由真实单调时间驱动，始终
    // 保持 hz 频率；sleep 和抢占因此不会随 MAX 加速。
    const nowMs = performance.now()
    const timerDue = this.turbo || nowMs >= this.nextTimerIrq
    if (!this.turbo && timerDue) {
      const period = 1000 / this.hz
      do this.nextTimerIrq += period
      while (this.nextTimerIrq <= nowMs)
    }

    for (const process of this.procs.values()) {
      if (process.state !== 'blocked' || process.sleepMode !== 2 || nowMs < process.wakeAt) continue
      process.sleepMode = 0
      process.wakeAt = 0
      process.state = 'ready'
    }

    let timerPending = timerDue
    const slices = this.turbo ? 1 : SLICES_PER_PUMP
    for (let slice = 0; slice < slices && !this.panic; slice++) {
      const kCurrentPid = this.mem.u16(0x0020)
      if (kCurrentPid !== this.currentPid && this.procs.has(kCurrentPid)) {
        const selected = this.procs.get(kCurrentPid)!
        this.currentPid = kCurrentPid
        for (const p of this.procs.values()) {
          if (p !== selected && p.state === 'running') p.state = 'ready'
        }
        if (selected.state === 'ready') selected.state = 'running'
      }

      let cur = this.procs.get(this.currentPid) ?? null
      if (!cur || cur.state !== 'running') {
        const next = this.pick()
        if (next) {
          for (const p of this.procs.values()) {
            if (p !== next && p.state === 'running') p.state = 'ready'
          }
          if (next !== cur) this.mem.setU16(0x0026, this.mem.u16(0x0026) + 1)
          next.state = 'running'
          this.currentPid = next.pid
          this.mem.setU16(0x0020, next.pid)
          this.mem.setU16(0x0022, next.slot)
          cur = next
        }
      }

      if (!cur || cur.state !== 'running') break
      if (cur.cpu && cur.cpu.pendingIrq === NO_IRQ) {
        if (this.ttyIrqPending) {
          cur.cpu.pendingIrq = VECTOR_TTY
          this.ttyIrqPending = false
        } else if (timerPending) {
          cur.cpu.pendingIrq = VECTOR_TIMER
          timerPending = false
        }
      }

      let r: IteratorResult<Syscall, unknown>
      try {
        r = cur.gen.next(cur.pending)
      } catch (e) {
        const msg = e instanceof Fault ? e.message : (e as Error).message
        this.log(`trap: pid ${cur.pid} (${cur.name}) ${msg}`)
        if (cur.pid <= 1) {
          this.setPanic(`critical process ${cur.pid} (${cur.name}) fault: ${msg}`)
          return
        }
        this.doExit(cur, 139)
        continue
      }
      cur.pending = undefined
      this.fgPid = this.mem.u16(0x002c) || this.fgPid
      if (r.done) {
        if (cur.pid <= 1) {
          this.setPanic(`critical process ${cur.pid} (${cur.name}) returned unexpectedly`)
          return
        }
        this.doExit(cur, 0)
      } else {
        this.dispatch(cur, r.value)
      }
    }

    if (this.dirty && Date.now() - this.lastSyncMs >= AUTOSYNC_MS) this.flush(false)
    this.emit()
  }

  private pick(): Process | null {
    const ids = [...this.procs.keys()].filter((id) => id !== 0).sort((a, b) => a - b)
    const ready = ids.filter((id) => this.procs.get(id)!.state === 'ready')
    if (ready.length) {
      const idx = ready.findIndex((id) => id > this.lastPicked)
      const pid = idx >= 0 ? ready[idx] : ready[0]
      this.lastPicked = pid
      return this.procs.get(pid)!
    }
    const idle = this.procs.get(0)
    if (idle) idle.state = 'ready'
    return idle ?? null
  }

  // ---------- 进程与加载器 ----------

  private makeBus(p: Process): Bus {
    const mem = this.mem
    const translate = (va: number, forceUser = false): number => {
      const vpn = va >>> 8
      const pte = p.pteAt(vpn)
      if (va < 0) throw new Fault(va, 'page fault')

      // Kernel instructions use a physical direct map. The sole exception is
      // the per-process supervisor stack at VPN 15. Access to user virtual
      // memory must use ULDB/USTB (forceUser=true), never an ordinary load.
      if (!forceUser && p.cpu?.mode === 'kernel') {
        if (pte?.supervisor) return pte.pfn * PAGE_SIZE + (va & 0xff)
        if (va < RAM_SIZE) return va
        throw new Fault(va, 'kernel address fault')
      }

      if (pte !== null) {
        if (pte.supervisor) throw new Fault(va, 'supervisor page fault')
        return pte.pfn * PAGE_SIZE + (va & 0xff)
      }
      throw new Fault(va, 'page fault')
    }
    const readMem = (va: number, forceUser = false) => mem.bytes[translate(va, forceUser)]
    const writeMem = (va: number, b: number, forceUser = false) => {
      mem.bytes[translate(va, forceUser)] = b & 0xff
    }
    const reg16 = (off: number) => (this.blockRegs[off] << 8) | this.blockRegs[off + 1]
    const setReg16 = (off: number, value: number) => {
      this.blockRegs[off] = (value >> 8) & 0xff
      this.blockRegs[off + 1] = value & 0xff
    }
    const loadInputPacket = () => {
      if (this.inputPacket !== undefined || !this.lineQueue.length) return
      const line = this.lineQueue.shift()
      this.inputPacket = line === null || line === undefined ? null : UTF8_ENCODER.encode(line)
      this.inputOffset = 0
    }
    const ttyStatus = () => {
      loadInputPacket()
      if (this.inputPacket === undefined) return 0
      if (this.inputPacket === null) return 2
      return this.inputPacket.length === 0 ? 3 : 1
    }
    const ttyData = () => {
      loadInputPacket()
      if (this.inputPacket === undefined) return 0
      if (this.inputPacket === null || this.inputPacket.length === 0) {
        this.inputPacket = undefined
        this.inputOffset = 0
        return 0
      }
      const value = this.inputPacket[this.inputOffset++]
      if (this.inputOffset >= this.inputPacket.length) {
        this.inputPacket = undefined
        this.inputOffset = 0
      }
      return value
    }
    const runBlockCommand = () => {
      const command = reg16(0)
      if (command === 3) {
        let ok = true
        if (this.persist) {
          for (const [name, disk] of this.devs) {
            if (name === 'rom') continue
            ok = saveDev(disk) && ok
          }
        }
        this.storageOk = ok
        this.dirty = false
        this.lastSyncMs = Date.now()
        setReg16(8, ok ? 1 : 0xffff)
        return
      }
      const name = deviceName(reg16(2))
      const dev = name ? this.devs.get(name) : undefined
      const block = reg16(4)
      const buffer = reg16(6)
      // 命令 1/2 是用户态 block_read/block_write。找不到进程时拒绝，不能当成 root。
      if ((command === 1 || command === 2) && this.euidOf(this.currentPid) !== UID_ROOT) {
        setReg16(8, 0xffff)
        return
      }
      // 命令 4/5/6 只服务内核自己的暂存页。用户可控的缓冲区不能从这里写进物理内存。
      if ((command === 4 || command === 5 || command === 6) && buffer !== 0x0d00) {
        setReg16(8, 0xffff)
        return
      }
      // 命令 6：按 256 B 扇区读到内核物理缓冲区。块大小不同的设备（ROM 是 1 KiB）
      // 也能逐扇区读进内核那一页暂存区；怎么解析这些字节由 CRX 内核决定。
      if (command === 6) {
        const at = block * SECTOR_SIZE
        if (!dev || at + SECTOR_SIZE > dev.size) {
          setReg16(8, 0xffff)
          return
        }
        for (let i = 0; i < SECTOR_SIZE; i++) writeMem(buffer + i, dev.bytes[at + i], false)
        setReg16(8, 1)
        return
      }
      if (!dev || block >= dev.blockCount) {
        setReg16(8, 0xffff)
        return
      }
      try {
        const bytes = dev.block(block)
        // 命令 4 是内核读，ROM 可以读。用户态块读写和内核写都不能改固件。
        if ((command === 1 || command === 2 || command === 5) && name === 'rom') {
          setReg16(8, 0xffff)
          return
        }
        if (command === 1 || command === 4) {
          const forceUser = command === 1
          for (let i = 0; i < bytes.length; i++) writeMem(buffer + i, bytes[i], forceUser)
        } else if (command === 2 || command === 5) {
          const forceUser = command === 2
          for (let i = 0; i < bytes.length; i++) bytes[i] = readMem(buffer + i, forceUser)
          this.dirty = true
        } else {
          setReg16(8, 0xffff)
          return
        }
        setReg16(8, 1)
      } catch {
        setReg16(8, 0xffff)
      }
    }
    return {
      get limit() {
        return p.cpu?.mode === 'kernel' ? RAM_SIZE : p.addressLimit
      },
      read: (va) => {
        if (p.cpu?.mode === 'kernel' && va === MMIO_TTY_STATUS) return ttyStatus()
        if (p.cpu?.mode === 'kernel' && va === MMIO_TTY_DATA) return ttyData()
        if (p.cpu?.mode === 'kernel' && va >= MMIO_BLOCK && va < MMIO_BLOCK + this.blockRegs.length) {
          return this.blockRegs[va - MMIO_BLOCK]
        }
        if (p.cpu?.mode === 'kernel' && va >= 0xff00) return 0
        return readMem(va)
      },
      readUser: (va) => readMem(va, true),
      writeUser: (va, b) => writeMem(va, b, true),
      write: (va, b) => {
        if (p.cpu?.mode === 'kernel' && va >= MMIO_BLOCK && va < MMIO_BLOCK + this.blockRegs.length) {
          const off = va - MMIO_BLOCK
          this.blockRegs[off] = b & 0xff
          if (off === 1) runBlockCommand()
          return
        }
        if (p.cpu?.mode === 'kernel' && va >= 0xff00) {
          this.mmioWrite(va, b)
          return
        }
        writeMem(va, b)
      },
    }
  }

  // TypeScript only supplies the virtual UART hardware. It does not inspect
  // syscalls or file descriptors; those decisions are made by CRX kernel code.
  private mmioWrite(port: number, byte: number) {
    const raw = Uint8Array.of(byte & 0xff)
    if (port === MMIO_TTY_OUT) {
      this.conWrite(this.ttyDecoders.out.decode(raw, { stream: true }), 'out')
    } else if (port === MMIO_TTY_ERR) {
      this.conWrite(this.ttyDecoders.err.decode(raw, { stream: true }), 'err')
    }
  }

  private freeSlot(): number {
    for (let s = 0; s < MAX_PROCS; s++) {
      if (![...this.procs.values()].some((p) => p.slot === s)) return s
    }
    return -1
  }

  // 父子关系不再用 JS 数组维护：扫描 PCB 表里的 ppid 字段即可得出
  private childrenOf(pid: number): Process[] {
    return [...this.procs.values()].filter((c) => c.ppid === pid && c.pid !== pid)
  }

  private exec(
    parent: Process | null,
    name: string,
    cmd: string,
    args: string[],
    spec: ExecSpec,
    image: Uint8Array,
    setuid?: number,
  ): Process | Err {
    const slot = this.freeSlot()
    if (slot < 0) return { err: 'EAGAIN' }
    const pid = this.nextPid++
    const codePages = Math.max(1, Math.ceil(image.length / PAGE_SIZE))
    if (codePages + 1 > KERNEL_STACK_VPN) return { err: 'EFBIG' }
    // Dynamic pages are allocated explicitly with page_alloc.
    const pfns = this.mem.alloc(codePages + 2)
    if (!pfns) return { err: 'ENOMEM' }

    // 加载：磁盘映像逐页拷贝进物理帧，此后 CPU 只面向内存
    this.mem.writeBytesPages(pfns.slice(0, codePages), image)
    const stackVpn = codePages
    const stackFrame = pfns[stackVpn]
    const kernelStackFrame = pfns[codePages + 1]
    // argv 区位于栈页起始处：argc 在 r1，argv 基地址在 r2，字符串以 NUL 分隔
    const argvText = args.length ? args.join('\0') + '\0' : ''
    this.mem.writeAt(stackFrame * PAGE_SIZE, argvText)

    const env = parent ? { ...parent.env } : { USER: 'root', HOME: '/', PATH: '/bin:/usr/bin', SHELL: '/bin/sh' }
    const p = new Process(this.mem, slot, unloadedGen(), env, this.vfsHooks)
    p.init(pid, parent ? parent.pid : 0, name, cmd, parent ? parent.cwd : '/')
    if (parent) {
      p.uid = parent.uid
      p.euid = parent.euid
      p.gid = parent.gid
      p.egid = parent.egid
    }
    if (setuid !== undefined) p.euid = setuid
    p.pageTable = [
      ...pfns.slice(0, codePages + 1).map((pfn, vpn) => ({ vpn, pfn })),
      { vpn: KERNEL_STACK_VPN, pfn: kernelStackFrame, supervisor: true },
    ]
    const cpu = p.createCpuState()
    p.cpu = cpu
    cpu.pc = spec.entry
    cpu.sp = (stackVpn + 1) * PAGE_SIZE - 2
    cpu.flag = 0
    cpu.halted = false
    cpu.mode = 'user'
    cpu.irqEnabled = true
    cpu.pendingIrq = NO_IRQ
    cpu.cause = 0
    cpu.ivtBase = this.kernelIvt
    cpu.ksp = (KERNEL_STACK_VPN + 1) * PAGE_SIZE - 2
    cpu.usp = cpu.sp
    cpu.regs[1] = args.length
    cpu.regs[2] = stackVpn * PAGE_SIZE
    p.gen = runExe(cpu, this.makeBus(p), (count) => {
      this.instructions += count
    })
    p.regs.sp = p.cpu ? p.cpu.sp : stackFrame * PAGE_SIZE + PAGE_SIZE - 1

    if (parent) {
      for (const fd of [0, 1, 2]) {
        const e = parent.fds.get(fd)
        if (e) p.fds.set(fd, e)
      }
    } else {
      p.fds.set(0, { kind: 'stdin' })
      p.fds.set(1, { kind: 'stdout', id: 1 })
      p.fds.set(2, { kind: 'stdout', id: 2 })
    }
    p.state = 'ready'
    this.procs.set(pid, p)
    this.writeKernelTables()
    return p
  }

  // Frame 0 is the KCB; frames 1..12 hold PCBs.
  private writeKernelTables() {
    const banner = 'crados 3.0\n'
    for (let i = 0; i < 32; i++) {
      this.mem.bytes[i] = i < banner.length ? banner.charCodeAt(i) : 0
    }
    this.mem.setU16(0x0024, this.hz)
    this.mem.setU16(0x0030, this.kernelIvt)
    this.mem.setU16(0x0032, this.procs.size)
    // 64 KiB 放不进 u16，这里记最后一个可寻址字节。mem 命令用的是真实字节数。
    this.mem.setU16(0x0034, RAM_SIZE > 0xffff ? 0xffff : RAM_SIZE)
    this.mem.setU16(0x0036, PAGE_SIZE)
    this.mem.setU16(0x0038, PCB_BASE)
    this.mem.setU16(0x003a, PCB_SIZE)
    this.mem.setU16(0x003c, QUANTUM)
    this.mem.setU16(0x003e, USER_FRAME_START) // first allocatable user PFN
    this.mem.setU16(0x001e, KERNEL_TEXT_FRAME) // page_scan 的上界，标语区用不到这一字
    this.writeMountTable()
    this.publishDevinfo()
  }

  // 把 VFS 挂载关系写成 CRX 内核能读的表：每项是宿主设备、挂载点在宿主上的
  // inode、被挂设备、被挂设备每块的扇区数。TypeScript 只登记，不替内核走路径。
  private writeMountTable() {
    this.mem.bytes.fill(0, KCB_MOUNTS, KCB_MOUNTS + KCB_MOUNT_SLOTS * 4)
    let slot = 0
    for (const m of this.vfs.mounts) {
      if (m.path === '/' || slot >= KCB_MOUNT_SLOTS) continue
      const host = this.vfs.mounts
        .filter((h) => h !== m && (h.path === '/' || m.path.startsWith(h.path + '/')))
        .sort((a, b) => b.path.length - a.path.length)[0]
      if (!host) continue
      let ino = 1
      for (const seg of m.path.slice(host.path === '/' ? 0 : host.path.length).split('/').filter(Boolean)) {
        ino = host.fs.lookup(ino, seg) ?? 0
        if (!ino) break
      }
      if (!ino) continue
      const at = KCB_MOUNTS + slot++ * 4
      this.mem.bytes[at] = deviceCode(host.fs.dev.spec.name)
      this.mem.bytes[at + 1] = ino
      this.mem.bytes[at + 2] = deviceCode(m.fs.dev.spec.name)
      this.mem.bytes[at + 3] = m.fs.dev.blockSize / SECTOR_SIZE
    }
  }

  private doExit(p: Process, code: number) {
    if (p.pid <= 1) {
      this.setPanic(`critical process ${p.pid} (${p.name}) attempted to exit with status ${code}`)
      return
    }
    p.state = 'zombie'
    p.exitCode = code
    p.sleeping = false
    p.wakeAt = 0
    p.readStdin = false
    p.waitFor = null
    this.mem.freeFrames(p.pageTable.map((pte) => pte.pfn))
    p.pageTable = []
    p.fds.clear()
    this.writeKernelTables()
    this.log(`sched: pid ${p.pid} (${p.name}) exited with status ${code}, memory reclaimed`)

    for (const child of this.childrenOf(p.pid)) child.ppid = 1 // 孤儿过继给 init
    this.tryReap(p)
  }

  // CRX wait scans the zombie PCB itself. Waking the parent is the only host step;
  // releasing the slot is svc 41, after the guest has copied pid and status.
  private tryReap(child: Process) {
    const parent = this.procs.get(child.ppid)
    if (parent && parent.state === 'blocked' && (parent.waitFor === -1 || parent.waitFor === child.pid)) {
      parent.state = 'ready'
    }
  }

  // svc 40: the guest already resolved the path, checked permission, and filled
  // the request. The host only loads the authorized image and attaches a CPU.
  private hwExec(parent: Process, at: number): number | Err {
    const b = this.mem.bytes
    const dev = b[at] ?? 0
    const ino = b[at + 1] ?? 0
    const uid = this.mem.u16(at + 2)
    const euid = this.mem.u16(at + 4)
    const argc = this.mem.u16(at + 6)
    let name = ''
    for (let i = 0; i < 16 && b[at + 8 + i]; i++) name += String.fromCharCode(b[at + 8 + i])
    const args: string[] = []
    let cursor = at + 24
    const argEnd = at + 184
    for (let i = 0; i < argc && cursor < argEnd; i++) {
      let s = ''
      while (cursor < argEnd && b[cursor]) s += String.fromCharCode(b[cursor++])
      cursor++
      args.push(s)
    }
    const envLen = Math.min(80, this.mem.u16(at + 184))
    const envBytes = b.slice(at + 186, at + 186 + envLen)
    const cwdDev = b[at + 266] ?? 0
    const cwdIno = b[at + 267] ?? 0
    const flags = b[at + 268] ?? 0
    const fs = this.fss.get(deviceName(dev))
    if (!fs || !fs.inodeUsed(ino)) return { err: 'ENOENT' }
    const exe = loadExe(String.fromCharCode(...fs.readBytes(ino)))
    if (!exe) return { err: 'ENOEXEC' }
    const cmd = `${name} ${args.join(' ')}`.trim()
    const created = this.exec(parent, name || '?', cmd, args, { entry: exe.entry }, exe.image)
    if ('err' in created) return created
    created.uid = uid
    created.euid = euid
    if (cwdDev) {
      this.mem.bytes[created.base + 22] = cwdDev
      this.mem.bytes[created.base + 23] = cwdIno
    }
    const argvLen = args.length ? args.join('\0').length + 1 : 0
    if (envBytes.length && argvLen + envBytes.length <= PAGE_SIZE) {
      const stackVpn = Math.max(1, Math.ceil(exe.image.length / PAGE_SIZE))
      const stack = created.pageTable.find((pte) => pte.vpn === stackVpn)
      if (stack) {
        this.mem.bytes.set(envBytes, stack.pfn * PAGE_SIZE + argvLen)
        this.mem.setU16(created.base + 10, stackVpn * PAGE_SIZE + argvLen)
        for (const key of Object.keys(created.env)) delete created.env[key]
        let i = 0
        while (i < envBytes.length) {
          let keyEnd = i
          while (keyEnd < envBytes.length && envBytes[keyEnd]) keyEnd++
          if (keyEnd === i || keyEnd >= envBytes.length) break
          let valEnd = keyEnd + 1
          while (valEnd < envBytes.length && envBytes[valEnd]) valEnd++
          created.env[String.fromCharCode(...envBytes.subarray(i, keyEnd))] = String.fromCharCode(
            ...envBytes.subarray(keyEnd + 1, valEnd),
          )
          i = valEnd + 1
        }
      }
    }
    if (flags & 1) {
      created.gid = created.uid
      created.egid = created.uid
      this.shellPid = created.pid
      this.fgPid = created.pid
      this.mem.setU16(0x002c, created.pid)
    }
    this.log(`sched: pid ${created.pid} (${name}) forked from pid ${parent.pid}, ${created.pageTable.length} pages`)
    return created.pid
  }

  // svc 41: drop the JS process object. The guest already cleared the PCB.
  private hwReap(pid: number): number {
    const child = this.procs.get(pid)
    if (!child) return 0
    child.release()
    this.procs.delete(pid)
    return 0
  }

  // svc 42: the guest mount table is authoritative. Rebuild the JS mirror from it.
  private hwMount(): number {
    const wanted = new Map<string, string>()
    for (let i = 0; i < KCB_MOUNT_SLOTS; i++) {
      const at = KCB_MOUNTS + i * 4
      const hostDev = this.mem.bytes[at]
      const hostIno = this.mem.bytes[at + 1]
      const dev = this.mem.bytes[at + 2]
      if (!dev) continue
      const name = deviceName(dev)
      if (!name || !this.fss.has(name)) continue
      const path = this.vfsHooks.pathOf(hostDev, hostIno)
      if (!path || path === '/') continue
      wanted.set(name, path)
    }
    for (const m of [...this.vfs.mounts]) {
      if (m.path === '/') continue
      const name = m.fs.dev.spec.name
      if (wanted.get(name) === m.path) continue
      this.vfs.umount(m.path)
      this.mounts.delete(name)
      const disk = this.devs.get(name)
      if (disk && name !== 'rom' && this.persist) saveDev(disk)
    }
    for (const [name, path] of wanted) {
      if (this.vfs.mounts.some((m) => m.fs.dev.spec.name === name && m.path === path)) {
        this.mounts.set(name, path)
        continue
      }
      const fs = this.fss.get(name)
      if (!fs) continue
      this.ensureCreds(name)
      this.vfs.mount(path, fs)
      this.mounts.set(name, path)
      this.log(`${name}: mounted on ${path}, label "${fs.label()}"`)
    }
    this.writeMountTable()
    return 0
  }

  // svc 44: encode one file the guest already authorized. No path walk.
  private hwAssemble(srcDev: number, srcIno: number, dstDev: number, dstIno: number): 0 | Err {
    const src = this.fss.get(deviceName(srcDev))
    const dst = this.fss.get(deviceName(dstDev))
    if (!src || !dst || deviceName(dstDev) === 'rom') return { err: 'ENOENT' }
    const built = assemble(src.read(srcIno))
    if (built.errors.length) {
      this.log(`as: ${built.errors[0]}`)
      return { err: 'EINVAL' }
    }
    const wr = dst.writeBytes(dstIno, built.bytes)
    if (isErr(wr)) return wr
    dst.setExec(dstIno, true)
    this.dirty = true
    return 0
  }

  private killSig(p: Process, sig: number) {
    if (p.pid <= 1) {
      this.setPanic('Attempted to kill init')
      return
    }
    const name = sig === 2 ? 'SIGINT' : sig === 9 ? 'SIGKILL' : sig === 15 ? 'SIGTERM' : `signal ${sig}`
    this.log(`signal: pid ${p.pid} (${p.name}) terminated by ${name}`)
    this.doExit(p, 128 + sig)
  }

  private setPanic(msg: string) {
    this.panic = msg
    this.log(`Kernel panic - not syncing: ${msg}`, true)
    this.flush(true)
    this.emit()
  }

  // ---------- 凭证 ----------

  private euidOf(pid: number): number | null {
    return this.procs.get(pid)?.euid ?? null
  }

  // 旧盘没有 uid 表时补一次。已标记的盘不动，避免把用户文件改回 root。
  private ensureCreds(name: string) {
    const fs = this.fss.get(name)
    if (!fs || !fs.valid() || fs.credsReady()) return
    fs.seedModes()
    applyLoginPolicy(fs)
    fs.markCreds()
    this.dirty = true
    this.log(`${name}: credential table written, login uid ${UID_USER}`)
  }

  // ---------- 设备与持久化 ----------

  private fsOf(name: string): CRFS {
    return this.fss.get(name)!
  }

  private flush(quiet: boolean): number {
    let blocks = 0
    let ok = true
    for (const name of this.devs.keys()) {
      if (name === 'rom') continue // ROM 每次上电重新烧写，无需回写
      const fs = this.fsOf(name)
      blocks += fs.usedBlocks()
      ok = (this.persist ? saveDev(this.devs.get(name)!) : false) && ok
    }
    this.storageOk = ok
    this.dirty = false
    this.lastSyncMs = Date.now()
    if (!quiet) this.log(`sync: ${blocks} block(s) written to persistent store`)
    return blocks
  }

  private blkInfo(): BlkInfo[] {
    return [...this.devs.keys()].map((name) => {
      const dev = this.devs.get(name)!
      const fs = this.fsOf(name)
      const used = fs.valid() ? fs.usedBlocks() : 0
      const mount = name === 'sda' ? '/' : name === 'rom' ? '/bin' : (this.mounts.get(name) ?? null)
      return {
        name,
        model: dev.spec.model,
        size: dev.size,
        used: used * dev.blockSize,
        blocks: dev.blockCount,
        usedBlocks: used,
        blockSize: dev.blockSize,
        removable: dev.spec.removable,
        present: true,
        mountpoint: mount,
        persistent: this.storageOk,
      }
    })
  }

  // ---------- UI 存储操作 ----------

  // 新建空盘：分配下一个可用的 sdX
  attachDisk(label = 'disk'): Err | 0 {
    const name = nextDiskName(this.devs.keys())
    if (!name) return { err: 'ENOSPC' }
    const dev = this.makeDev(name, diskSpec(name))
    this.fsOf(name).format(label)
    if (this.persist) {
      saveDev(dev)
      rememberDisk(name)
    }
    this.log(`${name}: attached, mkfs done, label "${label}"`)
    this.emit()
    return 0
  }

  detachDisk(name: string): Err | 0 {
    const dev = this.devs.get(name)
    if (!dev || name === 'sda' || name === 'rom') return { err: 'ENODEV' }
    if (this.mounts.has(name)) return { err: 'EBUSY' }
    this.devs.delete(name)
    this.fss.delete(name)
    dropDev(name)
    this.log(`${name}: detached`)
    this.emit()
    return 0
  }

  // 导出整盘字节。sda 导出的 .img 与首次上电写入的根盘镜像同构。
  exportDisk(name: string): Err | 0 {
    const dev = this.devs.get(name)
    if (!dev) return { err: 'ENODEV' }
    downloadDev(dev, `${name}.img`)
    this.log(`${name}: raw image of ${dev.size} bytes written to host`)
    this.emit()
    return 0
  }

  // 导入镜像：每次都占用一个新的 sdX，不覆盖已有设备
  importDisk(raw: Uint8Array, filename: string): Err | 0 {
    const name = nextDiskName(this.devs.keys())
    if (!name) return { err: 'ENOSPC' }
    const spec = diskSpec(name)
    if (raw.length > spec.blockSize * spec.blockCount) return { err: 'ENOSPC' }
    const dev = this.makeDev(name, spec)
    dev.load(raw)
    if (!this.fsOf(name).valid()) {
      this.devs.delete(name)
      this.fss.delete(name)
      return { err: 'EINVAL' }
    }
    this.ensureCreds(name)
    if (this.persist) {
      saveDev(dev)
      rememberDisk(name)
    }
    const fs = this.fsOf(name)
    this.log(`${name}: image ${filename} loaded, ${fs.usedInodes()} inodes, label "${fs.label()}"`)
    this.emit()
    return 0
  }

  formatDisk(name: string): Err | 0 {
    const dev = this.devs.get(name)
    if (!dev || name === 'sda' || name === 'rom') return { err: 'ENODEV' }
    if (this.mounts.has(name)) return { err: 'EBUSY' }
    const fs = this.fsOf(name)
    fs.format(fs.label() || name)
    if (this.persist) saveDev(dev)
    this.log(`${name}: mkfs complete, all data blocks free`)
    this.emit()
    return 0
  }

  wipeRoot() {
    this.persist = false
    this.storageOk = false
    for (const name of this.devs.keys()) {
      if (name !== 'rom') dropDev(name)
    }
    this.log('sda: persistent store cleared, writes are volatile until reboot')
    this.emit()
  }

  // ---------- 系统调用 ----------

  private dispatch(p: Process, sc: Syscall) {
    if (sc.call === 'yield') return
    let result: unknown = 0

    switch (sc.call) {
      case 'exit':
        this.observer?.syscall?.(this.ticks, p.pid, p.name, sc, undefined, false)
        this.doExit(p, sc.code)
        return
      case 'kill': {
        const t = this.procs.get(sc.pid)
        if (!t) result = { err: 'ESRCH' }
        else {
          this.killSig(t, sc.sig)
          result = 0
        }
        break
      }
      case 'hwexec':
        result = this.hwExec(p, sc.at)
        break
      case 'hwreap':
        result = this.hwReap(sc.pid)
        break
      case 'hwmount':
        result = this.hwMount()
        break
      case 'hwassemble':
        result = this.hwAssemble(sc.srcDev, sc.srcIno, sc.dstDev, sc.dstIno)
        break
      case 'hwdisasm':
        result = this.hwDisasm(p, sc.at)
        break
    }

    if (typeof result === 'number') p.regs.ax = result
    this.observer?.syscall?.(this.ticks, p.pid, p.name, sc, result, false)
    p.pending = result
  }

  // svc 45: disassemble one inode the guest already authorized. No path walk.
  private hwDisasm(p: Process, at: number): number | Err {
    const dev = this.mem.bytes[at] ?? 0
    const ino = this.mem.bytes[at + 1] ?? 0
    const buf = this.mem.u16(at + 2)
    const pathVa = this.mem.u16(at + 4)
    const fs = this.fss.get(deviceName(dev))
    if (!fs || !fs.inodeUsed(ino) || fs.itype(ino) !== T_FILE) return { err: 'ENOENT' }
    const exe = loadExe(String.fromCharCode(...fs.readBytes(ino)))
    if (!exe) return { err: 'ENOEXEC' }
    const bus = this.makeBus(p)
    let arg = ''
    for (let i = 0; i < 64; i++) {
      const c = bus.readUser(pathVa + i)
      if (!c) break
      arg += String.fromCharCode(c)
    }
    const text = clip(
      `${arg}: CRX executable, text ${exe.textLen} B, data ${exe.dataLen} B, entry ${hexAddr(exe.entry)}\n\n` +
        disassemble(exe.image, exe.textLen, 80).join('\n') +
        '\n',
      1190,
    )
    const bytes = UTF8_ENCODER.encode(text)
    const n = Math.min(bytes.length, 1190)
    for (let i = 0; i < n; i++) bus.writeUser(buf + i, bytes[i])
    return n
  }

  private statfs() {
    const fs = this.fsOf('sda')
    return { max: fs.inodeCount, used: fs.usedInodes(), bytes: fs.usedBlocks() * fs.dev.blockSize }
  }

  // ---------- 终端 ----------

  typeChar(ch: string) {
    if (this.panic) return
    // canonical tty 只接收可打印字符；Ctrl-C/D/L 由对应的行规入口处理。
    // 这样宿主浏览器产生的 DC1..DC4 等控制字节不会污染 argv 或文件。
    if (!ch || (ch.charCodeAt(0) < 0x20 && ch !== '\t')) return
    if (this.lineBuf.length < 256) this.lineBuf += ch
    this.conWrite(ch, 'echo')
    this.emit()
  }

  pressEnter() {
    if (this.panic) return
    this.lineQueue.push(this.lineBuf)
    this.lineBuf = ''
    this.conWrite('\n', 'echo')
    this.ttyIrqPending = true
    this.emit()
  }

  pressBackspace() {
    if (this.panic || !this.lineBuf) return
    this.lineBuf = this.lineBuf.slice(0, -1)
    const line = this.lines[this.lines.length - 1]
    const seg = line?.segs[line.segs.length - 1]
    if (seg) {
      seg.t = seg.t.slice(0, -1)
      if (!seg.t) line.segs.pop()
    }
    this.emit()
  }

  pressCtrlD() {
    if (this.panic) return
    if (this.lineBuf) {
      this.lineQueue.push(this.lineBuf)
      this.lineBuf = ''
    }
    this.lineQueue.push(null)
    this.conWrite('\n', 'echo')
    this.ttyIrqPending = true
    this.emit()
  }

  pressCtrlC() {
    if (this.panic) return
    this.conWrite('^C\n', 'err')
    this.lineBuf = ''
    const fgPid = this.foregroundPid
    const fg = fgPid !== null ? this.procs.get(fgPid) : undefined
    const shell = this.procs.get(this.shellPid)
    // 前台组可以被改写。键盘信号不能因此打到 init，也不能打到 shell 无权发信号的进程。
    const allowed =
      fg !== undefined &&
      shell !== undefined &&
      fg.pid > 1 &&
      fg.pid !== this.shellPid &&
      fg.state !== 'zombie' &&
      (shell.euid === UID_ROOT || fg.euid === shell.euid || fg.uid === shell.euid)
    if (allowed) this.killSig(fg, 2)
    else {
      this.lineQueue.push('')
      this.ttyIrqPending = true
    }
    this.emit()
  }

  pressCtrlL() {
    this.lines = []
    this.emit()
  }

  private conWrite(text: string, cls: SegClass) {
    let rest = text
    while (rest.includes('\x1b[2J')) {
      const i = rest.indexOf('\x1b[2J')
      if (i > 0) this.conWriteRaw(rest.slice(0, i), cls)
      this.lines = []
      rest = rest.slice(i + 4)
    }
    if (rest) this.conWriteRaw(rest, cls)
  }

  private conWriteRaw(text: string, cls: SegClass) {
    const parts = text.split('\n')
    this.append(parts[0], cls)
    for (let i = 1; i < parts.length; i++) {
      this.lines.push({ segs: parts[i] ? [{ t: parts[i], c: cls }] : [] })
      if (this.lines.length > 600) this.lines.shift()
    }
  }

  private append(s: string, cls: SegClass) {
    if (!s) {
      if (!this.lines.length) this.lines.push({ segs: [] })
      return
    }
    if (!this.lines.length) this.lines.push({ segs: [] })
    const line = this.lines[this.lines.length - 1]
    const last = line.segs[line.segs.length - 1]
    if (last && last.c === cls) last.t += s
    else line.segs.push({ t: s, c: cls })
  }

  private log(msg: string, toConsole = false) {
    this.klog.push({ tick: this.ticks, msg })
    if (this.klog.length > 400) this.klog.shift()
    const line = `[${(this.ticks / this.hz).toFixed(4).padStart(9)}] ${msg}\n`
    this.appendKmsg(line)
    if (toConsole) this.conWrite(line, 'sys')
  }

  // The guest prints dmesg from this buffer. The host only records events.
  private appendKmsg(text: string) {
    const base = KMSG_BASE
    const max = KMSG_SIZE - 2
    const extra = UTF8_ENCODER.encode(text)
    let len = this.mem.u16(base)
    if (len > max) len = 0
    while (len + extra.length > max && len > 0) {
      let i = 0
      while (i < len && this.mem.bytes[base + 2 + i] !== 10) i++
      const cut = i < len ? i + 1 : len
      this.mem.bytes.copyWithin(base + 2, base + 2 + cut, base + 2 + len)
      len -= cut
    }
    const n = Math.min(extra.length, Math.max(0, max - len))
    if (n > 0) this.mem.bytes.set(extra.subarray(0, n), base + 2 + len)
    this.mem.setU16(base, len + n)
  }

  // Hardware facts for lsblk/df. CRX formats the text; this only fills the table.
  // Record: present, removable, name[3], bs_len, model[17], bs[4], size[6],
  // used[6], pct, blocks u16, usedBlocks u16, mount[20].
  private publishDevinfo() {
    for (let pfn = RESERVED_FRAME; pfn < RESERVED_FRAME + RESERVED_FRAMES; pfn++) this.mem.hold(pfn)
    const base = DEVINFO_BASE
    this.mem.bytes.fill(0, base, base + DEVINFO_SLOTS * DEVINFO_STRIDE)
    let slot = 0
    for (const d of this.blkInfo()) {
      if (slot >= DEVINFO_SLOTS) break
      const at = base + slot++ * DEVINFO_STRIDE
      const b = this.mem.bytes
      b[at] = d.present ? 1 : 0
      b[at + 1] = d.removable ? 1 : 0
      for (let i = 0; i < 3; i++) b[at + 2 + i] = d.name.charCodeAt(i) || 0
      const bs = String(d.blockSize)
      b[at + 5] = Math.min(bs.length, 4)
      const model = d.model.padEnd(17).slice(0, 17)
      for (let i = 0; i < 17; i++) b[at + 6 + i] = model.charCodeAt(i)
      for (let i = 0; i < b[at + 5]; i++) b[at + 23 + i] = bs.charCodeAt(i)
      const size = String(d.size).padStart(6).slice(-6)
      const used = String(d.used).padStart(6).slice(-6)
      for (let i = 0; i < 6; i++) {
        b[at + 27 + i] = size.charCodeAt(i)
        b[at + 33 + i] = used.charCodeAt(i)
      }
      b[at + 39] = d.blocks ? Math.round((d.usedBlocks / d.blocks) * 100) : 0
      this.mem.setU16(at + 40, d.blocks)
      this.mem.setU16(at + 42, d.usedBlocks)
      const mount = d.present ? (d.mountpoint ?? '-') : '(no medium)'
      for (let i = 0; i < mount.length && i < 19; i++) b[at + 44 + i] = mount.charCodeAt(i)
    }
  }

  private kmsgLines(): string[] {
    return this.klog.map((e) => `[${(e.tick / this.hz).toFixed(4).padStart(9)}] ${e.msg}`)
  }

  private emit() {
    if (this.suppress) return
    this.observer?.changed()
  }
}
