// PCB 住在内存条里：每个进程占内核保留区的 192 字节
// 下面所有字段都是 Memory.bytes 上的偏移，JS 侧只留生成器（执行载体）与 env
//
// 布局
//   0    inuse        1    state        2..3  pid        4..5  ppid
//   6..7 pc           8..9 sp           10-11 reserved   12-13 exit status
//   14-17 reserved                      18-19 wait for   20    stdin wait
//   21   npages       22   cwd device   23    cwd inode  24-39 page table
//   40   nfds         41-88 fd table (8 entries x 6 B)
//   89   name length  90-105 name       106   cmd length 107-127 cmd
//   128-143 r0-r7     144-145 flags     146   halted
//   147-154 cpu ticks (64 位)           155-162 wake deadline ms (64 位)
//   163 sleeping    164 mode   165 irq-enable   166-167 pending irq
//   168-169 cause   170-171 ivt base            172-173 kernel sp
//   174-175 user sp
//   176-177 uid      178-179 euid     180-181 gid      182-183 egid
//   184-185 pfn bit6  186-187 pfn bit7  188-191 reserved
//   页表字节只有 6 位帧号。bit6/bit7 各是一个 u16 掩码，第 n 位对应虚拟页 n。

import type { Memory } from './memory'
import { PAGE_SIZE } from './memory'
import type { CpuState, RegisterFile } from './vm'
import type { Err, Gen, PState } from './types'

export const PCB_SIZE = 192
export const PCB_BASE = PAGE_SIZE
export const MAX_PROCS = 16
export const MAX_PAGES = 16
export const MAX_FDS = 8

const O_STATE = 1
const O_PID = 2
const O_PPID = 4
const O_PC = 6
const O_SP = 8
const O_EXIT = 12
const O_WAITFOR = 18
const O_STDIN = 20
const O_NPAGES = 21
const O_CWDDEV = 22
const O_CWDINO = 23
const O_PAGES = 24
const O_NFDS = 40
const O_FDS = 41
const O_NAME = 89
const O_CMD = 106
const O_RBANK = 128
const O_FLAG = 144
const O_HALTED = 146
const O_TICKS = 147
const O_WAKE = 155
const O_SLEEPING = 163
const O_MODE = 164
const O_IRQ_ENABLED = 165
const O_PENDING_IRQ = 166
const O_CAUSE = 168
const O_IVT = 170
const O_KSP = 172
const O_USP = 174
const O_UID = 176
const O_EUID = 178
const O_GID = 180
const O_EGID = 182
const O_PFN6 = 184
const O_PFN7 = 186
const NAME_CAP = 16
const CMD_CAP = 20
const FD_SIZE = 6

const STATES: PState[] = ['new', 'new', 'ready', 'running', 'blocked', 'zombie']
const STATE_CODE: Record<PState, number> = { new: 1, ready: 2, running: 3, blocked: 4, zombie: 5 }

export const deviceCode = (name: string): number => {
  if (name === 'rom') return 0xfe
  const m = /^sd([a-z])$/.exec(name)
  return m ? m[1].charCodeAt(0) - 96 : 0
}

export const deviceName = (code: number): string => {
  if (code === 0xfe) return 'rom'
  return code >= 1 && code <= 26 ? `sd${String.fromCharCode(96 + code)}` : 'sda'
}

const FK_EMPTY = 0
const FK_STDIN = 1
const FK_STDOUT = 2
const FK_STDERR = 3
const FK_TTY = 4
const FK_NULL = 5
const FK_FILE = 6

export type FD =
  | { kind: 'stdin' }
  | { kind: 'stdout'; id: 1 | 2 }
  | { kind: 'file'; ino: number; dev: string; pos: number; flags: 'r' | 'w' | 'a' }
  | { kind: 'tty' }
  | { kind: 'null' }

export interface PTE {
  vpn: number
  pfn: number
  supervisor?: boolean
}

const PTE_VALID = 0x80
const PTE_SUPERVISOR = 0x40
const PTE_PFN = 0x3f

export interface Regs {
  pc: number
  sp: number
  ax: number
}

