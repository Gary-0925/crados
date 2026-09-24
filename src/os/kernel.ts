// crados 内核：时钟中断驱动的轮转调度、系统调用分发、真实块设备与内存管理
//
// 存储的真相只有两处：BlockDev 的字节数组（磁盘）与 Memory 的字节数组（内存条）。
// 文件系统的目录、inode、位图都是磁盘字节里的字段；执行程序必须先把磁盘上的
// 映像逐块拷贝进物理页帧，CPU 再从内存取指--没有任何数据"住在" JS 对象里。

import { BlockDev, downloadDev, dropDev, loadDev, saveDev, SPECS } from './blockdev'
import { basename, CRFS, dirname, normalizePath, T_DEV, T_DIR, T_FILE, VFS } from './fs'
import type { FNode } from './fs'
import { FRAME_COUNT, KERNEL_FRAMES, Memory, PAGE_SIZE, RAM_SIZE } from './memory'
import type { Frame } from './memory'
import { assemble, disassemble, isExecutable, loadExe } from './isa'
import { ASM_PROGRAMS } from './asmsrc'
import { Fault, runExe } from './vm'
import type { Bus, CpuState } from './vm'
import { DEV_CODE, DEV_NAME, MAX_PROCS, PCB_BASE, PCB_SIZE, Process } from './process'
import type { PTE, VfsHooks } from './process'
import { COUNT_S, HELLO_S, MAN_ASM, MAN_INSPECT, MAN_SCRIPT, MAN_STORAGE, MOTD, README } from './rootfs'
import { isErr } from './types'
import type { BlkInfo, Err, Gen, Mode, ProcInfo, PState, Syscall } from './types'

export const QUANTUM = 5
const AUTOSYNC_MS = 1000 // 脏数据自动回写间隔，按真实时间计而非 tick
const TURBO_BUDGET_MS = 6 // 不限速模式每帧允许占用的时间
const DRV_TTY = 1
const DRV_NULL = 2

export type SegClass = 'out' | 'err' | 'sys' | 'echo'
export interface Seg {
  t: string
  c: SegClass
}
export interface Line {
  segs: Seg[]
}
export interface SysEntry {
  tick: number
  pid: number
  pname: string
  text: string
  ret: string
  err: boolean
}
export interface ProcRow {
  pid: number
  ppid: number
  name: string
  cmd: string
  state: PState
  pc: number
  sp: number
  ax: number
  pages: number
  ticksUsed: number
  cwd: string
  children: number[]
  exitCode: number | null
  waitDesc: string | null
  pts: PTE[]
  fds: string[]
}
export interface FSNode {
  ino: number
  name: string
  type: 'dir' | 'file' | 'dev'
  size: number
  blocks: number
  exec: boolean
  disk: string
  path: string
  data?: string
  disasm?: string[]
  blockList?: number[]
  kids: FSNode[]
}
export interface BlockCell {
  no: number
  kind: string
  label: string
}
export interface DiskView {
  bytes: Uint8Array
  map: BlockCell[]
  blockSize: number
}
export interface Snapshot {
  ticks: number
  hz: number
  paused: boolean
  mode: Mode
  currentPid: number
  switches: number
  quantum: number
  procs: ProcRow[]
  frames: Frame[]
  mem: { total: number; used: number; free: number; framesUsed: number }
  tree: FSNode
  fs: { max: number; used: number; bytes: number }
  disks: BlkInfo[]
  usbLabel: string
  storageOk: boolean
  dirty: boolean
  lastSync: number
  turbo: boolean
  tps: number
  trace: SysEntry[]
  kmsgText: string[]
  lines: Line[]
  fgPid: number | null
  shellPid: number
  panic: string | null
}

function* idleGen(): Gen {
  while (true) yield { call: 'yield' }
}

