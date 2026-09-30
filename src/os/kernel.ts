// crados 操作系统（跑在虚拟硬件上的软件）
//
// 存储的真相只有两处：主存条里的字节（hw/ram.ts）与磁盘上的字节（hw/disk.ts）。
// 文件系统的目录、inode、位图都是磁盘字节里的字段；执行程序必须先把磁盘上的
// 映像逐块拷贝进物理页帧，CPU 再从内存取指——没有任何数据"住在" JS 对象里。
//
// 这台操作系统装载在 hw/machine.ts 的机器上：机器出主存、盘位、控制台、硬件时钟
// 与总线，操作系统出引导、进程、文件系统与权限。两边只通过 MachineSoftware 接口
// 往来：机器每个时钟沿叫一次操作系统，块控制器放行用户态原始读写前问一次授权。

import { factoryAccounts, parsePasswd, serializePasswd } from './accounts'
import type { Account } from './accounts'
import {
  FS,
  lookupAbs,
  M_SETUID,
  MODE_DIR,
  MODE_FILE,
  sameGeometry,
  systemGeometry,
  T_DIR,
  T_FILE,
  UID_ROOT,
  VFS,
} from './fs'
import { ROOT_INO } from './ext2'
import { ASM_PROGRAMS } from './asmsrc'
import { GUEST_IDLE_SOURCE, GUEST_KERNEL_SOURCE } from './guestkernel'
import { GUEST_POLICY_SOURCE } from './guestpolicy'
import { OS_VERSION } from './version'
import { MAX_PROCS, PCB_BASE, PCB_SIZE, Process } from './process'
import type { VfsHooks } from './process'
import { buildRootImage } from './rootimg'
import { isErr, sys } from './types'
import type { BlkInfo, Err, Syscall } from './types'
import { deviceCode, deviceName } from '@/hw/disk'
import type { BlockDev } from '@/hw/disk'
import { Fault, NO_IRQ, runExe, VECTOR_TIMER, VECTOR_TTY } from '@/hw/cpu'
import type { CpuProgram, HwCall } from '@/hw/cpu'
import { assemble, disassemble, loadExe } from '@/hw/isa'
import { Machine } from '@/hw/machine'
import type { MachineSoftware } from '@/hw/machine'
import type { SegClass } from '@/hw/console'
import {
  DEVINFO_BASE,
  DEVINFO_SLOTS,
  DEVINFO_STRIDE,
  FRAME_COUNT,
  KERNEL_TEXT_FRAME,
  KERNEL_TEXT_PAGES,
  KMSG_BASE,
  KMSG_SIZE,
  PAGE_SIZE,
  RAM_SIZE,
  RESERVED_FRAME,
  RESERVED_FRAMES,
  USER_FRAME_START,
} from '@/hw/ram'

export const QUANTUM = 5
/** 不限速模式：一个时钟沿允许占用的宿主时间 */
const TURBO_BUDGET_MS = 6
const SLICES_PER_PUMP = 8
const KERNEL_STACK_VPN = 15
const KERNEL_TEXT_PFN = KERNEL_TEXT_FRAME
const KERNEL_TEXT_BASE = KERNEL_TEXT_PFN * PAGE_SIZE
// 挂载表：8 项 x 4 字节，CRX 内核的只读 VFS 靠它跨越挂载点
const KCB_MOUNTS = 0x00c0
const KCB_MOUNT_SLOTS = 8
const UTF8_ENCODER = new TextEncoder()

/** 系统盘的来源：开机时三选一 */
export type BootSource =
  // 这个浏览器里上次保存的 sda
  | { kind: 'stored' }
  // 用户提供的整盘镜像，几何必须与本机一致
  | { kind: 'image'; bytes: Uint8Array; filename: string }
  // 现做一张空盘，装上出厂目录树与 /bin
  | { kind: 'fresh' }

/**
 * 观测点：一个可选的通知口，只在有观察者（透明化面板）时才有内容。
 * 操作系统自己的接口，不依赖面板：没有挂观察者时一条追踪数据都不会产生。
 */