export interface VfsHooks {
  pathOf(dev: number, ino: number): string
  lookup(path: string): { dev: number; ino: number }
}

const FLAG_CODE: Record<string, number> = { r: 0, w: 1, a: 2 }
const FLAG_NAME: Record<number, 'r' | 'w' | 'a'> = { 0: 'r', 1: 'w', 2: 'a' }

// PCB-backed file descriptor table.
class FdTable {
  constructor(
    private readonly mem: Memory,
    private readonly base: number,
  ) {}

  private at(fd: number): number {
    return this.base + O_FDS + fd * FD_SIZE
  }

  get(fd: number): FD | undefined {
    if (fd < 0 || fd >= MAX_FDS) return undefined
    const b = this.mem.bytes
    const at = this.at(fd)
    switch (b[at]) {
      case FK_STDIN:
        return { kind: 'stdin' }
      case FK_STDOUT:
        return { kind: 'stdout', id: 1 }
      case FK_STDERR:
        return { kind: 'stdout', id: 2 }
      case FK_TTY:
        return { kind: 'tty' }
      case FK_NULL:
        return { kind: 'null' }
      case FK_FILE:
        return {
          kind: 'file',
          dev: deviceName(b[at + 1]),
          ino: b[at + 2],
          flags: FLAG_NAME[b[at + 3]] ?? 'r',
          pos: (b[at + 4] << 8) | b[at + 5],
        }
      default:
        return undefined
    }
  }

  set(fd: number, e: FD): void {
    if (fd < 0 || fd >= MAX_FDS) return
    const b = this.mem.bytes
    const at = this.at(fd)
    b.fill(0, at, at + FD_SIZE)
    switch (e.kind) {
      case 'stdin':
        b[at] = FK_STDIN
        break
      case 'stdout':
        b[at] = e.id === 2 ? FK_STDERR : FK_STDOUT
        break
      case 'tty':
        b[at] = FK_TTY
        break
      case 'null':
        b[at] = FK_NULL
        break
      case 'file':
        b[at] = FK_FILE
        b[at + 1] = deviceCode(e.dev) || 1
        b[at + 2] = e.ino & 0xff
        b[at + 3] = FLAG_CODE[e.flags] ?? 0
        b[at + 4] = (e.pos >> 8) & 0xff
        b[at + 5] = e.pos & 0xff
        break
    }
    this.recount()
  }

  // file 类型的 fd 需要回写偏移，这里提供显式的持久化入口
  seek(fd: number, pos: number) {
    const at = this.at(fd)
    if (this.mem.bytes[at] !== FK_FILE) return
    this.mem.bytes[at + 4] = (pos >> 8) & 0xff
    this.mem.bytes[at + 5] = pos & 0xff
  }

  has(fd: number): boolean {
    return fd >= 0 && fd < MAX_FDS && this.mem.bytes[this.at(fd)] !== FK_EMPTY
  }

  delete(fd: number): boolean {
    if (!this.has(fd)) return false
    this.mem.bytes.fill(0, this.at(fd), this.at(fd) + FD_SIZE)
    this.recount()
    return true
  }

  clear() {
    this.mem.bytes.fill(0, this.base + O_FDS, this.base + O_FDS + MAX_FDS * FD_SIZE)
    this.mem.bytes[this.base + O_NFDS] = 0
  }

  entries(): [number, FD][] {
    const out: [number, FD][] = []
    for (let fd = 0; fd < MAX_FDS; fd++) {
      const e = this.get(fd)
      if (e) out.push([fd, e])
    }
    return out
  }

  private recount() {
    let n = 0
    for (let fd = 0; fd < MAX_FDS; fd++) if (this.has(fd)) n++
    this.mem.bytes[this.base + O_NFDS] = n
  }
}

export class Process {
  readonly base: number
  readonly fds: FdTable
  readonly regs: Regs
  gen: Gen

  // 只有执行载体留在 JS 堆上：生成器、待传入的返回值与环境变量。
  // cpu 是一组访问器；寄存器、PC、SP、FLAGS 的值本身全部在 PCB 字节里。
  pending: unknown = undefined
  cpu: CpuState | null = null

