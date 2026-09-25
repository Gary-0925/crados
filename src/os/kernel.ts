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
import {
  applyLoginPolicy,
  basename,
  CRFS,
  dirname,
  DRV_TTY,
  M_EXEC,
  M_OEXEC,
  M_OREAD,
  M_OWRITE,
  M_READ,
  M_SETUID,
  M_STICKY,
  M_WRITE,
  normalizePath,
  T_DEV,
  T_DIR,
  T_FILE,
  UID_ROOT,
  UID_USER,
  VFS,
} from './fs'
import type { FNode } from './fs'
import {
  FRAME_COUNT,
  KERNEL_TEXT_FRAME,
  KERNEL_TEXT_PAGES,
  Memory,
  PAGE_SIZE,
  RAM_SIZE,
  USER_FRAME_START,
} from './memory'
import { assemble, disassemble, isExecutable, loadExe } from './isa'
import { ASM_PROGRAMS } from './asmsrc'
import { GUEST_IDLE_SOURCE, GUEST_KERNEL_SOURCE } from './guestkernel'
import { Fault, NO_IRQ, runExe, VECTOR_TIMER, VECTOR_TTY } from './vm'
import type { Bus } from './vm'
import { deviceCode, deviceName, MAX_PROCS, PCB_BASE, PCB_SIZE, Process } from './process'
import type { VfsHooks } from './process'
import { buildRootImage } from './rootimg'
import { isErr } from './types'
import type { BlkInfo, Err, Gen, ProcInfo, ReadBytes, Syscall } from './types'

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
const TYPE_NAME: Record<number, 'dir' | 'file' | 'dev'> = { 1: 'file', 2: 'dir', 3: 'dev' }

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
    stamp('crados 2.0 booting on browser/js')
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
    const built = assemble(GUEST_KERNEL_SOURCE)
    if (built.errors.length || built.bytes.length < 16) {
      for (const e of built.errors) this.log(`kernel asm: ${e}`)
      return false
    }
    const image = built.bytes.slice(16)
    // 文本必须停在 MMIO 窗口前面，否则中断向量会被读成 0。
    if (image.length > PAGE_SIZE * KERNEL_TEXT_PAGES || KERNEL_TEXT_BASE + image.length > 0xff00 || built.symbols.ivt === undefined) return false

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
      const dev = this.devs.get(name)
      const block = reg16(4)
      const buffer = reg16(6)
      if (!dev || block >= dev.blockCount) {
        setReg16(8, 0xffff)
        return
      }
      try {
        const bytes = dev.block(block)
        // 命令 2 是用户态 block_write。命令 4/5 是内核自己的 CRFS 搬运，不在这里卡 euid。
        if (command === 2 && this.euidOf(this.currentPid) !== UID_ROOT) {
          setReg16(8, 0xffff)
          return
        }
        if ((command === 2 || command === 5) && name === 'rom') {
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
    // init 拉起的交互 shell 是登录会话，落到 uid 1000。setuid 的 sh 也不例外。
    if (name === 'sh' && !args.length && p.euid === UID_ROOT) {
      p.uid = UID_USER
      p.euid = UID_USER
      p.gid = UID_USER
      p.egid = UID_USER
    }
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
    if (name === 'sh' && !args.length) {
      p.cwd = '/home/user'
      p.env.USER = 'user'
      p.env.HOME = '/home/user'
      this.shellPid = pid
      this.fgPid = pid
    }
    p.state = 'ready'
    this.procs.set(pid, p)
    this.writeKernelTables()
    return p
  }

  // Frame 0 is the KCB; frames 1..12 hold PCBs.
  private writeKernelTables() {
    const banner = 'crados 2.0\n'
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

  private tryReap(child: Process) {
    const parent = this.procs.get(child.ppid)
    if (parent && parent.state === 'blocked' && (parent.waitFor === -1 || parent.waitFor === child.pid)) {
      parent.waitFor = null
      parent.pending = { pid: child.pid, code: child.exitCode ?? 0 }
      parent.state = 'ready'
      this.removeChild(parent, child)
      if (parent.pid === this.shellPid) this.fgPid = parent.pid
    }
  }

  // 回收 PCB：清掉内存里的 inuse 标志，槽位随即可被新进程复用
  private removeChild(_parent: Process, child: Process) {
    child.release()
    this.procs.delete(child.pid)
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

  private euidOf(pid: number): number {
    return this.procs.get(pid)?.euid ?? UID_ROOT
  }

  private isRoot(p: Process): boolean {
    return p.euid === UID_ROOT
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

  private modeAllows(p: Process, fs: CRFS, ino: number, write: boolean): boolean {
    if (write && fs.dev.spec.name === 'rom') return false
    if (this.isRoot(p)) return true
    const mode = fs.iflags(ino)
    const own = p.euid === fs.iowner(ino)
    return write ? (mode & (own ? M_WRITE : M_OWRITE)) !== 0 : (mode & (own ? M_READ : M_OREAD)) !== 0
  }

  private canExec(p: Process, fs: CRFS, ino: number): boolean {
    if (this.isRoot(p)) return true
    const mode = fs.iflags(ino)
    return (mode & (p.euid === fs.iowner(ino) ? M_EXEC : M_OEXEC)) !== 0
  }

  // 沿路径检查每一级目录的搜索权。最后一级只解析，不额外要求权限。
  private walk(p: Process, path: string): FNode | Err {
    const abs = normalizePath(path, p.cwd)
    const parts = abs.split('/').filter(Boolean)
    let cur = '/'
    for (const seg of parts) {
      const dir = this.vfs.resolve(cur, '/')
      if ('err' in dir) return dir
      if (dir.type !== T_DIR) return { err: 'ENOTDIR' }
      if (!this.canExec(p, this.vfs.fsOf(dir), dir.ino)) return { err: 'EACCES' }
      cur = cur === '/' ? `/${seg}` : `${cur}/${seg}`
    }
    return this.vfs.resolve(abs, '/')
  }

  private parentNode(p: Process, path: string): FNode | Err {
    const abs = normalizePath(path, p.cwd)
    const dir = this.walk(p, dirname(abs))
    if ('err' in dir) return dir
    if (dir.type !== T_DIR) return { err: 'ENOTDIR' }
    if (dir.dev.spec.name === 'rom') return { err: 'EROFS' }
    const fs = this.vfs.fsOf(dir)
    if (!this.canExec(p, fs, dir.ino) || !this.modeAllows(p, fs, dir.ino, true)) return { err: 'EACCES' }
    return dir
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

  private sysMount(dev: string, dir: string, cwd: string): Err | 0 {
    const name = basename(dev)
    if (!this.devs.has(name) || name === 'rom') return { err: 'ENODEV' }
    if (this.mounts.has(name)) return { err: 'EBUSY' }
    const target = this.vfs.resolve(dir, cwd)
    if ('err' in target) return { err: target.err }
    if (target.type !== T_DIR) return { err: 'ENOTDIR' }
    const fs = this.fsOf(name)
    if (!fs.valid()) return { err: 'EINVAL' }
    this.ensureCreds(name)
    const abs = normalizePath(dir, cwd)
    if (abs === '/' || [...this.mounts.values()].includes(abs)) return { err: 'EBUSY' }
    this.vfs.mount(abs, fs)
    this.mounts.set(name, abs)
    this.log(`${name}: mounted on ${abs}, label "${fs.label()}", ${fs.usedBlocks()} blocks in use`)
    return 0
  }

  private sysUmount(target: string, cwd: string): Err | 0 {
    const byName = basename(target)
    const abs = this.mounts.has(byName) ? this.mounts.get(byName)! : normalizePath(target, cwd)
    const name = [...this.mounts.entries()].find(([, at]) => at === abs)?.[0]
    if (!name) return { err: 'EINVAL' }
    for (const p of this.procs.values())
      if (p.state !== 'zombie' && p.cwd.startsWith(abs)) return { err: 'EBUSY' }
    this.vfs.umount(abs)
    this.mounts.delete(name)
    if (this.persist) saveDev(this.devs.get(name)!)
    this.log(`${name}: unmounted from ${abs}`)
    return 0
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
    let blocked = false

    switch (sc.call) {
      case 'write':
        result = this.sysWrite(p, sc.fd, sc.data)
        break
      case 'read': {
        const r = this.sysRead(p, sc.fd, sc.len)
        if (r === undefined) blocked = true
        else result = r
        break
      }
      case 'open':
        result = this.sysOpen(p, sc.path, sc.flags)
        break
      case 'close':
        result = p.fds.delete(sc.fd) ? 0 : { err: 'EBADF' }
        break
      case 'dup':
        result = this.sysDup(p, sc.fd, -1)
        break
      case 'dup2':
        result = this.sysDup(p, sc.from, sc.to)
        break
      case 'readdir': {
        const node = this.walk(p, sc.path)
        if ('err' in node) result = { err: node.err }
        else if (node.type !== T_DIR) result = { err: 'ENOTDIR' }
        else if (!this.modeAllows(p, this.vfs.fsOf(node), node.ino, false)) result = { err: 'EACCES' }
        else {
          const fs = this.vfs.fsOf(node)
          result = fs.entries(node.ino).map((e) => ({
            name: e.name,
            ino: e.ino,
            type: TYPE_NAME[fs.itype(e.ino)] ?? 'file',
            size: fs.isize(e.ino),
            exec: fs.iexec(e.ino),
            disk: node.dev.spec.name,
          }))
        }
        break
      }
      case 'stat': {
        const node = this.walk(p, sc.path)
        result =
          'err' in node
            ? { err: node.err }
            : {
                ino: node.ino,
                type: TYPE_NAME[node.type] ?? 'file',
                size: node.size,
                exec: node.exec,
                disk: node.dev.spec.name,
                name: node.name,
              }
        break
      }
      case 'mkdir':
        result = this.sysCreate(p, sc.path, T_DIR)
        break
      case 'unlink':
        result = this.sysUnlink(p, sc.path)
        break
      case 'rename':
        result = this.sysRename(p, sc.from, sc.to)
        break
      case 'chmod': {
        const node = this.walk(p, sc.path)
        if ('err' in node) result = { err: node.err }
        else if (node.dev.spec.name === 'rom') result = { err: 'EROFS' }
        else if (!this.isRoot(p) && p.euid !== node.uid) result = { err: 'EPERM' }
        else {
          const fs = this.vfs.fsOf(node)
          fs.setFlags(node.ino, (fs.iflags(node.ino) | sc.set) & ~sc.clear & 0xff)
          this.dirty = true
          result = 0
        }
        break
      }
      case 'chdir': {
        const node = this.walk(p, sc.path)
        if ('err' in node) result = { err: node.err }
        else if (node.type !== T_DIR) result = { err: 'ENOTDIR' }
        else if (!this.canExec(p, this.vfs.fsOf(node), node.ino)) result = { err: 'EACCES' }
        else {
          p.cwd = normalizePath(sc.path, p.cwd)
          result = 0
        }
        break
      }
      case 'getcwd':
        result = p.cwd
        break
      case 'spawn':
        result = this.sysSpawn(p, sc.path, sc.args)
        break
      case 'exit':
        this.observer?.syscall?.(this.ticks, p.pid, p.name, sc, undefined, false)
        this.doExit(p, sc.code)
        return
      case 'wait': {
        const kids = this.childrenOf(p.pid)
        const zombie = kids.find((k) => k.state === 'zombie' && (sc.pid === -1 || k.pid === sc.pid))
        if (zombie) {
          result = { pid: zombie.pid, code: zombie.exitCode ?? 0 }
          this.removeChild(p, zombie)
          if (p.pid === this.shellPid) this.fgPid = p.pid
        } else if (kids.some((k) => sc.pid === -1 || k.pid === sc.pid)) {
          p.state = 'blocked'
          p.waitFor = sc.pid
          blocked = true
        } else result = { err: 'ECHILD' }
        break
      }
      case 'sleep':
        if (sc.ticks <= 0) result = 0
        else {
          // Syscall 6 is handled in the CRX kernel. This branch exists only for
          // compatibility with a host-generated request.
          p.state = 'blocked'
          p.sleepMode = 1
          p.wakeAt = this.mem.u16(0x0028) + sc.ticks
          blocked = true
        }
        break
      case 'sleepSeconds':
        if (sc.seconds <= 0) result = 0
        else {
          p.state = 'blocked'
          p.sleepMode = 2
          p.wakeAt = Math.ceil(performance.now() + sc.seconds * 1000)
          blocked = true
        }
        break
      case 'kill': {
        const t = this.procs.get(sc.pid)
        if (!t) result = { err: 'ESRCH' }
        else if (!this.isRoot(p) && (sc.pid <= 1 || (t.euid !== p.euid && t.uid !== p.euid)))
          result = { err: 'EPERM' }
        else {
          this.killSig(t, sc.sig)
          result = 0
        }
        break
      }
      case 'mount':
        result = this.isRoot(p) ? this.sysMount(sc.dev, sc.dir, p.cwd) : { err: 'EPERM' }
        break
      case 'umount':
        result = this.isRoot(p) ? this.sysUmount(sc.target, p.cwd) : { err: 'EPERM' }
        break
      case 'sync':
        result = this.flush(false)
        break
      case 'getpid':
        result = p.pid
        break
      case 'getenv':
        result = p.env[sc.key] ?? ''
        break
      case 'tcsetpgrp': {
        const t = this.procs.get(sc.pid)
        if (t && !this.isRoot(p) && t.euid !== p.euid) result = { err: 'EPERM' }
        else {
          this.fgPid = sc.pid
          result = 0
        }
        break
      }
      case 'view':
        result = this.sysView(sc.kind, sc.arg, p)
        break
      case 'assemble':
        result = this.sysAssemble(sc.source, sc.output, p)
        break
      case 'time':
        result = { ticks: this.ticks, hz: this.hz }
        break
    }

    if (blocked) {
      this.observer?.syscall?.(this.ticks, p.pid, p.name, sc, undefined, true)
      return
    }
    if (typeof result === 'number') p.regs.ax = result
    this.observer?.syscall?.(this.ticks, p.pid, p.name, sc, result, false)
    p.pending = result
  }

  private statfs() {
    const fs = this.fsOf('sda')
    return { max: fs.inodeCount, used: fs.usedInodes(), bytes: fs.usedBlocks() * fs.dev.blockSize }
  }

  // /proc 与 /sys 风格的文本视图。格式化发生在内核虚拟文件层，命令本身只做 read/write。
  private sysView(kind: number, arg: string, p: Process): string | Err {
    if (kind === 1) {
      let out = '  PID  PPID   UID STAT MEM TIME COMMAND\n'
      for (const r of this.procInfoList())
        out += `${String(r.pid).padStart(5)} ${String(r.ppid).padStart(5)} ${String(r.uid).padStart(5)} ${r.state
          .slice(0, 4)
          .toUpperCase()
          .padEnd(5)} ${String(r.pages).padStart(3)}p ${String(r.ticks).padStart(4)} ${r.cmd}${
          r.state === 'zombie' ? ' <defunct>' : ''
        }\n`
      return clip(out, 1190)
    }
    if (kind === 2) {
      const m = this.mem.stats()
      let out = '             total      used      free\n'
      out += `Mem:  ${String(m.total).padStart(10)}${String(m.used).padStart(10)}${String(m.free).padStart(10)} bytes\n`
      for (const r of this.procInfoList()) out += `pid ${r.pid} ${r.name.padEnd(10)} ${r.pages} pages\n`
      return clip(out, 1190)
    }
    if (kind === 3) {
      let out = 'NAME MODEL             SIZE  USED  BS  RM MOUNTPOINT\n'
      for (const d of this.blkInfo())
        out += `${d.name.padEnd(5)}${d.model.padEnd(17)}${String(d.size).padStart(6)}${String(d.used).padStart(6)} ${String(
          d.blockSize,
        ).padStart(3)}  ${d.removable ? 1 : 0} ${d.present ? (d.mountpoint ?? '-') : '(no medium)'}\n`
      return out
    }
    if (kind === 4) {
      let out = 'Filesystem Blocks Used Avail Use% Mounted on\n'
      for (const d of this.blkInfo()) {
        if (!d.present) continue
        const pct = Math.round((d.usedBlocks / d.blocks) * 100)
        out += `/dev/${d.name.padEnd(7)} ${String(d.blocks).padStart(5)} ${String(d.usedBlocks).padStart(4)} ${String(
          d.blocks - d.usedBlocks,
        ).padStart(5)} ${String(pct + '%').padStart(4)} ${d.mountpoint ?? '-'}\n`
      }
      return out
    }
    if (kind === 5) return clip(this.kmsgLines().join('\n') + '\n', 1190)
    if (kind === 6 || kind === 7) {
      const node = this.walk(p, arg)
      if ('err' in node) return { err: node.err }
      if (node.type !== T_FILE) return { err: 'EISDIR' }
      if (!this.modeAllows(p, this.vfs.fsOf(node), node.ino, false)) return { err: 'EACCES' }
      const raw = this.vfs.fsOf(node).readBytes(node.ino)
      if (kind === 7) {
        const exe = loadExe(String.fromCharCode(...raw))
        if (!exe) return { err: 'ENOEXEC' }
        return clip(
          `${arg}: CRX executable, text ${exe.textLen} B, data ${exe.dataLen} B, entry ${hexAddr(exe.entry)}\n\n` +
            disassemble(exe.image, exe.textLen, 80).join('\n') +
            '\n',
          1190,
        )
      }
      let out = ''
      const n = Math.min(raw.length, 256)
      for (let at = 0; at < n; at += 16) {
        const row = [...raw.subarray(at, Math.min(n, at + 16))]
        const hx = row.map((b) => b.toString(16).padStart(2, '0')).join(' ')
        const asc = row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')
        out += `${at.toString(16).padStart(8, '0')}  ${hx.padEnd(47)} |${asc}|\n`
      }
      return out
    }
    if (kind === 9)
      return [
        'crados commands (every file in /bin is CRX machine code)',
        '',
        'files:   ls cat head wc cp mv rm rmdir mkdir touch chmod echo',
        'process: ps kill sleep count pid',
        'storage: lsblk df mount umount   (writeback is automatic)',
        'kernel:  mem dmesg hexdump objdump uname whoami',
        'build:   as source.s -o program',
        'shell:   cd pwd clear exit; > redirects; & runs in background',
        'manual:  man [README|asm|storage|inspect|script]',
        '         append .zh for Chinese, e.g. man asm.zh',
        '',
      ].join('\n')
    return { err: 'EINVAL' }
  }

  // 汇编服务使用与引导 ROM 完全相同的编码器；产物仍由 CPU 执行，不存在函数入口。
  private sysAssemble(source: string, output: string, p: Process): 0 | Err {
    const src = this.walk(p, source)
    if ('err' in src) return src
    if (src.type !== T_FILE) return { err: 'EISDIR' }
    if (!this.modeAllows(p, this.vfs.fsOf(src), src.ino, false)) return { err: 'EACCES' }
    const text = this.vfs.fsOf(src).read(src.ino)
    const built = assemble(text)
    if (built.errors.length) {
      this.log(`as: ${source}:${built.errors[0]}`)
      return { err: 'EINVAL' }
    }
    let dst = this.walk(p, output)
    if ('err' in dst) {
      if (dst.err !== 'ENOENT') return dst
      const c = this.sysCreate(p, output, T_FILE)
      if (c !== 0) return c
      dst = this.walk(p, output)
    }
    if ('err' in dst) return dst
    if (dst.dev.spec.name === 'rom') return { err: 'EROFS' }
    if (!this.modeAllows(p, this.vfs.fsOf(dst), dst.ino, true)) return { err: 'EACCES' }
    const fs = this.vfs.fsOf(dst)
    const wr = fs.writeBytes(dst.ino, built.bytes)
    if (isErr(wr)) return wr
    fs.setExec(dst.ino, true)
    this.dirty = true
    return 0
  }

  private sysCreate(p: Process, path: string, type: number): 0 | Err {
    const abs = normalizePath(path, p.cwd)
    const parent = this.parentNode(p, abs)
    if ('err' in parent) return parent
    const fs = this.vfs.fsOf(parent)
    const r = fs.create(parent.ino, basename(abs), type)
    if (typeof r !== 'number') return r
    fs.setOwner(r, p.euid)
    this.dirty = true
    return 0
  }

  private sysUnlink(p: Process, path: string): 0 | Err {
    const abs = normalizePath(path, p.cwd)
    if (abs === '/' || this.vfs.isMountPoint(abs)) return { err: 'EBUSY' }
    const node = this.walk(p, abs)
    if ('err' in node) return node
    if (node.dev.spec.name === 'rom') return { err: 'EROFS' }
    if (node.type === T_DEV) return { err: 'EPERM' }
    const parent = this.parentNode(p, abs)
    if ('err' in parent) return parent
    const fs = this.vfs.fsOf(node)
    if (node.type === T_DIR && fs.entries(node.ino).length) return { err: 'ENOTEMPTY' }
    if ((fs.iflags(parent.ino) & M_STICKY) !== 0 && !this.isRoot(p) && p.euid !== node.uid)
      return { err: 'EPERM' }
    fs.unlink(fs.iparent(node.ino), node.name)
    fs.destroy(node.ino)
    this.dirty = true
    return 0
  }

  private sysRename(p: Process, from: string, to: string): 0 | Err {
    const src = this.walk(p, from)
    if ('err' in src) return src
    if (src.type === T_DEV) return { err: 'EPERM' }
    if (src.dev.spec.name === 'rom') return { err: 'EROFS' }
    const srcParent = this.parentNode(p, normalizePath(from, p.cwd))
    if ('err' in srcParent) return srcParent
    const fs = this.vfs.fsOf(src)
    if ((fs.iflags(srcParent.ino) & M_STICKY) !== 0 && !this.isRoot(p) && p.euid !== src.uid)
      return { err: 'EPERM' }

    const absTo = normalizePath(to, p.cwd)
    const existing = this.vfs.resolve(absTo, '/')
    let dir: FNode | Err
    let name: string
    if (!('err' in existing) && existing.type === T_DIR) {
      if (existing.dev.spec.name === 'rom') return { err: 'EROFS' }
      if (!this.canExec(p, this.vfs.fsOf(existing), existing.ino) || !this.modeAllows(p, this.vfs.fsOf(existing), existing.ino, true))
        return { err: 'EACCES' }
      dir = existing
      name = src.name
    } else {
      dir = this.parentNode(p, absTo)
      name = basename(absTo)
      if (!('err' in existing)) {
        const removed = this.sysUnlink(p, absTo)
        if (removed !== 0) return removed
      }
    }
    if ('err' in dir) return dir
    if (dir.dev !== src.dev) return { err: 'EXDEV' } // 跨设备只能用 cp 逐块复制
    fs.unlink(fs.iparent(src.ino), src.name)
    const r = fs.link(dir.ino, name, src.ino)
    if (r !== 0) return r
    fs.reparent(src.ino, dir.ino)
    this.dirty = true
    return 0
  }

  private sysWrite(p: Process, fd: number, data: string | Uint8Array): number | Err {
    const f = p.fds.get(fd)
    if (!f) return { err: 'EBADF' }
    if (f.kind === 'stdin' || (f.kind === 'file' && f.flags === 'r')) return { err: 'EBADF' }
    if (f.kind === 'file') {
      const fs = this.fss.get(f.dev)
      if (!fs) return { err: 'EBADF' }
      if (f.dev === 'rom') return { err: 'EROFS' }
      if (!this.modeAllows(p, fs, f.ino, true)) return { err: 'EACCES' }
    }
    const raw = typeof data === 'string' ? UTF8_ENCODER.encode(data) : data
    if (f.kind === 'stdout') {
      const cls = f.id === 2 ? 'err' : 'out'
      this.conWrite(this.ttyDecoders[cls].decode(raw, { stream: true }), cls)
      return raw.length
    }
    if (f.kind === 'tty') {
      this.conWrite(this.ttyDecoders.out.decode(raw, { stream: true }), 'out')
      return raw.length
    }
    if (f.kind === 'null') return raw.length
    // 直接按偏移写盘：只有受影响的块被改写，不经任何中间副本
    const fs = this.fss.get(f.dev)!
    const at = f.flags === 'a' ? fs.isize(f.ino) : f.pos
    const r = fs.writeAt(f.ino, at, raw)
    if (isErr(r)) return r
    p.fds.seek(fd, at + raw.length) // 文件偏移回写进 PCB 的 fd 表
    this.dirty = true
    return raw.length
  }

  private sysRead(p: Process, fd: number, len?: number): ReadBytes | null | Err | undefined {
    const f = p.fds.get(fd)
    if (!f) return { err: 'EBADF' }
    if (f.kind === 'stdout') return { err: 'EBADF' }
    if (f.kind === 'null') return null
    if (f.kind === 'stdin' || f.kind === 'tty') {
      if (!this.lineQueue.length) {
        p.state = 'blocked'
        p.readStdin = true
        return undefined
      }
      const line = this.lineQueue.shift()
      return line === null || line === undefined ? null : { bytes: UTF8_ENCODER.encode(line) }
    }
    const fs = this.fss.get(f.dev)!
    if (!this.modeAllows(p, fs, f.ino, false)) return { err: 'EACCES' }
    const size = fs.isize(f.ino)
    if (f.pos >= size) return { bytes: new Uint8Array(0) }
    // 机器码程序按缓冲区大小分次读取；不给长度则读到文件末尾
    const want = len && len > 0 ? Math.min(len, size - f.pos) : size - f.pos
    const raw = fs.readAt(f.ino, f.pos, want)
    p.fds.seek(fd, f.pos + want)
    return { bytes: raw }
  }

  private lowestFd(p: Process): number {
    let fd = 3
    while (p.fds.has(fd)) fd++
    return fd
  }

  private sysOpen(p: Process, path: string, flags: 'r' | 'w' | 'a'): number | Err {
    let node = this.walk(p, path)
    if ('err' in node) {
      if (flags === 'r' || node.err !== 'ENOENT') return node
      const c = this.sysCreate(p, path, T_FILE)
      if (c !== 0) return c
      node = this.walk(p, path)
      if ('err' in node) return node
    }
    const n = node as FNode
    if (n.type === T_DIR) return { err: 'EISDIR' }
    if (flags === 'r') {
      if (!this.modeAllows(p, this.vfs.fsOf(n), n.ino, false)) return { err: 'EACCES' }
    } else if (n.dev.spec.name === 'rom') return { err: 'EROFS' }
    else if (!this.modeAllows(p, this.vfs.fsOf(n), n.ino, true)) return { err: 'EACCES' }
    const fd = this.lowestFd(p)
    if (n.type === T_DEV) {
      p.fds.set(fd, n.driver === DRV_TTY ? { kind: 'tty' } : { kind: 'null' })
      return fd
    }
    const fs = this.vfs.fsOf(n)
    if (flags === 'w') {
      fs.truncate(n.ino) // O_TRUNC：释放全部数据块，size 归零
      this.dirty = true
    }
    p.fds.set(fd, {
      kind: 'file',
      ino: n.ino,
      dev: n.dev.spec.name,
      pos: flags === 'a' ? fs.isize(n.ino) : 0,
      flags,
    })
    return fd
  }

  private sysDup(p: Process, from: number, to: number): number | Err {
    const f = p.fds.get(from)
    if (!f) return { err: 'EBADF' }
    const fd = to > 0 ? to : this.lowestFd(p)
    p.fds.set(fd, f)
    return fd
  }

  // execve：读 inode → 逐块把映像拷进物理内存 → 按格式决定如何解释
  private sysSpawn(p: Process, path: string, args: string[]): number | Err {
    let resolved = path
    if (!path.includes('/')) {
      for (const dir of (p.env.PATH || '/bin:/usr/bin').split(':')) {
        const candidate = `${dir}/${path}`
        if (!('err' in this.vfs.resolve(candidate, p.cwd))) {
          resolved = candidate
          break
        }
      }
    }
    const node = this.walk(p, resolved)
    if ('err' in node) return node
    if (node.type === T_DIR) return { err: 'EISDIR' }
    if (node.type === T_DEV) return { err: 'EACCES' }
    if (!this.canExec(p, this.vfs.fsOf(node), node.ino)) return { err: 'EACCES' }

    const fs = this.vfs.fsOf(node)
    const image = fs.readBytes(node.ino) // 真实的块读取
    const abs = normalizePath(resolved, p.cwd)
    const blocks = fs.blocksOf(node.ino).length
    this.log(`execve: ${abs} read ${blocks} block(s) from ${node.dev.spec.name}, ${image.length} bytes into memory`)

    const text = String.fromCharCode(...image.subarray(0, 4))
    if (isExecutable(text)) {
      const exe = loadExe(String.fromCharCode(...image))
      if (!exe) return { err: 'ENOEXEC' }
      this.log(`execve: CRX image, text ${exe.textLen} B, data ${exe.dataLen} B, entry ${hexAddr(exe.entry)}`)
      return this.launch(p, node.name, `${node.name} ${args.join(' ')}`.trim(), args, { entry: exe.entry }, exe.image, node)
    }

    const head = String.fromCharCode(...image.subarray(0, 64)).split('\n', 1)[0]
    if (!head.startsWith('#!')) return { err: 'ENOEXEC' }
    const interpPath = head.slice(2).trim().split(/\s+/)[0]
    const interp = this.walk(p, interpPath)
    if ('err' in interp || !this.canExec(p, this.vfs.fsOf(interp), interp.ino)) return { err: 'ENOEXEC' }
    const interpRaw = this.vfs.fsOf(interp).readBytes(interp.ino)
    const interpExe = loadExe(String.fromCharCode(...interpRaw))
    if (!interpExe) return { err: 'ENOEXEC' }
    this.log(`execve: ${abs} interpreted by ${interpPath}`)
    return this.launch(
      p,
      basename(abs),
      `${basename(abs)} ${args.join(' ')}`.trim(),
      [abs, ...args],
      { entry: interpExe.entry },
      interpExe.image,
      node,
    )
  }

  private launch(
    p: Process,
    name: string,
    cmd: string,
    args: string[],
    spec: ExecSpec,
    image: Uint8Array,
    file: FNode,
  ): number | Err {
    const setuid = (this.vfs.fsOf(file).iflags(file.ino) & M_SETUID) !== 0 ? file.uid : undefined
    const r = this.exec(p, name, cmd, args, spec, image, setuid)
    if ('err' in r) {
      this.log(`fork: pid ${p.pid} (${p.name}): ${r.err === 'ENOMEM' ? 'out of physical memory' : r.err}`)
      return { err: r.err }
    }
    this.log(`sched: pid ${r.pid} (${name}) forked from pid ${p.pid}, ${r.pageTable.length} pages`)
    return r.pid
  }

  private procInfoList(): ProcInfo[] {
    return [...this.procs.values()].map((p) => ({
      pid: p.pid,
      ppid: p.ppid,
      uid: p.euid,
      name: p.name,
      state: p.state,
      cmd: p.cmd,
      pages: p.pageTable.length,
      ticks: p.ticksUsed,
    }))
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
    if (fg && fg.pid !== this.shellPid && fg.state !== 'zombie') this.killSig(fg, 2)
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
    if (toConsole) this.conWrite(`[${(this.ticks / this.hz).toFixed(4).padStart(9)}] ${msg}\n`, 'sys')
  }

  private kmsgLines(): string[] {
    return this.klog.map((e) => `[${(e.tick / this.hz).toFixed(4).padStart(9)}] ${e.msg}`)
  }

  private emit() {
    if (this.suppress) return
    this.observer?.changed()
  }
}
