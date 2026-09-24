// PCB 住在内存条里：每个进程占内核保留区的 128 字节
// 下面所有字段都是 Memory.bytes 上的偏移，JS 侧只留生成器（执行载体）与 env
//
// 布局
//   0    inuse        1    state        2..3  pid        4..5  ppid
//   6..7 pc           8..9 sp           10-11 ax         12-13 exit status
//   14-15 cpu ticks   16-17 wake tick   18-19 wait for   20    stdin wait
//   21   npages       22   cwd device   23    cwd inode  24-39 page table
//   40   nfds         41-88 fd table (8 entries x 6 B)
//   89   name length  90-105 name       106   cmd length 107-127 cmd

import type { Memory } from './memory'
import { PAGE_SIZE } from './memory'
import type { Err, Gen, PState } from './types'

export const PCB_SIZE = 128
export const PCB_BASE = PAGE_SIZE
export const MAX_PROCS = 32
export const MAX_PAGES = 16
export const MAX_FDS = 8

const O_STATE = 1
const O_PID = 2
const O_PPID = 4
const O_PC = 6
const O_SP = 8
const O_AX = 10
const O_EXIT = 12
const O_TICKS = 14
const O_WAKE = 16
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
const NAME_CAP = 16
const CMD_CAP = 20
const FD_SIZE = 6

const STATES: PState[] = ['new', 'new', 'ready', 'running', 'blocked', 'zombie']
const STATE_CODE: Record<PState, number> = { new: 1, ready: 2, running: 3, blocked: 4, zombie: 5 }

export const DEV_CODE: Record<string, number> = { sda: 1, sdb: 2, rom: 3 }
export const DEV_NAME: Record<number, string> = { 1: 'sda', 2: 'sdb', 3: 'rom' }

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
  seg: string
}

export interface Regs {
  pc: number
  sp: number
  bp: number
  ax: number
}

export interface VfsHooks {
  pathOf(dev: number, ino: number): string
  lookup(path: string): { dev: number; ino: number }
}

const FLAG_CODE: Record<string, number> = { r: 0, w: 1, a: 2 }
const FLAG_NAME: Record<number, 'r' | 'w' | 'a'> = { 0: 'r', 1: 'w', 2: 'a' }

// 打开文件表：直接读写 PCB 里的 48 字节，接口与 Map 兼容
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
          dev: DEV_NAME[b[at + 1]] ?? 'sda',
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
        b[at + 1] = DEV_CODE[e.dev] ?? 1
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

  // 只有执行载体留在 JS 堆上：生成器、待传入的返回值、CPU 状态、环境变量
  pending: unknown = undefined
  cpu: { regs: Uint16Array; pc: number; sp: number; flag: number; halted: boolean } | null = null
  stepsInSlice = 0
  segNames: string[] = []

  constructor(
    private readonly mem: Memory,
    readonly slot: number,
    readonly gen: Gen,
    readonly env: Record<string, string>,
    private readonly vfs: VfsHooks,
  ) {
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
        return (b()[base + O_AX] << 8) | b()[base + O_AX + 1]
      },
      set ax(v: number) {
        b()[base + O_AX] = (v >> 8) & 0xff
        b()[base + O_AX + 1] = v & 0xff
      },
      bp: 0,
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
    return this.u16(O_TICKS)
  }
  set ticksUsed(v: number) {
    this.setU16(O_TICKS, v)
  }

  get wakeAt(): number {
    return this.u16(O_WAKE)
  }
  set wakeAt(v: number) {
    this.setU16(O_WAKE, v)
  }

  get waitFor(): number | null {
    const v = this.u16(O_WAITFOR)
    if (v === 0xffff) return null
    return v === 0xfffe ? -1 : v
  }
  set waitFor(v: number | null) {
    this.setU16(O_WAITFOR, v === null ? 0xffff : v === -1 ? 0xfffe : v)
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

  get pageTable(): PTE[] {
    const n = this.u8(O_NPAGES)
    const out: PTE[] = []
    for (let i = 0; i < n; i++)
      out.push({ vpn: i, pfn: this.u8(O_PAGES + i), seg: this.segNames[i] ?? 'text' })
    return out
  }
  set pageTable(list: PTE[]) {
    const n = Math.min(list.length, MAX_PAGES)
    this.setU8(O_NPAGES, n)
    this.segNames = list.map((t) => t.seg)
    for (let i = 0; i < MAX_PAGES; i++) this.setU8(O_PAGES + i, i < n ? list[i].pfn : 0)
  }

  get pfns(): number[] {
    const n = this.u8(O_NPAGES)
    return Array.from({ length: n }, (_, i) => this.u8(O_PAGES + i))
  }

  waitDesc(): string | Err | null {
    if (this.state !== 'blocked') return null
    if (this.wakeAt > 0) return `sleep until tick ${this.wakeAt}`
    if (this.readStdin) return 'waiting on stdin'
    const w = this.waitFor
    if (w !== null) return w === -1 ? 'wait for any child' : `wait for pid ${w}`
    return 'blocked'
  }
}