/**
 * 操作系统的观测口：任何前端都可以挂上来收事件，操作系统不关心它是不是面板。
 * 没有订阅者时一条事件都不发，系统照常运行。
 */
export interface KernelObserver {
  changed(): void
  syscall?(tick: number, pid: number, pname: string, call: Syscall, result: unknown, blocked: boolean): void
}

function* unloadedProgram(): CpuProgram {
  return
}

type ExecSpec = { entry: number }

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
const hexAddr = (n: number) => '0x' + n.toString(16).padStart(4, '0')

export class Kernel implements MachineSoftware {
  /** 这台操作系统跑着的机器：主存、盘位、控制台、硬件时钟都在里面 */
  readonly machine: Machine
  readonly vfs = new VFS()
  /** 操作系统自己那份视图：每台设备上的文件系统 */
  private readonly fss = new Map<string, FS>()
  private readonly procs = new Map<number, Process>()
  private readonly binErrors: string[] = []
  private kernelIvt = 0
  private nextPid = 0

  ticks = 0
  instructions = 0
  private currentPid = -1
  private lastPicked = -1
  private shellPid = -1
  private fgPid: number | null = null

  private readonly klog: { tick: number; msg: string }[] = []
  /** 可移动设备当前的挂载点：键是设备名，值是挂载路径 */
  private readonly mounts = new Map<string, string>()
  /** 只有真正启动过的机器才配落盘：没启动成的机器上面可能是坏镜像 */
  private booted = false
  private suppress = false // 批量执行时合并通知，避免每 tick 都唤醒观察者

  panic: string | null = null
  observer: KernelObserver | null = null

  constructor(machine = new Machine()) {
    this.machine = machine
    machine.attachSoftware(this)
  }

  // ---------- 时钟（前端旋钮 → 硬件时钟） ----------

  get hz(): number {
    return this.machine.hz
  }
  get turbo(): boolean {
    return this.machine.turbo
  }
  get paused(): boolean {
    return this.machine.paused
  }
  setSpeed(v: number | 'max') {
    this.machine.setSpeed(v)
    if (typeof v === 'number') this.machine.ram.setU16(0x0024, v)
    this.emit()
  }
  setPaused(paused: boolean) {
    this.machine.setPaused(paused)
    this.emit()
  }
  step() {
    this.machine.setPaused(true)
    this.tick()
  }

  // ---------- 装载在这台机器上（MachineSoftware） ----------

  /** 一个时钟沿。不限速模式把若干个时钟周期合成一批，中途不唤醒观察者。 */
  clockEdge(burst: boolean) {
    if (this.panic) return
    if (!burst) {
      this.tick()
      return
    }
    const t0 = performance.now()
    this.suppress = true
    try {
      do this.tick()
      while (!this.panic && performance.now() - t0 < TURBO_BUDGET_MS)
    } finally {
      this.suppress = false
    }
    this.emit()
  }

  clockFailed(error: unknown) {
    this.suppress = false
    this.setPanic(`host timer failure: ${(error as Error).message}`)
  }

  /** 用户态原始块读写（块控制器命令 1/2）的授权：只有 root 可以 */
  rawBlockIOAllowed(): boolean {
    return this.euidOf(this.currentPid) === UID_ROOT
  }

  // ---------- 引导 ----------