  constructor(
    private readonly mem: Memory,
    readonly slot: number,
    gen: Gen,
    readonly env: Record<string, string>,
    private readonly vfs: VfsHooks,
  ) {
    this.gen = gen
    this.base = PCB_BASE + slot * PCB_SIZE
    this.fds = new FdTable(mem, this.base)
    const b = () => this.mem.bytes
    const base = this.base
    this.regs = {
      get pc() {
        return (b()[base + O_PC] << 8) | b()[base + O_PC + 1]
      },
      set pc(v: number) {
        b()[base + O_PC] = (v >> 8) & 0xff
        b()[base + O_PC + 1] = v & 0xff
      },
      get sp() {
        return (b()[base + O_SP] << 8) | b()[base + O_SP + 1]
      },
      set sp(v: number) {
        b()[base + O_SP] = (v >> 8) & 0xff
        b()[base + O_SP + 1] = v & 0xff
      },
      get ax() {
        return (b()[base + O_RBANK] << 8) | b()[base + O_RBANK + 1]
      },
      set ax(v: number) {
        b()[base + O_RBANK] = (v >> 8) & 0xff
        b()[base + O_RBANK + 1] = v & 0xff
      },
    }
  }

  private u8(off: number): number {
    return this.mem.bytes[this.base + off]
  }
  private setU8(off: number, v: number) {
    this.mem.bytes[this.base + off] = v & 0xff
  }
  private u16(off: number): number {
    return (this.mem.bytes[this.base + off] << 8) | this.mem.bytes[this.base + off + 1]
  }
  private setU16(off: number, v: number) {
    this.mem.bytes[this.base + off] = (v >> 8) & 0xff
    this.mem.bytes[this.base + off + 1] = v & 0xff
  }
  // The PCB stores 64 bits; host arithmetic remains exact through 53 bits.
  private u64(off: number): number {
    const b = this.mem.bytes
    const at = this.base + off
    const hi = b[at] * 0x1000000 + b[at + 1] * 0x10000 + b[at + 2] * 0x100 + b[at + 3]
    const lo = b[at + 4] * 0x1000000 + b[at + 5] * 0x10000 + b[at + 6] * 0x100 + b[at + 7]
    return hi * 0x100000000 + lo
  }
  private setU64(off: number, v: number) {
    const b = this.mem.bytes
    const at = this.base + off
    const x = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(v)))
    const hi = Math.floor(x / 0x100000000)
    const lo = x - hi * 0x100000000
    b[at] = Math.floor(hi / 0x1000000) & 0xff
    b[at + 1] = Math.floor(hi / 0x10000) & 0xff
    b[at + 2] = Math.floor(hi / 0x100) & 0xff
    b[at + 3] = hi & 0xff
    b[at + 4] = Math.floor(lo / 0x1000000) & 0xff
    b[at + 5] = Math.floor(lo / 0x10000) & 0xff
    b[at + 6] = Math.floor(lo / 0x100) & 0xff
    b[at + 7] = lo & 0xff
  }
  private str(off: number, cap: number): string {
    const n = Math.min(this.u8(off), cap)
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.mem.bytes[this.base + off + 1 + i])
    return s
  }
  private setStr(off: number, cap: number, text: string) {
    const n = Math.min(text.length, cap)
    this.setU8(off, n)
    for (let i = 0; i < cap; i++)
      this.mem.bytes[this.base + off + 1 + i] = i < n ? text.charCodeAt(i) & 0xff : 0
  }

  init(pid: number, ppid: number, name: string, cmd: string, cwd: string) {
    this.mem.bytes.fill(0, this.base, this.base + PCB_SIZE)
    this.setU8(0, 1)
    this.setU16(O_PID, pid)
    this.setU16(O_PPID, ppid)
    this.setU16(O_WAITFOR, 0xffff)
    this.setStr(O_NAME, NAME_CAP, name)
    this.setStr(O_CMD, CMD_CAP, cmd)
    this.cwd = cwd
    this.state = 'new'
  }

  release() {
    this.setU8(0, 0)
  }

  get pid(): number {
    return this.u16(O_PID)
  }
  get ppid(): number {
    return this.u16(O_PPID)
  }
  set ppid(v: number) {
    this.setU16(O_PPID, v)
  }
  get name(): string {
    return this.str(O_NAME, NAME_CAP)
  }
  get cmd(): string {
    return this.str(O_CMD, CMD_CAP)
  }

  get state(): PState {
    return STATES[this.u8(O_STATE)] ?? 'new'
  }
  set state(s: PState) {
    this.setU8(O_STATE, STATE_CODE[s])
  }

  get exitCode(): number | null {
    return this.state === 'zombie' ? this.u16(O_EXIT) : null
  }
  set exitCode(v: number | null) {
    this.setU16(O_EXIT, v ?? 0)
  }

  get ticksUsed(): number {
    return this.u64(O_TICKS)
  }
  set ticksUsed(v: number) {
    this.setU64(O_TICKS, v)
  }

  // 独立 sleeping 标志让 wakeAt 合法取 0 时也能区分状态。
  get wakeAt(): number {
    return this.u64(O_WAKE)
  }
  set wakeAt(v: number) {
    this.setU64(O_WAKE, v)
  }

  get sleeping(): boolean {
    return this.u8(O_SLEEPING) !== 0
  }
  set sleeping(v: boolean) {
    this.setU8(O_SLEEPING, v ? 1 : 0)
  }

  get sleepMode(): number {
    return this.u8(O_SLEEPING)
  }
  set sleepMode(v: number) {
    this.setU8(O_SLEEPING, v)
  }

  get waitFor(): number | null {
    const v = this.u16(O_WAITFOR)
    if (v === 0xffff) return null
    return v === 0xfffe ? -1 : v
  }
  set waitFor(v: number | null) {
    this.setU16(O_WAITFOR, v === null ? 0xffff : v === -1 ? 0xfffe : v)
  }

  get uid(): number {
    return this.u16(O_UID)
  }
  set uid(v: number) {
    this.setU16(O_UID, v)
  }
  get euid(): number {
    return this.u16(O_EUID)
  }
  set euid(v: number) {
    this.setU16(O_EUID, v)
  }
  get gid(): number {
    return this.u16(O_GID)
  }
  set gid(v: number) {
    this.setU16(O_GID, v)
  }
  get egid(): number {
    return this.u16(O_EGID)
  }
  set egid(v: number) {
    this.setU16(O_EGID, v)
  }

  get readStdin(): boolean {
    return this.u8(O_STDIN) !== 0
  }
  set readStdin(v: boolean) {
    this.setU8(O_STDIN, v ? 1 : 0)
  }

  // 工作目录以 (设备, inode) 存储，路径由 inode 的 parent 链现场回溯
  get cwd(): string {
    const dev = this.u8(O_CWDDEV)
    return dev ? this.vfs.pathOf(dev, this.u8(O_CWDINO)) : '/'
  }
  set cwd(path: string) {
    const { dev, ino } = this.vfs.lookup(path)
    this.setU8(O_CWDDEV, dev)
    this.setU8(O_CWDINO, ino)
  }

  private pfnOf(vpn: number, raw: number): number {
    const bit = 1 << vpn
    return (raw & PTE_PFN) | (this.u16(O_PFN6) & bit ? 64 : 0) | (this.u16(O_PFN7) & bit ? 128 : 0)
  }

  get pageTable(): PTE[] {
    const out: PTE[] = []
    for (let i = 0; i < MAX_PAGES; i++) {
      const raw = this.u8(O_PAGES + i)
      if (!(raw & PTE_VALID)) continue
      out.push({
        vpn: i,
        pfn: this.pfnOf(i, raw),
        supervisor: !!(raw & PTE_SUPERVISOR),
      })
    }
    return out
  }
  set pageTable(list: PTE[]) {
    this.setU8(O_NPAGES, Math.min(list.length, MAX_PAGES))
    for (let i = 0; i < MAX_PAGES; i++) this.setU8(O_PAGES + i, 0)
    this.setU16(O_PFN6, 0)
    this.setU16(O_PFN7, 0)
    for (const pte of list.slice(0, MAX_PAGES)) {
      if (pte.vpn < 0 || pte.vpn >= MAX_PAGES) continue
      this.setU8(
        O_PAGES + pte.vpn,
        PTE_VALID | (pte.supervisor ? PTE_SUPERVISOR : 0) | (pte.pfn & PTE_PFN),
      )
      const bit = 1 << pte.vpn
      if (pte.pfn & 64) this.setU16(O_PFN6, this.u16(O_PFN6) | bit)
      if (pte.pfn & 128) this.setU16(O_PFN7, this.u16(O_PFN7) | bit)
    }
  }

  // MMU 热路径直接读取 PCB 页表字节，不创建或捕获任何 JS 页表副本。
  get addressLimit(): number {
    return MAX_PAGES * PAGE_SIZE
  }

  pteAt(vpn: number): { pfn: number; supervisor: boolean } | null {
    if (vpn < 0 || vpn >= MAX_PAGES) return null
    const raw = this.u8(O_PAGES + vpn)
    if (!(raw & PTE_VALID)) return null
    return { pfn: this.pfnOf(vpn, raw), supervisor: !!(raw & PTE_SUPERVISOR) }
  }

  // 构造无状态访问器。Object 本身只承担总线接口，所有值都落在 Memory.bytes。
  createCpuState(): CpuState {
    const regs = {} as RegisterFile
    for (let i = 0; i < 8; i++) {
      const off = O_RBANK + i * 2
      Object.defineProperty(regs, i, {
        enumerable: true,
        get: () => this.u16(off),
        set: (v: number) => this.setU16(off, v & 0xffff),
      })
    }

    const state = { regs } as CpuState
    Object.defineProperties(state, {
      pc: {
        enumerable: true,
        get: () => this.u16(O_PC),
        set: (v: number) => this.setU16(O_PC, v & 0xffff),
      },
      sp: {
        enumerable: true,
        get: () => this.u16(O_SP),
        set: (v: number) => this.setU16(O_SP, v & 0xffff),
      },
      flag: {
        enumerable: true,
        get: () => {
          const v = this.u16(O_FLAG)
          return v === 0xffff ? -1 : v
        },
        set: (v: number) => this.setU16(O_FLAG, v < 0 ? 0xffff : v > 0 ? 1 : 0),
      },
      halted: {
        enumerable: true,
        get: () => this.u8(O_HALTED) !== 0,
        set: (v: boolean) => this.setU8(O_HALTED, v ? 1 : 0),
      },
      mode: {
        enumerable: true,
        get: () => (this.u8(O_MODE) ? 'kernel' : 'user'),
        set: (v: 'user' | 'kernel') => this.setU8(O_MODE, v === 'kernel' ? 1 : 0),
      },
      irqEnabled: {
        enumerable: true,
        get: () => this.u8(O_IRQ_ENABLED) !== 0,
        set: (v: boolean) => this.setU8(O_IRQ_ENABLED, v ? 1 : 0),
      },
      pendingIrq: {
        enumerable: true,
        get: () => this.u16(O_PENDING_IRQ),
        set: (v: number) => this.setU16(O_PENDING_IRQ, v),
      },
      cause: {
        enumerable: true,
        get: () => this.u16(O_CAUSE),
        set: (v: number) => this.setU16(O_CAUSE, v),
      },
      ivtBase: {
        enumerable: true,
        get: () => this.u16(O_IVT),
        set: (v: number) => this.setU16(O_IVT, v),
      },
      ksp: {
        enumerable: true,
        get: () => this.u16(O_KSP),
        set: (v: number) => this.setU16(O_KSP, v),
      },
      usp: {
        enumerable: true,
        get: () => this.u16(O_USP),
        set: (v: number) => this.setU16(O_USP, v),
      },
    })
    return state
  }

  waitDesc(): string | Err | null {
    if (this.state !== 'blocked') return null
    if (this.sleepMode === 1) return `sleep until tick ${this.wakeAt}`
    if (this.sleepMode === 2) return `sleep until monotonic ${this.wakeAt} ms`
    if (this.readStdin) return 'waiting on stdin'
    const w = this.waitFor
    if (w !== null) return w === -1 ? 'wait for any child' : `wait for pid ${w}`
    return 'blocked'
  }
}
