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
import { factoryAccounts, parsePasswd, serializePasswd } from './accounts'
import type { Account } from './accounts'
import { FS, lookupAbs, M_SETUID, MODE_DIR, MODE_FILE, T_DIR, T_FILE, UID_ROOT, VFS } from './fs'
import { ROOT_INO } from './ext2'
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
  SCRATCH_BASE,
  SCRATCH_SIZE,
  USER_FRAME_START,
} from './memory'
import { assemble, disassemble, loadExe } from './isa'
import { ASM_PROGRAMS } from './asmsrc'
import { GUEST_IDLE_SOURCE, GUEST_KERNEL_SOURCE } from './guestkernel'
import { GUEST_POLICY_SOURCE } from './guestpolicy'
import { OS_VERSION } from '../utils/config'
import { Fault, NO_IRQ, runExe, VECTOR_TIMER, VECTOR_TTY } from './vm'
import type { Bus } from './vm'
import { deviceCode, deviceName, MAX_PAGES, MAX_PROCS, PCB_BASE, PCB_MODE, PCB_SIZE, Process } from './process'
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
const MMIO_TTY_MODE = 0xff12 // 0 = 关闭回显（密码输入），非 0 = 恢复
const MMIO_BLOCK = 0xfe00
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
  private readonly fss = new Map<string, FS>()
  private readonly procs = new Map<number, Process>()
  private readonly binErrors: string[] = []
  private kernelIvt = 0
  private nextPid = 0
  // 页表缓存纪元：PCB 页表字节被改写就递增，各进程的 MMU 缓存在下次访存时重建
  private xlateEpoch = 0

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
  // canonical tty 回显开关：密码输入时 CRX 内核通过 MMIO 0xFF12 关掉它
  private ttyEcho = true
  // CRX 以字节写 TTY，清屏序列可能跨多个 MMIO write；驱动保留控制序列前缀，
  // 不能把 ESC、[、2、J 当成四个普通可见字符。
  private ttyEscape = ''
  // TTY 是字节设备，UTF-8 只在驱动边界解码；stream 模式能跨 write 调用保留半个字符。
  private readonly ttyDecoders = {
    out: new TextDecoder('utf-8', { fatal: false }),
    err: new TextDecoder('utf-8', { fatal: false }),
  }
  // Block controller registers (big-endian u16): command, device, block,
  // buffer, status. TypeScript implements DMA only; the on-disk layout stays the guest's business.
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
    stamp(`crados ${OS_VERSION} booting on browser/js`)
    stamp(`cpu: 1 core, timer interrupt ${this.hz} Hz, round robin quantum ${QUANTUM}`)
    stamp(`mm: ${FRAME_COUNT} frames of ${PAGE_SIZE} B, ${RAM_SIZE / 1024} KiB`)

    if (!this.installGuestKernel()) {
      this.setPanic('cannot install CRX kernel trap page')
      return
    }

    // sda：根盘（相当于 Windows 的 C 盘），优先从持久化存储恢复整盘字节。
    // 系统程序 /bin/* 也装在这块盘上，每次上电重新写入以保证与当前固件一致。
    const sda = this.makeDev('sda')
    const sdafs = this.fss.get('sda')!
    const restored = loadDev(sda) && sdafs.valid()
    if (!restored) {
      const image = buildRootImage()
      sda.load(image.bytes)
      for (const e of image.errors) this.log(`rootfs image: ${e}`)
    }
    this.vfs.umount('/')
    this.vfs.mount('/', sdafs)
    const compiled = this.installPrograms(sdafs)
    stamp(`bin: ${compiled} programs installed on /dev/sda`)
    this.ensureAccounts('sda')
    stamp(
      restored
        ? `sda: superblock valid, ${sdafs.usedInodes()} inodes, ${sdafs.usedBlocks()}/${sda.blockCount} blocks in use`
        : `sda: root image written, ${sdafs.usedInodes()} inodes, ${sdafs.usedBlocks()}/${sda.blockCount} blocks in use`,
    )
    stamp('vfs: mounted /dev/sda on /')

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

    if (this.binErrors.length) {
      this.panic = `program install failed: ${this.binErrors.join('; ')}`
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
      for (let guard = 0; guard < 32 && cur !== ROOT_INO; guard++) {
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
    this.fss.set(name, new FS(dev))
    return dev
  }

  // 烧写 ROM：/bin 里只接受汇编后的 CRX 映像
  private installPrograms(fs: FS): number {
    let compiled = 0
    let bin = fs.lookup(ROOT_INO, 'bin')
    if (!bin) {
      const made = fs.create(ROOT_INO, 'bin', T_DIR)
      if (typeof made !== 'number') {
        this.binErrors.push(`cannot create /bin: ${made.err}`)
        return 0
      }
      bin = made
    }
    // 每次上电重烧 /bin：unlink 顺手把 inode 与其数据块还回位图
    for (const e of fs.entries(bin)) fs.unlink(bin, e.name)
    for (const [name, source] of Object.entries(ASM_PROGRAMS)) {
      const r = assemble(source)
      if (r.errors.length) {
        const error = `${name}: ${r.errors[0]}`
        this.binErrors.push(error)
        this.log(`bin: failed to assemble ${error}`)
        continue
      }
      const ino = fs.create(bin, name, T_FILE)
      if (typeof ino !== 'number') continue
      fs.writeBytes(ino, r.bytes)
      // login/passwd 需要以 root 的有效身份写 /etc/passwd、启动登录会话
      const setuid = name === 'login' || name === 'passwd' ? M_SETUID : 0
      fs.setFlags(ino, MODE_DIR | setuid) // 0755（可执行）
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
  filesystem(name: string): FS | undefined {
    return this.fss.get(name)
  }
  /** 整盘字节的副本。验收脚本靠它把 guest 写过的盘交给 e2fsck；界面也可用来导出镜像。 */
  diskImage(name: string): Uint8Array | null {
    const dev = this.devs.get(name)
    return dev ? dev.bytes.slice() : null
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
      this.wakeWaiters(cur)
      // 客户内核的阻塞序列是「先把自己标 BLOCKED，再 do_schedule 更新
      // kCurrentPid」。时间片边界可能正好切进这个窗口：此时 kCurrentPid
      // 仍指向已标 BLOCKED 的当前进程。必须让它继续跑完这段原子序列
      // （生成器会在 do_schedule 之后的 sched 处正常让出），绝不能此刻
      // 换人——否则该生成器永远冻结在半途，readStdin/waitFor 都不会生效。
      const midSwitch = !!cur && cur.state === 'blocked' && kCurrentPid === cur.pid
      if ((!cur || cur.state !== 'running') && !midSwitch) {
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

      if (!cur) break
      if (cur.state !== 'running' && !midSwitch) break
      // 丢失唤醒补偿：输入可能在读端「查完 STATUS 为空、尚未置 readStdin」
      // 的间隙到达，那一拍的中断会被正在内核态的读端自己收走（永远不响应），
      // 或在扫描时读端还没挂上而被丢弃。只要还有输入且有进程阻塞在 stdin，
      // 就重新拉起 TTY 中断，让空闲进程再扫一次并唤醒它。
      if (!this.ttyIrqPending && (this.lineQueue.length > 0 || this.inputPacket !== undefined)) {
        for (const p of this.procs.values()) {
          if (p.state === 'blocked' && p.readStdin) {
            this.ttyIrqPending = true
            break
          }
        }
      }
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
    const bytes = mem.bytes
    const pcbBase = p.base
    // 每进程页表缓存：vpn → (pfn | supervisor<<15)，未映射为 -1。
    // 只有 PCB 的页表字节被写过时才重建（写路径递增 xlateEpoch）。
    const xlate = new Int32Array(MAX_PAGES)
    let xlateEpoch = -1
    const syncXlate = () => {
      for (let vpn = 0; vpn < MAX_PAGES; vpn++) xlate[vpn] = p.pteBits(vpn)
      xlateEpoch = this.xlateEpoch
    }
    const userAddr = (va: number): number => {
      if (xlateEpoch !== this.xlateEpoch) syncXlate()
      const raw = xlate[va >>> 8]
      if (raw < 0) throw new Fault(va, 'page fault')
      if (raw & 0x8000) throw new Fault(va, 'supervisor page fault')
      return ((raw & 0x7fff) << 8) + (va & 0xff)
    }
    // Kernel instructions use a physical direct map. The sole exception is
    // the per-process supervisor stack at VPN 15. Access to user virtual
    // memory must use ULDB/USTB (forceUser=true), never an ordinary load.
    const kernelAddr = (va: number): number => {
      if (xlateEpoch !== this.xlateEpoch) syncXlate()
      const raw = xlate[va >>> 8]
      if (raw >= 0 && raw & 0x8000) return ((raw & 0x7fff) << 8) + (va & 0xff)
      if (va < RAM_SIZE) return va
      throw new Fault(va, 'kernel address fault')
    }
    const inKernel = () => bytes[pcbBase + PCB_MODE] !== 0
    const addr = (va: number, forceUser: boolean): number =>
      forceUser || !inKernel() ? userAddr(va) : kernelAddr(va)
    const readMem = (va: number, forceUser = false) => bytes[addr(va, forceUser)]
    const writeMem = (va: number, b: number, forceUser = false) => {
      bytes[addr(va, forceUser)] = b & 0xff
    }
    // PCB 页表字节被改写后，缓存必须在下次访存前失效
    const noteWrite = (pa: number) => {
      if ((pa - PCB_BASE) >>> 0 < MAX_PROCS * PCB_SIZE) this.xlateEpoch++
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
      if (this.inputPacket.length === 0) return 3
      // 4 = 本行只剩最后一个字节。读端凭它在行边界停住，一次 read 只拿一行，
      // 否则排队里的多行会被拼成一条超长命令。
      return this.inputOffset === this.inputPacket.length - 1 ? 4 : 1
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
      // 命令 4/5 只服务内核自己的暂存区。用户可控的缓冲区不能从这里写进物理内存。
      if ((command === 4 || command === 5) && buffer !== SCRATCH_BASE) {
        setReg16(8, 0xffff)
        return
      }
      if (!dev || block >= dev.blockCount) {
        setReg16(8, 0xffff)
        return
      }
      try {
        const bytes = dev.block(block)
        if (bytes.length > SCRATCH_SIZE) {
          setReg16(8, 0xffff)
          return
        }
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
        return inKernel() ? RAM_SIZE : p.addressLimit
      },
      read: (va) => {
        if (!inKernel()) return bytes[userAddr(va)]
        if (va === MMIO_TTY_STATUS) return ttyStatus()
        if (va === MMIO_TTY_DATA) return ttyData()
        if (va >= MMIO_BLOCK && va < MMIO_BLOCK + this.blockRegs.length) {
          return this.blockRegs[va - MMIO_BLOCK]
        }
        if (va >= 0xff00) return 0
        return bytes[kernelAddr(va)]
      },
      readUser: (va) => bytes[userAddr(va)],
      writeUser: (va, b) => {
        const pa = userAddr(va)
        bytes[pa] = b & 0xff
        noteWrite(pa)
      },
      write: (va, b) => {
        if (!inKernel()) {
          const pa = userAddr(va)
          bytes[pa] = b & 0xff
          noteWrite(pa)
          return
        }
        if (va >= MMIO_BLOCK && va < MMIO_BLOCK + this.blockRegs.length) {
          const off = va - MMIO_BLOCK
          this.blockRegs[off] = b & 0xff
          if (off === 1) runBlockCommand()
          return
        }
        if (va >= 0xff00) {
          this.mmioWrite(va, b)
          return
        }
        const pa = kernelAddr(va)
        bytes[pa] = b & 0xff
        noteWrite(pa)
      },
    }
  }

  private conWriteTty(text: string, cls: SegClass) {
    if (!text) return
    const sequence = '\x1b[2J'
    const combined = this.ttyEscape + text
    this.ttyEscape = ''
    let from = 0
    while (from < combined.length) {
      const hit = combined.indexOf(sequence, from)
      if (hit >= 0) {
        if (hit > from) this.conWrite(combined.slice(from, hit), cls)
        this.lines = []
        from = hit + sequence.length
        continue
      }
      const tail = combined.slice(from)
      let keep = 0
      for (let n = 1; n < sequence.length; n++) {
        if (tail.endsWith(sequence.slice(0, n))) keep = n
      }
      if (keep) {
        const visible = tail.slice(0, -keep)
        if (visible) this.conWrite(visible, cls)
        this.ttyEscape = tail.slice(-keep)
      } else {
        this.conWrite(tail, cls)
      }
      return
    }
  }

  // TypeScript only supplies the virtual UART hardware. It does not inspect
  // syscalls or file descriptors; those decisions are made by CRX kernel code.
  private mmioWrite(port: number, byte: number) {
    const raw = Uint8Array.of(byte & 0xff)
    if (port === MMIO_TTY_OUT) {
      this.conWriteTty(this.ttyDecoders.out.decode(raw, { stream: true }), 'out')
    } else if (port === MMIO_TTY_ERR) {
      this.conWriteTty(this.ttyDecoders.err.decode(raw, { stream: true }), 'err')
    } else if (port === MMIO_TTY_MODE) {
      this.ttyEcho = (byte & 0xff) !== 0
    }
  }

  // 找一个空闲 PCB 槽。表满时先回收「没人会再 wait 的僵尸」：后台作业（命令后跟 &）
  // 的父进程只把自己标回读键盘，永远不会 wait 那个 pid，僵尸就永久占着槽位——攒到
  // 十几个后台命令之后连 echo 都跑不起来（sh: command not found）。这里只在实在没
  // 槽位时兜底：正在等这个 pid 的父进程一律不动，避免抢掉 wait 的状态。
  private freeSlot(): number {
    for (let s = 0; s < MAX_PROCS; s++) {
      if (![...this.procs.values()].some((p) => p.slot === s)) return s
    }
    for (const z of this.procs.values()) {
      if (z.state !== 'zombie') continue
      const parent = this.procs.get(z.ppid)
      const awaited =
        !!parent && (parent.waitFor === -1 || parent.waitFor === z.pid) && parent.state === 'blocked' && parent.readStdin === false
      if (awaited) continue
      this.log(`sched: reclaiming abandoned zombie pid ${z.pid} (${z.name}) to free a PCB slot`)
      z.release()
      this.procs.delete(z.pid)
      return z.slot
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
    const banner = `crados ${OS_VERSION}\n`
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
    // ext2 几何：inode 表的字节偏移与 inode 总数。CRX 内核据此算 inode 偏移，
    // 但盘上结构仍然是它自己按字节解析的——宿主只发布事实。
    const root = this.fss.get('sda')
    const layout = root?.layout()
    this.mem.setU16(0x004a, layout ? layout.inodeTableByte : 0)
    this.mem.setU16(0x004c, layout ? layout.inodeCount : 0)
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
      let ino = ROOT_INO
      for (const seg of m.path.slice(host.path === '/' ? 0 : host.path.length).split('/').filter(Boolean)) {
        ino = host.fs.lookup(ino, seg)
        if (!ino) break
      }
      if (!ino) continue
      const at = KCB_MOUNTS + slot++ * 4
      this.mem.bytes[at] = deviceCode(host.fs.dev.spec.name)
      this.mem.bytes[at + 1] = ino
      this.mem.bytes[at + 2] = deviceCode(m.fs.dev.spec.name)
      this.mem.bytes[at + 3] = 0 // 保留：块控制器现在整块搬运，不再按 256 B 扇区寻址
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

  // 丢失唤醒补偿（wait）：客户内核在 wait 里的序列是「扫 PCB 表 → 没找到僵尸
  // 就把自己标 BLOCKED」。如果子进程恰好在这两步之间退出，tryReap 看到的父进程
  // 还是 RUNNING，唤醒条件不成立；父进程随后睡在一个已经不存在的等待上，永远
  // 不会醒来（终端只剩回显，提示符再也不出现）。每个时间片扫一遍：阻塞中的进程
  // 只要有一个已存在的僵尸子进程正好是它等的，就补一次唤醒。
  private wakeWaiters(current: Process | null): void {
    for (const p of this.procs.values()) {
      // 阻塞在读键盘的进程不算在等子进程：它的 waitFor 只是上一次 wait 留下的旧值，
      // 拿它去唤醒会让读端空转（唤醒→又读不到输入→再阻塞）。
      if (p === current || p.state !== 'blocked' || p.waitFor === null || p.readStdin) continue
      for (const c of this.procs.values()) {
        if (c.state === 'zombie' && c.ppid === p.pid && (p.waitFor === -1 || p.waitFor === c.pid)) {
          p.state = 'ready'
          break
        }
      }
    }
  }

  // init 与控制台登录循环是单例。控制台循环的判据是 login 不带账户名：
  // su 拉起的一次性 login 带账户名，必须能和控制台循环并存。
  private singletonBusy(name: string, args: string[]): boolean {
    if (name !== 'init' && name !== 'login') return false
    if (name === 'login' && args.length > 0) return false
    return [...this.procs.values()].some((p) => p.name === name && p.state !== 'zombie')
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
    if (this.singletonBusy(name, args)) return { err: 'EAGAIN' }
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
      if (!this.geometryOk(name)) {
        this.log(`${name}: refused, unsupported ext2 geometry (CRX kernel reads one fixed layout)`)
        continue
      }
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

  // ---------- 凭证与账户 ----------

  private euidOf(pid: number): number | null {
    return this.procs.get(pid)?.euid ?? null
  }

  // 账户表只住在根盘。ext2 的盘出厂就带 /etc/passwd（由 rootimg 写进镜像），
  // 这里只处理"导入的镜像里没有这张表"的情况。
  private ensureAccounts(name: string) {
    if (name !== 'sda') return
    const fs = this.fss.get(name)
    if (!fs || !fs.valid() || fs.accountsReady()) return
    for (const dir of ['home', 'root', 'etc', 'tmp']) {
      if (lookupAbs(fs, `/${dir}`)) continue
      const made = fs.create(ROOT_INO, dir, T_DIR)
      if (typeof made !== 'number') this.log(`accounts: cannot create /${dir}: ${made.err}`)
    }
    const accounts = factoryAccounts()
    let ino = lookupAbs(fs, '/etc/passwd')
    if (!ino) {
      const etc = lookupAbs(fs, '/etc')
      if (!etc) return
      const made = fs.create(etc, 'passwd', T_FILE)
      if (typeof made !== 'number') {
        this.log(`accounts: cannot create /etc/passwd: ${made.err}`)
        return
      }
      ino = made
    }
    fs.write(ino, serializePasswd(accounts))
    fs.setFlags(ino, MODE_FILE) // 0644：哈希很弱，这是教学系统
    this.dirty = true
    this.log(`accounts: ${accounts.length} account${accounts.length > 1 ? 's' : ''} in /etc/passwd (${accounts.map((a) => a.name).join(', ')})`)
  }

  // sda 上 /etc/passwd 的解析结果。表不存在时返回空表。
  private accountsOf(): Account[] {
    const fs = this.fss.get('sda')
    if (!fs || !fs.valid()) return []
    const ino = lookupAbs(fs, '/etc/passwd')
    if (!ino || fs.itype(ino) !== T_FILE) return []
    return parsePasswd(fs.read(ino))
  }

  // svc 43：账户服务，CRX 内核的权限判定统一走这里。
  //   op 1  权限检查，arg = 字母（l/m/b/k），查当前进程 euid 对应的账户
  //   op 2  账户查询，arg = uid → 1 普通 / 2 管理（带 a），锁定或不存在按失败
  //   op 3  填 spawn_req 的登录环境与 home 目录（arg = spawn_req 物理地址）
  private hwAcct(p: Process, op: number, arg: number): number | Err {
    if (op === 1) {
      if (p.euid === UID_ROOT) return 0
      const letter = String.fromCharCode(arg & 0xff)
      const acct = this.accountsOf().find((a) => a.uid === p.euid)
      return acct && acct.perms.includes(letter) ? 0 : { err: 'EPERM' }
    }
    if (op === 2) {
      const acct = this.accountsOf().find((a) => a.uid === arg)
      if (!acct) return { err: 'ENOENT' }
      if (acct.uid !== UID_ROOT && !acct.perms.includes('l')) return { err: 'EACCES' }
      return acct.perms.includes('a') ? 2 : 1
    }
    if (op === 3) return this.fillLoginEnv(arg)
    return { err: 'EINVAL' }
  }

  private fillLoginEnv(at: number): number | Err {
    const uid = this.mem.u16(at + 2)
    const acct = this.accountsOf().find((a) => a.uid === uid)
    if (!acct) return { err: 'ENOENT' }
    const home = acct.uid === UID_ROOT ? '/root' : `/home/${acct.name}`
    const env = `USER\0${acct.name}\0HOME\0${home}\0PATH\0/bin:/usr/bin\0SHELL\0/bin/sh\0`
    const bytes = UTF8_ENCODER.encode(env)
    if (bytes.length > 80) return { err: 'E2BIG' }
    this.mem.bytes.set(bytes, at + 186)
    this.mem.setU16(at + 184, bytes.length)
    const fs = this.fss.get('sda')
    const ino = fs ? lookupAbs(fs, home) : 0
    if (fs && ino && fs.itype(ino) === T_DIR) {
      this.mem.bytes[at + 266] = 1
      this.mem.bytes[at + 267] = ino
    }
    return 0
  }

  // ---------- 设备与持久化 ----------

  /**
   * ext2 的几何必须与本机根盘一致：CRX 机器码是按固定布局汇编的
   * （inode 表在哪、位图在哪、块总数多少都是常量），别的布局它读不了。
   */
  private geometryOk(name: string): boolean {
    const fs = this.fss.get(name)
    const ref = this.fss.get('sda')
    if (!fs || !ref) return false
    const a = fs.layout()
    const b = ref.layout()
    if (!a || !b) return false
    for (const k of Object.keys(b) as (keyof typeof b)[]) {
      if (a[k] !== b[k]) return false
    }
    return true
  }

  private fsOf(name: string): FS {
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
        // 目标可能已经退出：没有这个 pid 就是 ESRCH，不是内核崩溃
        const t = this.procs.get(sc.pid)
        if (t) this.killSig(t, sc.sig)
        result = t ? 0 : 0xffff
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
      case 'hwacct':
        result = this.hwAcct(p, sc.op, sc.arg)
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
    if (this.ttyEcho) this.conWrite(ch, 'echo')
    this.emit()
  }

  pressEnter() {
    if (this.panic) return
    this.lineQueue.push(this.lineBuf)
    this.lineBuf = ''
    if (this.ttyEcho) this.conWrite('\n', 'echo')
    this.ttyIrqPending = true
    this.emit()
  }

  pressBackspace() {
    if (this.panic || !this.lineBuf) return
    this.lineBuf = this.lineBuf.slice(0, -1)
    if (this.ttyEcho) {
      const line = this.lines[this.lines.length - 1]
      const seg = line?.segs[line.segs.length - 1]
      if (seg) {
        seg.t = seg.t.slice(0, -1)
        if (!seg.t) line.segs.pop()
      }
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
    if (this.ttyEcho) this.conWrite('\n', 'echo')
    this.ttyIrqPending = true
    this.emit()
  }

  private maySignalFg(fg: Process, shell: Process): boolean {
    if (!(fg.pid > 1 && fg.pid !== this.shellPid && fg.state !== 'zombie')) return false
    if (shell.euid === UID_ROOT || fg.euid === shell.euid || fg.uid === shell.euid) return true
    // gp_may_signal 的镜像：带 k 权限的账户可以向别的账户的进程发信号
    const acct = this.accountsOf().find((a) => a.uid === shell.euid)
    return !!acct && acct.perms.includes('k')
  }

  pressCtrlC() {
    if (this.panic) return
    this.conWrite('^C\n', 'err')
    this.lineBuf = ''
    const fgPid = this.foregroundPid
    const fg = fgPid !== null ? this.procs.get(fgPid) : undefined
    const shell = this.procs.get(this.shellPid)
    const allowed = fg !== undefined && shell !== undefined && this.maySignalFg(fg, shell)
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

  // Hardware facts for the merged lsblk views (-a/-d/-f). CRX formats the text;
  // this only fills the table.
  // Record: present, removable, name[3], bs_len, model[17], bs[4], size[8],
  // used[7], pct, blocks u16, usedBlocks u16, mount[16].
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
      const size = String(d.size).padStart(8).slice(-8)
      const used = String(d.used).padStart(7).slice(-7)
      for (let i = 0; i < 8; i++) b[at + 27 + i] = size.charCodeAt(i)
      for (let i = 0; i < 7; i++) b[at + 35 + i] = used.charCodeAt(i)
      b[at + 42] = d.blocks ? Math.round((d.usedBlocks / d.blocks) * 100) : 0
      this.mem.setU16(at + 43, d.blocks)
      this.mem.setU16(at + 45, d.usedBlocks)
      const mount = d.present ? (d.mountpoint ?? '-') : '(no medium)'
      for (let i = 0; i < mount.length && i < 16; i++) b[at + 47 + i] = mount.charCodeAt(i)
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