  /**
   * 启动。机器由装配层先造好（new Kernel(machine)），这里决定系统盘从哪来：
   * 可能来自浏览器的持久介质，也可能是用户选的 .img，两者都是异步的。
   *
   * 返回 null 表示机器已经跑起来；否则是给人的错误说明，此时机器尚未启动
   * （调用方应当留在启动菜单上）。
   */
  async boot(source: BootSource): Promise<string | null> {
    const stamp = (msg: string) => {
      this.ticks++
      this.log(msg, true)
    }
    stamp(`crados ${OS_VERSION} booting on browser/js`)
    stamp(`cpu: 1 core, timer interrupt ${this.machine.hz} Hz, round robin quantum ${QUANTUM}`)
    stamp(`mm: ${FRAME_COUNT} frames of ${PAGE_SIZE} B, ${RAM_SIZE / 1024} KiB`)

    if (!this.installGuestKernel()) {
      this.setPanic('cannot install CRX kernel trap page')
      return null
    }

    // sda：根盘（相当于 Windows 的 C 盘）。系统程序 /bin/* 也装在这块盘上，
    // 每次上电重新写入以保证与当前固件一致。
    const sda = this.machine.disks.insertSystem()
    const sdafs = this.attachFilesystem(sda)
    let restored = false
    if (source.kind === 'stored') {
      if (!(await this.machine.disks.restore(sda))) {
        return 'IndexedDB 里没有保存过系统盘：请改用 .img 文件，或新建空盘'
      }
      if (!sdafs.valid() || !sameGeometry(sdafs.layout(), systemGeometry())) {
        return 'IndexedDB 里的系统盘读不出来（格式或几何不符）：请改用 .img 文件，或新建空盘'
      }
      restored = true
      stamp('sda: restored from IndexedDB')
    } else if (source.kind === 'image') {
      // 系统盘就是固定容量：短于容量的镜像会让后面的块读成零，不如当场拒掉
      if (source.bytes.length !== sda.size) {
        return `${source.filename}: ${source.bytes.length} 字节，系统盘镜像必须是 ${sda.size} 字节`
      }
      sda.load(source.bytes)
      if (!sdafs.valid() || !sameGeometry(sdafs.layout(), systemGeometry())) {
        return `${source.filename}: 不是本机可用的 ext2 系统盘（魔数或盘上几何不符）`
      }
      stamp(`sda: image ${source.filename} loaded, ${source.bytes.length} bytes`)
    } else {
      const image = buildRootImage()
      sda.load(image.bytes)
      for (const e of image.errors) this.log(`rootfs image: ${e}`)
      stamp('sda: fresh disk created, factory system written')
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

    // 这台浏览器里存过的可移动盘逐个装回来；内容已失效就撤掉，避免留下读不出的空盘
    for (const media of await this.machine.disks.storedMedia()) {
      if (media.name === 'sda') continue
      const dev = this.machine.disks.insertStored(media.name)
      const fs = this.attachFilesystem(dev)
      if ((await this.machine.disks.restore(dev)) && fs.valid()) {
        stamp(`${media.name}: medium present, label "${fs.label()}"`)
        continue
      }
      this.forgetFilesystem(media.name)
    }

    // 系统盘立刻落盘：新建或导入的盘要成为 IndexedDB 里的新存档
    await this.machine.disks.save('sda')
    stamp('tty0: console ready, canonical mode with echo')

    if (this.binErrors.length) {
      this.panic = `program install failed: ${this.binErrors.join('; ')}`
      this.log(`Kernel panic - not syncing: ${this.panic}`, true)
      this.emit()
      return null
    }

    if (!this.startIdle()) {
      this.setPanic('cannot execute CRX idle process')
      return null
    }
    stamp(this.startInit())
    this.machine.startClock()
    this.booted = true
    this.emit()
    return null
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

  /** 给一块已经插上的盘建立操作系统的文件系统视图 */
  private attachFilesystem(dev: BlockDev): FS {
    const fs = new FS(dev)
    this.fss.set(dev.spec.name, fs)
    return fs
  }

  /** 撤掉一台设备：文件系统视图与盘位上的盘一起拔掉 */
  private forgetFilesystem(name: string): void {
    this.fss.delete(name)
    this.machine.disks.remove(name)
  }

  // 烧写 /bin：里面只接受汇编后的 CRX 映像
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
      this.machine.ram.zero(pfn)
      const chunk = image.subarray(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      this.machine.ram.bytes.set(chunk, pfn * PAGE_SIZE)
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

  // init 必须以 CRX 映像从 /bin/init 启动；不存在函数回退
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

  /** 停机：先灭硬件时钟，再把脏数据写进浏览器的持久介质。调用方无需等待写完。 */
  destroy(): Promise<void> {
    this.machine.stopClock()
    // 启动失败的机器不落盘：sda 上的字节可能就是那份被拒的镜像，
    // 写进去会把 IndexedDB 里好好存着的旧盘覆盖掉。
    if (!this.booted) return Promise.resolve()
    this.flush(true)
    return this.machine.disks.drain()
  }

  processes(): Process[] {
    return [...this.procs.values()]
  }
  filesystem(name: string): FS | undefined {
    return this.fss.get(name)
  }
  /** 这块盘上操作系统看到的设备信息（几何来自硬件，用量与挂载点来自操作系统） */
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
    return this.machine.ram.u16(0x002c) || this.fgPid
  }
  // ---------- 调度 ----------

  private tick() {
    if (this.panic) return
    this.ticks++

    // MAX 只增加 CPU cycle 吞吐。硬件 timer IRQ 由真实单调时间驱动，始终
    // 保持 hz 频率；sleep 和抢占因此不会随 MAX 加速。
    const nowMs = performance.now()
    const timerDue = this.machine.pollTimerInterrupt()

    for (const process of this.procs.values()) {
      if (process.state !== 'blocked' || process.sleepMode !== 2 || nowMs < process.wakeAt) continue
      process.sleepMode = 0
      process.wakeAt = 0
      process.state = 'ready'
    }

    let timerPending = timerDue
    const slices = this.machine.turbo ? 1 : SLICES_PER_PUMP
    for (let slice = 0; slice < slices && !this.panic; slice++) {
      const kCurrentPid = this.machine.ram.u16(0x0020)
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
          if (next !== cur) this.machine.ram.setU16(0x0026, this.machine.ram.u16(0x0026) + 1)
          next.state = 'running'
          this.currentPid = next.pid
          this.machine.ram.setU16(0x0020, next.pid)
          this.machine.ram.setU16(0x0022, next.slot)
          cur = next
        }
      }

      if (!cur) break
      if (cur.state !== 'running' && !midSwitch) break
      // 丢失唤醒补偿：输入可能在读端「查完 STATUS 为空、尚未置 readStdin」
      // 的间隙到达，那一拍的中断会被正在内核态的读端自己收走（永远不响应），
      // 或在扫描时读端还没挂上而被丢弃。只要还有输入且有进程阻塞在 stdin，
      // 就重新拉起 TTY 中断，让空闲进程再扫一次并唤醒它。
      if (!this.machine.console.irqPending && this.machine.console.hasInput) {
        for (const p of this.procs.values()) {
          if (p.state === 'blocked' && p.readStdin) {
            this.machine.console.raiseIrq()
            break
          }
        }
      }
      if (cur.cpu && cur.cpu.pendingIrq === NO_IRQ) {
        if (this.machine.console.irqPending) {
          cur.cpu.pendingIrq = VECTOR_TTY
          this.machine.console.takeIrq()
        } else if (timerPending) {
          cur.cpu.pendingIrq = VECTOR_TIMER
          timerPending = false
        }
      }

      let r: IteratorResult<HwCall, unknown>
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
      this.fgPid = this.machine.ram.u16(0x002c) || this.fgPid
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

    if (this.machine.disks.autosyncDue()) this.flush(false)
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
    const pfns = this.machine.ram.alloc(codePages + 2)
    if (!pfns) return { err: 'ENOMEM' }

    // 加载：磁盘映像逐页拷贝进物理帧，此后 CPU 只面向内存
    this.machine.ram.writeBytesPages(pfns.slice(0, codePages), image)
    const stackVpn = codePages
    const stackFrame = pfns[stackVpn]
    const kernelStackFrame = pfns[codePages + 1]
    // argv 区位于栈页起始处：argc 在 r1，argv 基地址在 r2，字符串以 NUL 分隔
    const argvText = args.length ? args.join('\0') + '\0' : ''
    this.machine.ram.writeAt(stackFrame * PAGE_SIZE, argvText)

    const env = parent ? { ...parent.env } : { USER: 'root', HOME: '/', PATH: '/bin:/usr/bin', SHELL: '/bin/sh' }
    const p = new Process(this.machine.ram, slot, unloadedProgram(), env, this.vfsHooks)
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
    p.gen = runExe(cpu, this.machine.busFor(p), (count) => {
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
      this.machine.ram.bytes[i] = i < banner.length ? banner.charCodeAt(i) : 0
    }
    this.machine.ram.setU16(0x0024, this.machine.hz)
    this.machine.ram.setU16(0x0030, this.kernelIvt)
    this.machine.ram.setU16(0x0032, this.procs.size)
    // 64 KiB 放不进 u16，这里记最后一个可寻址字节。mem 命令用的是真实字节数。
    this.machine.ram.setU16(0x0034, RAM_SIZE > 0xffff ? 0xffff : RAM_SIZE)
    this.machine.ram.setU16(0x0036, PAGE_SIZE)
    this.machine.ram.setU16(0x0038, PCB_BASE)
    this.machine.ram.setU16(0x003a, PCB_SIZE)
    this.machine.ram.setU16(0x003c, QUANTUM)
    this.machine.ram.setU16(0x003e, USER_FRAME_START) // first allocatable user PFN
    this.machine.ram.setU16(0x001e, KERNEL_TEXT_FRAME) // page_scan 的上界，标语区用不到这一字
    // ext2 几何：inode 表的字节偏移与 inode 总数。CRX 内核据此算 inode 偏移，
    // 但盘上结构仍然是它自己按字节解析的——宿主只发布事实。
    const root = this.fss.get('sda')
    const layout = root?.layout()
    this.machine.ram.setU16(0x004a, layout ? layout.inodeTableByte : 0)
    this.machine.ram.setU16(0x004c, layout ? layout.inodeCount : 0)
    this.writeMountTable()
    this.publishDevinfo()
  }

  // 把 VFS 挂载关系写成 CRX 内核能读的表：每项是宿主设备、挂载点在宿主上的
  // inode、被挂设备、被挂设备每块的扇区数。TypeScript 只登记，不替内核走路径。
  private writeMountTable() {
    this.machine.ram.bytes.fill(0, KCB_MOUNTS, KCB_MOUNTS + KCB_MOUNT_SLOTS * 4)
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
      this.machine.ram.bytes[at] = deviceCode(host.fs.dev.spec.name)
      this.machine.ram.bytes[at + 1] = ino
      this.machine.ram.bytes[at + 2] = deviceCode(m.fs.dev.spec.name)
      this.machine.ram.bytes[at + 3] = 0 // 保留：块控制器现在整块搬运，不再按 256 B 扇区寻址
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
    this.machine.ram.freeFrames(p.pageTable.map((pte) => pte.pfn))
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
    const b = this.machine.ram.bytes
    const dev = b[at] ?? 0
    const ino = b[at + 1] ?? 0
    const uid = this.machine.ram.u16(at + 2)
    const euid = this.machine.ram.u16(at + 4)
    const argc = this.machine.ram.u16(at + 6)
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
    const envLen = Math.min(80, this.machine.ram.u16(at + 184))
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
      this.machine.ram.bytes[created.base + 22] = cwdDev
      this.machine.ram.bytes[created.base + 23] = cwdIno
    }
    const argvLen = args.length ? args.join('\0').length + 1 : 0
    if (envBytes.length && argvLen + envBytes.length <= PAGE_SIZE) {
      const stackVpn = Math.max(1, Math.ceil(exe.image.length / PAGE_SIZE))
      const stack = created.pageTable.find((pte) => pte.vpn === stackVpn)
      if (stack) {
        this.machine.ram.bytes.set(envBytes, stack.pfn * PAGE_SIZE + argvLen)
        this.machine.ram.setU16(created.base + 10, stackVpn * PAGE_SIZE + argvLen)
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
      this.machine.ram.setU16(0x002c, created.pid)
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
      const hostDev = this.machine.ram.bytes[at]
      const hostIno = this.machine.ram.bytes[at + 1]
      const dev = this.machine.ram.bytes[at + 2]
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
      if (this.machine.disks.has(name)) void this.machine.disks.save(name)
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
    if (!src || !dst) return { err: 'ENOENT' }
    const built = assemble(src.read(srcIno))
    if (built.errors.length) {
      this.log(`as: ${built.errors[0]}`)
      return { err: 'EINVAL' }
    }
    const wr = dst.writeBytes(dstIno, built.bytes)
    if (isErr(wr)) return wr
    dst.setExec(dstIno, true)
    this.machine.disks.markDirty()
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
    this.machine.disks.markDirty()
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
    const uid = this.machine.ram.u16(at + 2)
    const acct = this.accountsOf().find((a) => a.uid === uid)
    if (!acct) return { err: 'ENOENT' }
    const home = acct.uid === UID_ROOT ? '/root' : `/home/${acct.name}`
    const env = `USER\0${acct.name}\0HOME\0${home}\0PATH\0/bin:/usr/bin\0SHELL\0/bin/sh\0`
    const bytes = UTF8_ENCODER.encode(env)
    if (bytes.length > 80) return { err: 'E2BIG' }
    this.machine.ram.bytes.set(bytes, at + 186)
    this.machine.ram.setU16(at + 184, bytes.length)
    const fs = this.fss.get('sda')
    const ino = fs ? lookupAbs(fs, home) : 0
    if (fs && ino && fs.itype(ino) === T_DIR) {
      this.machine.ram.bytes[at + 266] = 1
      this.machine.ram.bytes[at + 267] = ino
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
    return !!fs && sameGeometry(fs.layout(), systemGeometry())
  }

  private fsOf(name: string): FS {
    return this.fss.get(name)!
  }

  /**
   * 把每台设备的脏分块排进落盘队列（不等待）。sync 块命令、自动回写、
   * 停机与 panic 都走这里；真正"哪些分块变了"由盘位判断。
   */
  private flush(quiet: boolean): number {
    let blocks = 0
    for (const name of this.machine.disks.names()) {
      const fs = this.fss.get(name)
      if (fs) blocks += fs.usedBlocks()
    }
    this.machine.disks.flush()
    if (!quiet) this.log(`sync: ${blocks} block(s) written to persistent store`)
    return blocks
  }

  private blkInfo(): BlkInfo[] {
    return this.machine.disks.names().map((name) => {
      const dev = this.machine.disks.get(name)!
      const fs = this.fsOf(name)
      const used = fs.valid() ? fs.usedBlocks() : 0
      const mount = name === 'sda' ? '/' : (this.mounts.get(name) ?? null)
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
        persistent: this.machine.disks.storageReady,
      }
    })
  }

  // ---------- 设备管理（介质动作问盘位，mkfs 与挂载检查归操作系统） ----------

  /** 插一块新盘并格式化出文件系统；相当于把空盘装进机器再 mkfs */
  async attachDisk(label = 'disk'): Promise<Err | 0> {
    const dev = this.machine.disks.insertBlank()
    if (!dev) return { err: 'ENOSPC' }
    const name = dev.spec.name
    this.attachFilesystem(dev).format(label)
    await this.machine.disks.save(name)
    this.log(`${name}: attached, mkfs done, label "${label}"`)
    this.emit()
    return 0
  }

  /** 拔盘。挂载着的盘不给拔：先 umount。 */
  async detachDisk(name: string): Promise<Err | 0> {
    if (!this.machine.disks.has(name) || name === 'sda') return { err: 'ENODEV' }
    if (this.mounts.has(name)) return { err: 'EBUSY' }
    this.forgetFilesystem(name)
    await this.machine.disks.drain()
    this.log(`${name}: detached`)
    this.emit()
    return 0
  }

  // 导入镜像：每次都占用一个新的 sdX，不覆盖已有设备
  async importDisk(raw: Uint8Array, filename: string): Promise<Err | 0> {
    const dev = this.machine.disks.insertImage(raw)
    if (!dev) return { err: 'ENOSPC' }
    const name = dev.spec.name
    const fs = this.attachFilesystem(dev)
    if (!fs.valid() || !this.geometryOk(name)) {
      this.forgetFilesystem(name)
      return { err: 'EINVAL' }
    }
    await this.machine.disks.save(name)
    this.log(`${name}: image ${filename} loaded, ${fs.usedInodes()} inodes, label "${fs.label()}"`)
    this.emit()
    return 0
  }

  async formatDisk(name: string): Promise<Err | 0> {
    if (!this.machine.disks.has(name) || name === 'sda') return { err: 'ENODEV' }
    if (this.mounts.has(name)) return { err: 'EBUSY' }
    const fs = this.fsOf(name)
    fs.format(fs.label() || name)
    await this.machine.disks.save(name)
    this.log(`${name}: mkfs complete, all data blocks free`)
    this.emit()
    return 0
  }

  // ---------- 系统调用 ----------

  /**
   * CRX 内核（supervisor 态的机器码）通过 svc 指令陷出来，r0 是号，r1..r3 是参数。
   * 号段是这台机器与操作系统之间的约定：
   *   3  exit(code)                 9 号以下沿用 Unix 传统号
   *   22 kill(pid, sig)
   *   40 hwexec(spawn_req)          创建进程（宿主只负责装载已授权的那份映像）
   *   41 hwreap(pid)                回收 PCB 槽位
   *   42 hwmount()                  按客户内核的挂载表重建宿主挂载视图
   *   43 hwacct(op, arg)            账户与权限（/etc/passwd 的解析在宿主）
   *   44 hwassemble(dev:ino → dev:ino)  汇编器（工具链）
   *   45 hwdisasm(dev:ino, buf)     反汇编器（工具链）
   * 号不对就是致命错误：与真正 CPU 上的非法系统调用一样，报给上层的是 Fault。
   */
  private hypercall(p: Process, num: number, a1: number, a2: number): Syscall | null {
    switch (num) {
      case 3:
        return sys.exit(a1)
      case 22:
        return sys.kill(a1, a2 || 15)
      case 40:
        return { call: 'hwexec', at: a1 }
      case 41:
        return { call: 'hwreap', pid: a1 }
      case 42:
        return { call: 'hwmount' }
      case 43:
        return { call: 'hwacct', op: a1, arg: a2 }
      case 44: {
        const bus = this.machine.busFor(p)
        return {
          call: 'hwassemble',
          srcDev: bus.read(a1),
          srcIno: bus.read(a1 + 1),
          dstDev: bus.read(a1 + 2),
          dstIno: bus.read(a1 + 3),
        }
      }
      case 45:
        return { call: 'hwdisasm', at: a1 }
      default:
        return null
    }
  }

  /** CPU 陷出：yield 让出时间片，halt 是停机，svc 交给上面那张表 */
  private dispatch(p: Process, trap: HwCall) {
    if (trap.call === 'yield') return
    if (trap.call === 'halt') {
      this.observer?.syscall?.(this.ticks, p.pid, p.name, sys.exit(trap.code), undefined, false)
      this.doExit(p, trap.code)
      return
    }
    const sc = this.hypercall(p, trap.num, trap.a1, trap.a2)
    if (!sc) throw new Fault((p.cpu?.pc ?? 0) - 4, `unknown system call ${trap.num}`)
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
    const dev = this.machine.ram.bytes[at] ?? 0
    const ino = this.machine.ram.bytes[at + 1] ?? 0
    const buf = this.machine.ram.u16(at + 2)
    const pathVa = this.machine.ram.u16(at + 4)
    const fs = this.fss.get(deviceName(dev))
    if (!fs || !fs.inodeUsed(ino) || fs.itype(ino) !== T_FILE) return { err: 'ENOENT' }
    const exe = loadExe(String.fromCharCode(...fs.readBytes(ino)))
    if (!exe) return { err: 'ENOEXEC' }
    const bus = this.machine.busFor(p)
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

  // ---------- 终端（tty 行规：操作系统决定谁能收信号，屏幕与键盘在控制台设备里） ----------

  typeChar(ch: string) {
    if (this.panic) return
    this.machine.console.key(ch)
    this.emit()
  }

  pressEnter() {
    if (this.panic) return
    this.machine.console.enter()
    this.emit()
  }

  pressBackspace() {
    if (this.panic) return
    this.machine.console.backspace()
    this.emit()
  }

  pressCtrlD() {
    if (this.panic) return
    this.machine.console.eof()
    this.emit()
  }

  private maySignalFg(fg: Process, shell: Process): boolean {
    if (!(fg.pid > 1 && fg.pid !== this.shellPid && fg.state !== 'zombie')) return false
    if (shell.euid === UID_ROOT || fg.euid === shell.euid || fg.uid === shell.euid) return true
    // gp_may_signal 的镜像：带 k 权限的账户可以向别的账户的进程发信号
    const acct = this.accountsOf().find((a) => a.uid === shell.euid)
    return !!acct && acct.perms.includes('k')
  }

  /** Ctrl-C：能把前台进程杀掉就杀，杀不动就交一个空行让 shell 重画提示符 */
  pressCtrlC() {
    if (this.panic) return
    this.machine.console.write('^C\n', 'err')
    this.machine.console.discardLine()
    const fgPid = this.foregroundPid
    const fg = fgPid !== null ? this.procs.get(fgPid) : undefined
    const shell = this.procs.get(this.shellPid)
    const allowed = fg !== undefined && shell !== undefined && this.maySignalFg(fg, shell)
    if (allowed) this.killSig(fg, 2)
    else this.machine.console.pushEmptyLine()
    this.emit()
  }

  pressCtrlL() {
    this.machine.console.clear()
    this.emit()
  }

  private conWrite(text: string, cls: SegClass) {
    this.machine.console.write(text, cls)
  }

  private log(msg: string, toConsole = false) {
    this.klog.push({ tick: this.ticks, msg })
    if (this.klog.length > 400) this.klog.shift()
    const line = `[${(this.ticks / this.machine.hz).toFixed(4).padStart(9)}] ${msg}\n`
    this.appendKmsg(line)
    if (toConsole) this.conWrite(line, 'sys')
  }

  // The guest prints dmesg from this buffer. The host only records events.
  private appendKmsg(text: string) {
    const base = KMSG_BASE
    const max = KMSG_SIZE - 2
    const extra = UTF8_ENCODER.encode(text)
    let len = this.machine.ram.u16(base)
    if (len > max) len = 0
    while (len + extra.length > max && len > 0) {
      let i = 0
      while (i < len && this.machine.ram.bytes[base + 2 + i] !== 10) i++
      const cut = i < len ? i + 1 : len
      this.machine.ram.bytes.copyWithin(base + 2, base + 2 + cut, base + 2 + len)
      len -= cut
    }
    const n = Math.min(extra.length, Math.max(0, max - len))
    if (n > 0) this.machine.ram.bytes.set(extra.subarray(0, n), base + 2 + len)
    this.machine.ram.setU16(base, len + n)
  }

  // Hardware facts for the merged lsblk views (-a/-d/-f). CRX formats the text;
  // this only fills the table.
  // Record: present, removable, name[3], bs_len, model[17], bs[4], size[8],
  // used[7], pct, blocks u16, usedBlocks u16, mount[16].
  private publishDevinfo() {
    for (let pfn = RESERVED_FRAME; pfn < RESERVED_FRAME + RESERVED_FRAMES; pfn++) this.machine.ram.hold(pfn)
    const base = DEVINFO_BASE
    this.machine.ram.bytes.fill(0, base, base + DEVINFO_SLOTS * DEVINFO_STRIDE)
    let slot = 0
    for (const d of this.blkInfo()) {
      if (slot >= DEVINFO_SLOTS) break
      const at = base + slot++ * DEVINFO_STRIDE
      const b = this.machine.ram.bytes
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
      this.machine.ram.setU16(at + 43, d.blocks)
      this.machine.ram.setU16(at + 45, d.usedBlocks)
      const mount = d.present ? (d.mountpoint ?? '-') : '(no medium)'
      for (let i = 0; i < mount.length && i < 16; i++) b[at + 47 + i] = mount.charCodeAt(i)
    }
  }

  private kmsgLines(): string[] {
    return this.klog.map((e) => `[${(e.tick / this.machine.hz).toFixed(4).padStart(9)}] ${e.msg}`)
  }

  private emit() {
    if (this.suppress) return
    this.observer?.changed()
  }
}