// 内核线程由宿主生成器承载；所有用户进程一律是 CRX 机器码
type ExecSpec = { kind: 'kernel'; gen: Gen } | { kind: 'exe'; entry: number }

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
  private nextPid = 0

  ticks = 0
  hz = 20
  paused = false
  mode: Mode = 'kernel'
  private currentPid = -1
  private lastPicked = -1
  private switches = 0
  private shellPid = -1
  private fgPid: number | null = null

  private lines: Line[] = []
  private lineBuf = ''
  private lineQueue: (string | null)[] = []
  private readonly trace: SysEntry[] = []
  private readonly klog: { tick: number; msg: string }[] = []

  private usbPresent = false
  private usbMount: string | null = null
  private dirty = false
  private lastSync = 0
  private lastSyncMs = 0
  private storageOk = true
  private persist = true

  turbo = false
  private suppress = false // 批量执行时抑制快照生成
  private tps = 0
  private tpsAt = 0
  private tpsTicks = 0

  panic: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly listeners = new Set<() => void>()
  private snap!: Snapshot

  constructor() {
    this.boot()
  }

  // ---------- 引导 ----------

  private boot() {
    const stamp = (msg: string) => {
      this.ticks++
      this.log(msg, true)
    }
    stamp('crados 1.0 booting on browser/js')
    stamp(`cpu: 1 core, timer interrupt ${this.hz} Hz, round robin quantum ${QUANTUM}`)
    stamp(`mm: ${FRAME_COUNT} frames of ${PAGE_SIZE} B, ${KERNEL_FRAMES} reserved for the kernel`)

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
      sdafs.format('crados-root')
      this.buildRootTree(sdafs)
    }
    this.vfs.umount('/')
    this.vfs.mount('/', sdafs)
    this.vfs.mount('/bin', romfs)
    stamp(
      restored
        ? `sda: superblock valid, ${sdafs.usedInodes()} inodes, ${sdafs.usedBlocks()}/${sda.blockCount} blocks in use`
        : `sda: no valid superblock, mkfs done on ${sda.blockCount} blocks`,
    )
    stamp('vfs: mounted /dev/sda on /, /dev/rom on /bin')

    const sdb = this.makeDev('sdb')
    if (loadDev(sdb) && this.fss.get('sdb')!.valid()) {
      this.usbPresent = true
      stamp(`sdb: removable medium present, label "${this.fss.get('sdb')!.label()}"`)
    }

    this.storageOk = this.persist ? saveDev(sda) : false
    stamp('tty0: console ready, canonical mode with echo')

    if (this.romErrors.length) {
      this.panic = `ROM build failed: ${this.romErrors.join('; ')}`
      this.log(`Kernel panic - not syncing: ${this.panic}`, true)
      this.emit()
      return
    }

    this.spawnKernelThread('idle', '[idle]', idleGen())
    stamp(this.startInit())
    this.startTimer()
    this.emit()
  }

  // 供 PCB 使用：工作目录以 (设备号, inode 号) 落在内存里，路径靠 parent 链回溯
  private readonly vfsHooks: VfsHooks = {
    pathOf: (dev, ino) => {
      const fs = this.fss.get(DEV_NAME[dev] ?? 'sda')
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
      if ('err' in node) return { dev: DEV_CODE.sda, ino: 1 }
      return { dev: DEV_CODE[node.dev.spec.name] ?? DEV_CODE.sda, ino: node.ino }
    },
  }

  private makeDev(name: string): BlockDev {
    const dev = new BlockDev(SPECS[name])
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
      compiled++
    }
    return compiled
  }

  private buildRootTree(fs: CRFS) {
    const mkdir = (parent: number, name: string): number => {
      const r = fs.create(parent, name, T_DIR)
      return typeof r === 'number' ? r : 0
    }
    const put = (parent: number, name: string, text: string, exec = false) => {
      const ino = fs.create(parent, name, T_FILE)
      if (typeof ino !== 'number') return
      fs.write(ino, text)
      if (exec) fs.setExec(ino, true)
    }
    mkdir(1, 'bin') // /bin 是 ROM 的挂载点
    const etc = mkdir(1, 'etc')
    const dev = mkdir(1, 'dev')
    const usr = mkdir(1, 'usr')
    mkdir(usr, 'bin')
    mkdir(1, 'mnt')
    mkdir(1, 'tmp')
    const home = mkdir(1, 'home')
    const user = mkdir(home, 'user')

    put(etc, 'motd', MOTD)
    put(user, 'README', README)
    put(user, 'asm.7', MAN_ASM)
    put(user, 'storage.7', MAN_STORAGE)
    put(user, 'script.7', MAN_SCRIPT)
    put(user, 'inspect.7', MAN_INSPECT)
    put(user, 'hello.s', HELLO_S)
    put(user, 'count.s', COUNT_S)

    for (const [name, drv] of [
      ['tty', DRV_TTY],
      ['null', DRV_NULL],
    ] as const) {
      const ino = fs.create(dev, name, T_DEV)
      if (typeof ino === 'number') fs.setDriver(ino, drv)
    }
  }

  private spawnKernelThread(name: string, cmd: string, gen: Gen) {
    this.exec(null, name, cmd, [], { kind: 'kernel', gen }, new Uint8Array(0))
  }

  // init 必须从 ROM 以 CRX 映像启动；不存在函数回退
  private startInit(): string {
    const node = this.vfs.resolve('/bin/init', '/')
    if (!('err' in node)) {
      const image = this.vfs.fsOf(node).readBytes(node.ino)
      const exe = loadExe(String.fromCharCode(...image))
      if (exe) {
        const r = this.exec(null, 'init', '/bin/init', [], { kind: 'exe', entry: exe.entry }, exe.image)
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
          console.error('[crados] tick fault', e)
        }
      },
      this.turbo ? 0 : 1000 / this.hz,
    )
  }

  setSpeed(v: number | 'max') {
    this.turbo = v === 'max'
    if (typeof v === 'number') this.hz = v
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
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getSnapshot = (): Snapshot => this.snap

  // ---------- 调度 ----------

  private tick() {
    if (this.panic) return
    this.ticks++
    this.mode = 'kernel'

    for (const p of this.procs.values()) {
      if (p.state === 'blocked' && p.wakeAt > 0 && p.wakeAt <= this.ticks) {
        p.wakeAt = 0
        p.state = 'ready'
      }
    }

    let cur = this.procs.get(this.currentPid) ?? null
    if (!cur || cur.state !== 'running' || cur.stepsInSlice >= QUANTUM || cur.pid === 0) {
      const next = this.pick()
      if (next) {
        if (cur && cur.state === 'running') cur.state = 'ready'
        if (next !== cur) this.switches++
        next.state = 'running'
        next.stepsInSlice = 0
        this.currentPid = next.pid
        cur = next
      }
    }

    if (cur && cur.state === 'running') {
      cur.ticksUsed++
      cur.stepsInSlice++
      if (!cur.cpu) cur.regs.pc++
      this.mode = 'user'
      let r: IteratorResult<Syscall, unknown>
      try {
        r = cur.gen.next(cur.pending)
      } catch (e) {
        const msg = e instanceof Fault ? e.message : (e as Error).message
        this.log(`trap: pid ${cur.pid} (${cur.name}) ${msg}`)
        this.doExit(cur, 139)
        this.emit()
        return
      }
      cur.pending = undefined
      this.mode = 'kernel'
      if (cur.cpu) {
        cur.regs.pc = cur.cpu.pc
        cur.regs.sp = cur.cpu.sp
        cur.regs.ax = cur.cpu.regs[0]
      }
      if (r.done) this.doExit(cur, 0)
      else this.dispatch(cur, r.value)
    }

    if (this.dirty && Date.now() - this.lastSyncMs >= AUTOSYNC_MS) this.flush(false)
    this.writeKernelTables()
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

  private makeBus(pfns: number[]): Bus {
    const mem = this.mem
    const translate = (va: number): number => {
      const vpn = va >>> 8
      if (va < 0 || vpn >= pfns.length) throw new Fault(va, 'page fault')
      return pfns[vpn] * PAGE_SIZE + (va & 0xff)
    }
    return {
      limit: pfns.length * PAGE_SIZE,
      read: (va) => mem.bytes[translate(va)],
      write: (va, b) => {
        mem.bytes[translate(va)] = b & 0xff
      },
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
  ): Process | Err {
    const slot = this.freeSlot()
    if (slot < 0) return { err: 'EAGAIN' }
    const pid = this.nextPid++
    const codePages = Math.max(1, Math.ceil(image.length / PAGE_SIZE))
    const segs = [...Array<string>(codePages).fill('text'), 'heap', 'stack']
    const pfns = this.mem.alloc(pid, segs)
    if (!pfns) return { err: 'ENOMEM' }

    // 加载：磁盘映像逐页拷贝进物理帧，此后 CPU 只面向内存
    this.mem.writeBytesPages(pfns.slice(0, codePages), image)
    const stackVpn = pfns.length - 1
    const stackFrame = pfns[stackVpn]
    // argv 区位于栈页起始处：argc 在 r1，argv 基地址在 r2，字符串以 NUL 分隔
    const argvText = args.length ? args.join('\0') + '\0' : ''
    this.mem.writeAt(stackFrame * PAGE_SIZE, spec.kind === 'kernel' ? `kernel-thread=${name}\npid=${pid}\n` : argvText)

    const env = parent ? { ...parent.env } : { USER: 'root', HOME: '/', PATH: '/usr/bin:/bin', SHELL: '/bin/sh' }
    let gen: Gen
    let cpu: CpuState | null = null
    if (spec.kind === 'kernel') {
      gen = spec.gen
    } else {
      cpu = {
        regs: new Uint16Array(8),
        pc: spec.entry,
        sp: pfns.length * PAGE_SIZE - 2,
        flag: 0,
        halted: false,
      }
      cpu.regs[1] = args.length
      cpu.regs[2] = stackVpn * PAGE_SIZE
      gen = runExe(cpu, this.makeBus(pfns))
    }

    const p = new Process(this.mem, slot, gen, env, this.vfsHooks)
    p.init(pid, parent ? parent.pid : 0, name, cmd, parent ? parent.cwd : '/')
    p.cpu = cpu
    p.pageTable = pfns.map((pfn, vpn) => ({ vpn, pfn, seg: segs[vpn] }))
    p.regs.sp = cpu ? cpu.sp : stackFrame * PAGE_SIZE + PAGE_SIZE - 1
    p.regs.bp = p.regs.sp
    if (cpu) p.regs.pc = cpu.pc

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

  // 帧 0 是引导记录；帧 1..4 是 PCB 表，由 Process 直接读写，内核不得覆盖
  private writeKernelTables() {
    this.mem.zero(0)
    this.mem.writeAt(
      0,
      `crados 1.0 \nram=${RAM_SIZE} pagesize=${PAGE_SIZE} frames=${FRAME_COUNT}\n` +
        `quantum=${QUANTUM} hz=${this.hz} tick=${this.ticks} nproc=${this.procs.size}\n` +
        `pcb base=${PCB_BASE} size=${PCB_SIZE} slots=${MAX_PROCS}\n`,
    )
  }

  private doExit(p: Process, code: number) {
    p.state = 'zombie'
    p.exitCode = code
    p.wakeAt = 0
    p.readStdin = false
    p.waitFor = null
    this.mem.freePid(p.pid)
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
    if (p.pid <= 1) return
    const name = sig === 2 ? 'SIGINT' : sig === 9 ? 'SIGKILL' : sig === 15 ? 'SIGTERM' : `signal ${sig}`
    this.log(`signal: pid ${p.pid} (${p.name}) terminated by ${name}`)
    this.doExit(p, 128 + sig)
  }

  private killInit() {
    const init = this.procs.get(1)
    if (init) this.doExit(init, 0x8f)
    this.setPanic('Attempted to kill init! exitcode=0x0000008f')
  }

  private setPanic(msg: string) {
    this.panic = msg
    this.mode = 'kernel'
    this.log(`Kernel panic - not syncing: ${msg}`, true)
    this.flush(true)
    this.emit()
  }

  // ---------- 设备与持久化 ----------

  private fsOf(name: string): CRFS {
    return this.fss.get(name)!
  }

  private flush(quiet: boolean): number {
    let blocks = 0
    let ok = true
    for (const name of ['sda', 'sdb']) {
      if (name === 'sdb' && !this.usbPresent) continue
      const fs = this.fsOf(name)
      blocks += fs.usedBlocks()
      ok = (this.persist ? saveDev(this.devs.get(name)!) : false) && ok
    }
    this.storageOk = ok
    this.dirty = false
    this.lastSync = this.ticks
    this.lastSyncMs = Date.now()
    if (!quiet) this.log(`sync: ${blocks} block(s) written to persistent store`)
    return blocks
  }

  private sysMount(dev: string, dir: string, cwd: string): Err | 0 {
    if (basename(dev) !== 'sdb') return { err: 'ENODEV' }
    if (!this.usbPresent) return { err: 'ENODEV' }
    if (this.usbMount) return { err: 'EBUSY' }
    const target = this.vfs.resolve(dir, cwd)
    if ('err' in target) return { err: target.err }
    if (target.type !== T_DIR) return { err: 'ENOTDIR' }
    const fs = this.fsOf('sdb')
    if (!fs.valid()) return { err: 'EINVAL' }
    const abs = normalizePath(dir, cwd)
    this.vfs.mount(abs, fs)
    this.usbMount = abs
    this.log(`sdb: mounted on ${abs}, label "${fs.label()}", ${fs.usedBlocks()} blocks in use`)
    return 0
  }

  private sysUmount(target: string, cwd: string): Err | 0 {
    const abs = basename(target) === 'sdb' ? this.usbMount : normalizePath(target, cwd)
    if (!this.usbMount || abs !== this.usbMount) return { err: 'EINVAL' }
    for (const p of this.procs.values())
      if (p.state !== 'zombie' && p.cwd.startsWith(this.usbMount)) return { err: 'EBUSY' }
    this.vfs.umount(this.usbMount)
    if (this.persist) saveDev(this.devs.get('sdb')!)
    this.log(`sdb: unmounted from ${this.usbMount}`)
    this.usbMount = null
    return 0
  }

  private blkInfo(): BlkInfo[] {
    const row = (name: string, mount: string | null, present: boolean): BlkInfo => {
      const dev = this.devs.get(name)!
      const fs = this.fsOf(name)
      const used = present && fs.valid() ? fs.usedBlocks() : 0
      return {
        name,
        model: dev.spec.model,
        size: dev.size,
        used: used * dev.blockSize,
        blocks: dev.blockCount,
        usedBlocks: used,
        blockSize: dev.blockSize,
        removable: dev.spec.removable,
        present,
        mountpoint: mount,
        persistent: this.storageOk,
      }
    }
    return [row('sda', '/', true), row('sdb', this.usbMount, this.usbPresent), row('rom', '/bin', true)]
  }

  // ---------- UI 存储操作 ----------

  attachUsb(label = 'usb'): Err | 0 {
    if (this.usbPresent) return { err: 'EBUSY' }
    this.fsOf('sdb').format(label)
    this.usbPresent = true
    if (this.persist) saveDev(this.devs.get('sdb')!)
    this.log(`usb-storage: /dev/sdb attached, mkfs done, label "${label}"`)
    this.emit()
    return 0
  }

  detachUsb(): Err | 0 {
    if (!this.usbPresent) return { err: 'ENODEV' }
    if (this.usbMount) return { err: 'EBUSY' }
    this.usbPresent = false
    this.devs.get('sdb')!.bytes.fill(0)
    dropDev('sdb')
    this.log('usb-storage: /dev/sdb detached')
    this.emit()
    return 0
  }

  exportUsb(): Err | 0 {
    if (!this.usbPresent) return { err: 'ENODEV' }
    const dev = this.devs.get('sdb')!
    downloadDev(dev, `${this.fsOf('sdb').label() || 'usb'}.img`)
    this.log(`sdb: raw image of ${dev.size} bytes written to host`)
    this.emit()
    return 0
  }

  importUsb(raw: Uint8Array, filename: string): Err | 0 {
    if (this.usbMount) return { err: 'EBUSY' }
    const dev = this.devs.get('sdb')!
    if (raw.length > dev.size) return { err: 'ENOSPC' }
    dev.load(raw)
    const fs = this.fsOf('sdb')
    if (!fs.valid()) {
      dev.bytes.fill(0)
      return { err: 'EINVAL' }
    }
    this.usbPresent = true
    if (this.persist) saveDev(dev)
    this.log(`usb-storage: image ${filename} loaded, ${fs.usedInodes()} inodes, label "${fs.label()}"`)
    this.emit()
    return 0
  }

  formatUsb(): Err | 0 {
    if (this.usbMount) return { err: 'EBUSY' }
    if (!this.usbPresent) return { err: 'ENODEV' }
    const fs = this.fsOf('sdb')
    fs.format(fs.label() || 'usb')
    if (this.persist) saveDev(this.devs.get('sdb')!)
    this.log('sdb: mkfs complete, all data blocks free')
    this.emit()
    return 0
  }

  wipeRoot() {
    this.persist = false
    this.storageOk = false
    dropDev('sda')
    dropDev('sdb')
    this.log('sda: persistent store cleared, writes are volatile until reboot')
    this.emit()
  }

  // ---------- 窥探接口 ----------

  ramBytes(): Uint8Array {
    return this.mem.bytes
  }

  frameOwnerLabel(pfn: number): string {
    const f = this.mem.frames[pfn]
    if (!f) return 'invalid frame'
    if (f.owner === null) return 'free'
    if (f.owner === 'kernel') return pfn === 0 ? 'kernel: boot record' : 'kernel: process table'
    const p = this.procs.get(f.owner)
    return `pid ${f.owner} (${p?.name ?? 'gone'}) ${f.seg} segment`
  }

  diskLayout(name: string): DiskView | null {
    const dev = this.devs.get(name)
    if (!dev) return null
    if (name === 'sdb' && !this.usbPresent) return null
    return { bytes: dev.bytes, map: this.fsOf(name).blockMap(), blockSize: dev.blockSize }
  }

  // ---------- 系统调用 ----------

  private dispatch(p: Process, sc: Syscall) {
    if (sc.call === 'yield') return
    const entry: SysEntry = { tick: this.ticks, pid: p.pid, pname: p.name, text: '', ret: '…', err: false }
    let result: unknown = 0
    let blocked = false

    switch (sc.call) {
      case 'write':
        entry.text = `write(${sc.fd}, ${JSON.stringify(clip(sc.data, 18))})`
        result = this.sysWrite(p, sc.fd, sc.data)
        break
      case 'read': {
        entry.text = `read(${sc.fd}${sc.len ? `, ${sc.len}` : ''})`
        const r = this.sysRead(p, sc.fd, sc.len)
        if (r === undefined) blocked = true
        else result = r
        break
      }
      case 'open':
        entry.text = `open("${sc.path}", ${sc.flags})`
        result = this.sysOpen(p, sc.path, sc.flags)
        break
      case 'close':
        entry.text = `close(${sc.fd})`
        result = p.fds.delete(sc.fd) ? 0 : { err: 'EBADF' }
        break
      case 'dup':
        entry.text = `dup(${sc.fd})`
        result = this.sysDup(p, sc.fd, -1)
        break
      case 'dup2':
        entry.text = `dup2(${sc.from}, ${sc.to})`
        result = this.sysDup(p, sc.from, sc.to)
        break
      case 'readdir': {
        entry.text = `getdents("${sc.path}")`
        const node = this.vfs.resolve(sc.path, p.cwd)
        if ('err' in node) result = { err: node.err }
        else if (node.type !== T_DIR) result = { err: 'ENOTDIR' }
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
        entry.text = `stat("${sc.path}")`
        const node = this.vfs.resolve(sc.path, p.cwd)
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
        entry.text = `mkdir("${sc.path}")`
        result = this.sysCreate(p, sc.path, T_DIR)
        break
      case 'unlink':
        entry.text = `unlink("${sc.path}")`
        result = this.sysUnlink(p, sc.path)
        break
      case 'rename':
        entry.text = `rename("${sc.from}", "${sc.to}")`
        result = this.sysRename(p, sc.from, sc.to)
        break
      case 'chmod': {
        entry.text = `chmod("${sc.path}", ${sc.exec ? '+x' : '-x'})`
        const node = this.vfs.resolve(sc.path, p.cwd)
        if ('err' in node) result = { err: node.err }
        else {
          this.vfs.fsOf(node).setExec(node.ino, sc.exec)
          this.dirty = true
          result = 0
        }
        break
      }
      case 'chdir': {
        entry.text = `chdir("${sc.path}")`
        const node = this.vfs.resolve(sc.path, p.cwd)
        if ('err' in node) result = { err: node.err }
        else if (node.type !== T_DIR) result = { err: 'ENOTDIR' }
        else {
          p.cwd = normalizePath(sc.path, p.cwd)
          result = 0
        }
        break
      }
      case 'getcwd':
        entry.text = 'getcwd()'
        result = p.cwd
        break
      case 'spawn':
        entry.text = `execve("${sc.path}", [${sc.args.join(', ')}])`
        result = this.sysSpawn(p, sc.path, sc.args)
        break
      case 'exit':
        entry.text = `exit(${sc.code})`
        this.tracePush(entry)
        entry.ret = '-'
        this.doExit(p, sc.code)
        return
      case 'wait': {
        entry.text = `waitpid(${sc.pid})`
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
        entry.text = `nanosleep(${sc.ticks} ticks)`
        if (sc.ticks <= 0) result = 0
        else {
          p.state = 'blocked'
          p.wakeAt = this.ticks + sc.ticks
          blocked = true
        }
        break
      case 'kill': {
        entry.text = `kill(${sc.pid}, ${sc.sig})`
        if (sc.pid === 1) {
          this.tracePush(entry)
          entry.ret = '-'
          this.killInit()
          return
        }
        if (sc.pid === 0) {
          result = { err: 'EPERM' }
          break
        }
        const t = this.procs.get(sc.pid)
        if (!t) result = { err: 'ESRCH' }
        else {
          this.killSig(t, sc.sig)
          result = 0
        }
        break
      }
      case 'peek': {
        entry.text = `peek(${hexAddr(sc.addr)}, ${sc.len})`
        const raw = this.mem.peek(sc.addr, sc.len)
        result = raw ? { addr: sc.addr, bytes: [...raw] } : { err: 'EINVAL' }
        break
      }
      case 'mount':
        entry.text = `mount("${sc.dev}", "${sc.dir}")`
        result = this.sysMount(sc.dev, sc.dir, p.cwd)
        break
      case 'umount':
        entry.text = `umount("${sc.target}")`
        result = this.sysUmount(sc.target, p.cwd)
        break
      case 'sync':
        entry.text = 'sync()'
        result = this.flush(false)
        break
      case 'lsblk':
        entry.text = 'ioctl(BLKGETINFO)'
        result = this.blkInfo()
        break
      case 'getpid':
        entry.text = 'getpid()'
        result = p.pid
        break
      case 'getenv':
        entry.text = `getenv("${sc.key}")`
        result = p.env[sc.key] ?? ''
        break
      case 'tcsetpgrp':
        entry.text = `tcsetpgrp(${sc.pid})`
        this.fgPid = sc.pid
        result = 0
        break
      case 'view':
        entry.text = `readview(${sc.kind}, "${sc.arg}")`
        result = this.sysView(sc.kind, sc.arg, p)
        break
      case 'assemble':
        entry.text = `assemble("${sc.source}", "${sc.output}")`
        result = this.sysAssemble(sc.source, sc.output, p)
        break
      case 'ps':
        entry.text = 'readproc()'
        result = this.procInfoList()
        break
      case 'meminfo':
        entry.text = 'sysinfo()'
        result = this.mem.stats()
        break
      case 'fsinfo':
        entry.text = 'statfs()'
        result = this.statfs()
        break
      case 'kmsg':
        entry.text = 'syslog(READ_ALL)'
        result = this.kmsgLines()
        break
      case 'time':
        entry.text = 'clock_gettime()'
        result = { ticks: this.ticks, hz: this.hz }
        break
    }

    this.tracePush(entry)
    if (blocked) {
      entry.ret = 'blocked'
      return
    }
    if (isErr(result)) {
      entry.ret = `-1 ${result.err}`
      entry.err = true
    } else {
      entry.ret =
        result === null
          ? 'EOF'
          : typeof result === 'string'
            ? JSON.stringify(clip(result, 26))
            : typeof result === 'number'
              ? String(result)
              : clip(JSON.stringify(result), 40)
      if (typeof result === 'number') p.regs.ax = result
    }
    p.pending = result
  }

  private tracePush(e: SysEntry) {
    this.trace.push(e)
    if (this.trace.length > 160) this.trace.shift()
  }

  private statfs() {
    const fs = this.fsOf('sda')
    return { max: fs.inodeCount, used: fs.usedInodes(), bytes: fs.usedBlocks() * fs.dev.blockSize }
  }

  // /proc 与 /sys 风格的文本视图。格式化发生在内核虚拟文件层，命令本身只做 read/write。
  private sysView(kind: number, arg: string, p: Process): string | Err {
    if (kind === 1) {
      let out = '  PID  PPID STAT MEM TIME COMMAND\n'
      for (const r of this.procInfoList())
        out += `${String(r.pid).padStart(5)} ${String(r.ppid).padStart(5)} ${r.state
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
      const node = this.vfs.resolve(arg, p.cwd)
      if ('err' in node) return { err: node.err }
      if (node.type !== T_FILE) return { err: 'EISDIR' }
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
    if (kind === 8) {
      const pages: Record<string, string> = {
        crados: README,
        asm: MAN_ASM,
        storage: MAN_STORAGE,
        script: MAN_SCRIPT,
        inspect: MAN_INSPECT,
      }
      return clip(pages[arg] ?? `man: no manual entry for ${arg}\n`, 1190)
    }
    if (kind === 9)
      return [
        'crados commands',
        '',
        'files:   ls cat head wc cp mv rm rmdir mkdir touch chmod echo',
        'process: ps kill sleep count pid',
        'storage: lsblk df mount umount   (writeback is automatic)',
        'kernel:  mem dmesg hexdump objdump uname whoami',
        'build:   as source.s -o program',
        'shell:   cd pwd clear exit; > redirects; & runs in background',
        'manual:  man crados | asm | storage | script | inspect',
        '',
      ].join('\n')
    return { err: 'EINVAL' }
  }

  // 汇编服务使用与引导 ROM 完全相同的编码器；产物仍由 CPU 执行，不存在函数入口。
  private sysAssemble(source: string, output: string, p: Process): 0 | Err {
    const src = this.vfs.resolve(source, p.cwd)
    if ('err' in src) return { err: src.err }
    if (src.type !== T_FILE) return { err: 'EISDIR' }
    const text = this.vfs.fsOf(src).read(src.ino)
    const built = assemble(text)
    if (built.errors.length) {
      this.log(`as: ${source}:${built.errors[0]}`)
      return { err: 'EINVAL' }
    }
    let dst = this.vfs.resolve(output, p.cwd)
    if ('err' in dst) {
      const c = this.sysCreate(p, output, T_FILE)
      if (c !== 0) return c
      dst = this.vfs.resolve(output, p.cwd)
    }
    if ('err' in dst) return { err: dst.err }
    const fs = this.vfs.fsOf(dst)
    const wr = fs.writeBytes(dst.ino, built.bytes)
    if (isErr(wr)) return wr
    fs.setExec(dst.ino, true)
    this.dirty = true
    return 0
  }

  private sysCreate(p: Process, path: string, type: number): 0 | Err {
    const abs = normalizePath(path, p.cwd)
    const parent = this.vfs.resolve(dirname(abs), '/')
    if ('err' in parent) return { err: parent.err }
    if (parent.type !== T_DIR) return { err: 'ENOTDIR' }
    const fs = this.vfs.fsOf(parent)
    const r = fs.create(parent.ino, basename(abs), type)
    if (typeof r !== 'number') return r
    this.dirty = true
    return 0
  }

  private sysUnlink(p: Process, path: string): 0 | Err {
    const abs = normalizePath(path, p.cwd)
    if (abs === '/' || this.vfs.isMountPoint(abs)) return { err: 'EBUSY' }
    const node = this.vfs.resolve(abs, '/')
    if ('err' in node) return { err: node.err }
    if (node.type === T_DEV) return { err: 'EPERM' }
    const fs = this.vfs.fsOf(node)
    if (node.type === T_DIR && fs.entries(node.ino).length) return { err: 'ENOTEMPTY' }
    const parentIno = fs.iparent(node.ino)
    fs.unlink(parentIno, node.name)
    fs.destroy(node.ino)
    this.dirty = true
    return 0
  }

  private sysRename(p: Process, from: string, to: string): 0 | Err {
    const src = this.vfs.resolve(from, p.cwd)
    if ('err' in src) return { err: src.err }
    const absTo = normalizePath(to, p.cwd)
    const existing = this.vfs.resolve(absTo, '/')
    let dir: FNode | Err
    let name: string
    if (!('err' in existing) && existing.type === T_DIR) {
      dir = existing
      name = src.name
    } else {
      dir = this.vfs.resolve(dirname(absTo), '/')
      name = basename(absTo)
      if (!('err' in existing)) this.sysUnlink(p, absTo)
    }
    if ('err' in dir) return { err: dir.err }
    if (dir.dev !== src.dev) return { err: 'EXDEV' } // 跨设备只能用 cp 逐块复制
    const fs = this.vfs.fsOf(src)
    fs.unlink(fs.iparent(src.ino), src.name)
    const r = fs.link(dir.ino, name, src.ino)
    if (r !== 0) return r
    fs.reparent(src.ino, dir.ino)
    this.dirty = true
    return 0
  }

  private sysWrite(p: Process, fd: number, data: string): number | Err {
    const f = p.fds.get(fd)
    if (!f) return { err: 'EBADF' }
    if (f.kind === 'stdin' || (f.kind === 'file' && f.flags === 'r')) return { err: 'EBADF' }
    if (f.kind === 'stdout') {
      this.conWrite(data, f.id === 2 ? 'err' : 'out')
      return data.length
    }
    if (f.kind === 'tty') {
      this.conWrite(data, 'out')
      return data.length
    }
    if (f.kind === 'null') return data.length
    // 直接按偏移写盘：只有受影响的块被改写，不经任何中间副本
    const fs = this.fss.get(f.dev)!
    const at = f.flags === 'a' ? fs.isize(f.ino) : f.pos
    const raw = new Uint8Array(data.length)
    for (let i = 0; i < data.length; i++) raw[i] = data.charCodeAt(i) & 0xff
    const r = fs.writeAt(f.ino, at, raw)
    if (isErr(r)) return r
    p.fds.seek(fd, at + data.length) // 文件偏移回写进 PCB 的 fd 表
    this.dirty = true
    return data.length
  }

  private sysRead(p: Process, fd: number, len?: number): string | null | Err | undefined {
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
      return this.lineQueue.shift() ?? null
    }
    const fs = this.fss.get(f.dev)!
    const size = fs.isize(f.ino)
    if (f.pos >= size) return ''
    // 机器码程序按缓冲区大小分次读取；不给长度则读到文件末尾
    const want = len && len > 0 ? Math.min(len, size - f.pos) : size - f.pos
    const raw = fs.readAt(f.ino, f.pos, want)
    p.fds.seek(fd, f.pos + want)
    return String.fromCharCode(...raw)
  }

  private lowestFd(p: Process): number {
    let fd = 3
    while (p.fds.has(fd)) fd++
    return fd
  }

  private sysOpen(p: Process, path: string, flags: 'r' | 'w' | 'a'): number | Err {
    let node = this.vfs.resolve(path, p.cwd)
    if ('err' in node) {
      if (flags === 'r' || node.err !== 'ENOENT') return { err: node.err }
      const c = this.sysCreate(p, path, T_FILE)
      if (c !== 0) return c
      node = this.vfs.resolve(path, p.cwd)
      if ('err' in node) return { err: node.err }
    }
    const n = node as FNode
    if (n.type === T_DIR) return { err: 'EISDIR' }
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
      for (const dir of (p.env.PATH || '/usr/bin:/bin').split(':')) {
        const candidate = `${dir}/${path}`
        if (!('err' in this.vfs.resolve(candidate, p.cwd))) {
          resolved = candidate
          break
        }
      }
    }
    const node = this.vfs.resolve(resolved, p.cwd)
    if ('err' in node) return { err: node.err }
    if (node.type === T_DIR) return { err: 'EISDIR' }
    if (node.type === T_DEV) return { err: 'EACCES' }
    if (!node.exec) return { err: 'EACCES' }

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
      return this.launch(p, node.name, `${node.name} ${args.join(' ')}`.trim(), args, { kind: 'exe', entry: exe.entry }, exe.image)
    }

    const head = String.fromCharCode(...image.subarray(0, 64)).split('\n', 1)[0]
    if (!head.startsWith('#!')) return { err: 'ENOEXEC' }
    const interpPath = head.slice(2).trim().split(/\s+/)[0]
    const interp = this.vfs.resolve(interpPath, '/')
    if ('err' in interp || !interp.exec) return { err: 'ENOEXEC' }
    const interpRaw = this.vfs.fsOf(interp).readBytes(interp.ino)
    const interpExe = loadExe(String.fromCharCode(...interpRaw))
    if (!interpExe) return { err: 'ENOEXEC' }
    this.log(`execve: ${abs} interpreted by ${interpPath}`)
    return this.launch(
      p,
      basename(abs),
      `${basename(abs)} ${args.join(' ')}`.trim(),
      [abs, ...args],
      { kind: 'exe', entry: interpExe.entry },
      interpExe.image,
    )
  }

  private launch(p: Process, name: string, cmd: string, args: string[], spec: ExecSpec, image: Uint8Array): number | Err {
    const r = this.exec(p, name, cmd, args, spec, image)
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
    if (this.lineBuf.length < 256) this.lineBuf += ch
    this.conWrite(ch, 'echo')
    this.emit()
  }

  pressEnter() {
    if (this.panic) return
    this.lineQueue.push(this.lineBuf)
    this.lineBuf = ''
    this.conWrite('\n', 'echo')
    this.wakeReader()
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
    this.wakeReader()
    this.emit()
  }

  pressCtrlC() {
    if (this.panic) return
    this.conWrite('^C\n', 'err')
    this.lineBuf = ''
    const fg = this.fgPid !== null ? this.procs.get(this.fgPid) : undefined
    if (fg && fg.pid !== this.shellPid && fg.state !== 'zombie') this.killSig(fg, 2)
    else
      for (const p of this.procs.values())
        if (p.state === 'blocked' && p.readStdin) {
          p.readStdin = false
          p.pending = ''
          p.state = 'ready'
          break
        }
    this.emit()
  }

  pressCtrlL() {
    this.lines = []
    this.emit()
  }

  private wakeReader() {
    for (const p of [...this.procs.values()].sort((a, b) => a.pid - b.pid)) {
      if (p.state === 'blocked' && p.readStdin) {
        p.readStdin = false
        p.pending = this.lineQueue.length ? (this.lineQueue.shift() ?? null) : null
        p.state = 'ready'
        return
      }
    }
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

  // ---------- 快照 ----------

  private fdDesc(p: Process): string[] {
    return [...p.fds.entries()].map(([fd, f]) => {
      switch (f.kind) {
        case 'stdin':
          return `${fd} -> tty0 (stdin)`
        case 'stdout':
          return `${fd} -> tty0 (${f.id === 2 ? 'stderr' : 'stdout'})`
        case 'tty':
          return `${fd} -> /dev/tty`
        case 'null':
          return `${fd} -> /dev/null`
        case 'file':
          return `${fd} -> ${f.dev}:inode ${f.ino} (${f.flags}) offset ${f.pos}`
      }
    })
  }

  private buildTree(path: string): FSNode {
    const node = this.vfs.resolve(path, '/')
    if ('err' in node)
      return { ino: 0, name: basename(path), type: 'file', size: 0, blocks: 0, exec: false, disk: '?', path, kids: [] }
    const fs = this.vfs.fsOf(node)
    const kids =
      node.type === T_DIR
        ? fs
            .entries(node.ino)
            .map((e) => this.buildTree(path === '/' ? `/${e.name}` : `${path}/${e.name}`))
            .sort((a, b) => a.name.localeCompare(b.name))
        : []

    const isFile = node.type === T_FILE
    const raw = isFile && node.size <= 4096 ? fs.readBytes(node.ino) : null
    const binary = raw ? isExecutable(String.fromCharCode(...raw.subarray(0, 4))) : false
    const exe = binary && raw ? loadExe(String.fromCharCode(...raw)) : null
    return {
      ino: node.ino,
      name: path === '/' ? '/' : basename(path),
      type: TYPE_NAME[node.type] ?? 'file',
      size: node.size,
      blocks: node.type === T_DEV ? 0 : fs.blocksOf(node.ino).length,
      exec: node.exec,
      disk: node.dev.spec.name,
      path,
      data: raw && !binary ? clip(String.fromCharCode(...raw), 600) : undefined,
      disasm: exe ? disassemble(exe.image, exe.textLen, 48) : undefined,
      blockList: node.type === T_DEV ? undefined : fs.blocksOf(node.ino),
      kids,
    }
  }

  private buildSnapshot(): Snapshot {
    const m = this.mem.stats()
    return {
      ticks: this.ticks,
      hz: this.hz,
      paused: this.paused,
      mode: this.mode,
      currentPid: this.currentPid,
      switches: this.switches,
      quantum: QUANTUM,
      procs: [...this.procs.values()].map((p) => ({
        pid: p.pid,
        ppid: p.ppid,
        name: p.name,
        cmd: p.cmd,
        state: p.state,
        pc: p.regs.pc,
        sp: p.regs.sp,
        ax: p.regs.ax,
        pages: p.pageTable.length,
        ticksUsed: p.ticksUsed,
        cwd: p.cwd,
        children: this.childrenOf(p.pid).map((c) => c.pid),
        exitCode: p.exitCode,
        waitDesc: p.waitDesc() as string | null,
        pts: p.pageTable,
        fds: this.fdDesc(p),
      })),
      frames: this.mem.frames,
      mem: { total: m.total, used: m.used, free: m.free, framesUsed: m.framesUsed },
      tree: this.buildTree('/'),
      fs: this.statfs(),
      disks: this.blkInfo(),
      usbLabel: this.usbPresent ? this.fsOf('sdb').label() : '',
      storageOk: this.storageOk,
      dirty: this.dirty,
      lastSync: this.lastSync,
      turbo: this.turbo,
      tps: this.tps,
      trace: this.trace,
      kmsgText: this.kmsgLines(),
      lines: this.lines,
      fgPid: this.fgPid,
      shellPid: this.shellPid,
      panic: this.panic,
    }
  }

  private emit() {
    if (this.suppress) return
    const now = performance.now()
    if (now - this.tpsAt >= 400) {
      this.tps = Math.round(((this.ticks - this.tpsTicks) * 1000) / (now - this.tpsAt))
      this.tpsAt = now
      this.tpsTicks = this.ticks
    }
    this.snap = this.buildSnapshot()
    for (const fn of this.listeners) fn()
  }
}
