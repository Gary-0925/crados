// 控制面板的观测层：把内核的只读接口聚合成一份 Snapshot 供 React 渲染。
//
// 这一层完全在内核之外。删掉整个 /cp，内核不会少任何东西，也不会为此付出
// 任何代价——内核只在 observer 非空时才产生追踪数据。

import type { Kernel } from '@/os/kernel'
import { basename, T_DEV, T_DIR, T_FILE } from '@/os/fs'
import { disassemble, isExecutable, loadExe } from '@/os/isa'
import { FRAME_COUNT, KERNEL_TEXT_FRAME, USER_FRAME_START } from '@/os/memory'
import type { PTE } from '@/os/process'
import { isErr } from '@/os/types'
import type { BlkInfo, PState, Syscall } from '@/os/types'

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
  gprs: number[]
  flags: number
  halted: boolean
  cpuMode: 'user' | 'kernel' | null
  irqEnabled: boolean
  pendingIrq: number | null
  cause: number | null
  ivtBase: number | null
  ksp: number | null
  usp: number | null
  pages: number
  ticksUsed: number
  cwd: string
  children: number[]
  exitCode: number | null
  waitDesc: string | null
  pts: PTE[]
  fds: string[]
}

export interface Frame {
  no: number
  owner: number | 'kernel' | null
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

export interface Snapshot {
  currentPid: number
  procs: ProcRow[]
  frames: Frame[]
  mem: { total: number; used: number; free: number; framesUsed: number }
  tree: FSNode
  fs: { max: number; used: number; bytes: number }
  disks: BlkInfo[]
  storageOk: boolean
  dirty: boolean
  ips: number
  trace: SysEntry[]
  kmsgText: string[]
  fgPid: number | null
  panic: string | null
}

const TRACE_MAX = 160
const TYPE_NAME: Record<number, 'dir' | 'file' | 'dev'> = { 1: 'file', 2: 'dir', 3: 'dev' }
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false })

function formatCall(sc: Syscall): string {
  switch (sc.call) {
    case 'yield': return 'yield()'
    case 'write': return `write(${sc.fd}, ${typeof sc.data === 'string' ? JSON.stringify(clip(sc.data, 18)) : `<${sc.data.length} bytes>`})`
    case 'read': return `read(${sc.fd}${sc.len ? `, ${sc.len}` : ''})`
    case 'open': return `open("${sc.path}", ${sc.flags})`
    case 'close': return `close(${sc.fd})`
    case 'dup': return `dup(${sc.fd})`
    case 'dup2': return `dup2(${sc.from}, ${sc.to})`
    case 'readdir': return `getdents("${sc.path}")`
    case 'stat': return `stat("${sc.path}")`
    case 'mkdir': return `mkdir("${sc.path}")`
    case 'unlink': return `unlink("${sc.path}")`
    case 'rename': return `rename("${sc.from}", "${sc.to}")`
    case 'chmod': return `chmod("${sc.path}", ${sc.exec ? '+x' : '-x'})`
    case 'chdir': return `chdir("${sc.path}")`
    case 'getcwd': return 'getcwd()'
    case 'spawn': return `execve("${sc.path}", [${sc.args.join(', ')}])`
    case 'exit': return `exit(${sc.code})`
    case 'wait': return `waitpid(${sc.pid})`
    case 'sleep': return `nanosleep(${sc.ticks})`
    case 'sleepSeconds': return `sleep_seconds(${sc.seconds})`
    case 'kill': return `kill(${sc.pid}, ${sc.sig})`
    case 'getpid': return 'getpid()'
    case 'getenv': return `getenv("${sc.key}")`
    case 'tcsetpgrp': return `tcsetpgrp(${sc.pid})`
    case 'view': return `readview(${sc.kind}, "${sc.arg}")`
    case 'assemble': return `assemble("${sc.source}", "${sc.output}")`
    case 'mount': return `mount("${sc.dev}", "${sc.dir}")`
    case 'umount': return `umount("${sc.target}")`
    case 'sync': return 'sync()'
    case 'time': return 'clock_gettime()'
  }
}

function formatResult(result: unknown, blocked: boolean): { ret: string; err: boolean } {
  if (blocked) return { ret: 'blocked', err: false }
  if (result === undefined) return { ret: '-', err: false }
  if (isErr(result)) return { ret: `-1 ${result.err}`, err: true }
  if (result === null) return { ret: 'EOF', err: false }
  if (typeof result === 'string') return { ret: JSON.stringify(clip(result, 26)), err: false }
  if (typeof result === 'number') return { ret: String(result), err: false }
  if (result instanceof Uint8Array) return { ret: `<${result.length} bytes>`, err: false }
  return { ret: clip(JSON.stringify(result), 40), err: false }
}

function describeFds(p: ReturnType<Kernel['processes']>[number]): string[] {
  return p.fds.entries().map(([fd, value]) => {
    switch (value.kind) {
      case 'stdin': return `${fd} -> tty0 (stdin)`
      case 'stdout': return `${fd} -> tty0 (${value.id === 2 ? 'stderr' : 'stdout'})`
      case 'tty': return `${fd} -> /dev/tty`
      case 'null': return `${fd} -> /dev/null`
      case 'file': return `${fd} -> ${value.dev}:inode ${value.ino} (${value.flags}) offset ${value.pos}`
    }
  })
}

export class ControlPanel {
  private readonly trace: SysEntry[] = []
  private readonly listeners = new Set<() => void>()
  private snap!: Snapshot
  private ips = 0
  private ipsAt = 0
  private ipsCount = 0
  private frame = 0

  constructor(private readonly kernel: Kernel) {
    kernel.observer = {
      changed: () => this.scheduleRefresh(),
      syscall: (tick, pid, pname, call, result, blocked) => {
        const { ret, err } = formatResult(result, blocked)
        this.trace.push({ tick, pid, pname, text: formatCall(call), ret, err })
        if (this.trace.length > TRACE_MAX) this.trace.shift()
      },
    }
    this.refresh()
  }

  detach() {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.kernel.observer = null
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): Snapshot => this.snap

  invalidate() {
    this.refresh()
  }

  private scheduleRefresh() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.refresh()
    })
  }

  private refresh() {
    const now = performance.now()
    if (now - this.ipsAt >= 400) {
      this.ips = Math.round(((this.kernel.instructions - this.ipsCount) * 1000) / (now - this.ipsAt))
      this.ipsAt = now
      this.ipsCount = this.kernel.instructions
    }
    this.snap = this.build()
    for (const fn of this.listeners) fn()
  }

  private tree(path: string): FSNode {
    const k = this.kernel
    const node = k.vfs.resolve(path, '/')
    if ('err' in node)
      return { ino: 0, name: basename(path), type: 'file', size: 0, blocks: 0, exec: false, disk: '?', path, kids: [] }
    const fs = k.vfs.fsOf(node)
    const kids =
      node.type === T_DIR
        ? fs
            .entries(node.ino)
            .map((e) => this.tree(path === '/' ? `/${e.name}` : `${path}/${e.name}`))
            .sort((a, b) => a.name.localeCompare(b.name))
        : []

    const raw = node.type === T_FILE && node.size <= fs.maxFileSize() ? fs.readBytes(node.ino) : null
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
      data: raw && !binary ? clip(UTF8_DECODER.decode(raw), 1600) : undefined,
      disasm: exe ? disassemble(exe.image, exe.textLen, 48) : undefined,
      blockList: node.type === T_DEV ? undefined : fs.blocksOf(node.ino),
      kids,
    }
  }

  private build(): Snapshot {
    const k = this.kernel
    const m = k.mem.stats()
    const processes = k.processes()
    // Guest page_alloc updates only the physical bitmap and PCB PTEs. Rebuild
    // display ownership from those bytes rather than relying on host metadata.
    const frames: Frame[] = Array.from({ length: FRAME_COUNT }, (_, no) => ({
      no,
      owner: no < USER_FRAME_START || no >= KERNEL_TEXT_FRAME ? 'kernel' : null,
    }))
    for (const p of processes) {
      for (const pte of p.pageTable) {
        if (pte.supervisor || frames[pte.pfn]?.owner === 'kernel') continue
        frames[pte.pfn].owner = p.pid
      }
    }
    return {
      currentPid: k.runningPid,
      procs: processes.map((p) => ({
        pid: p.pid,
        ppid: p.ppid,
        name: p.name,
        cmd: p.cmd,
        state: p.state,
        pc: p.regs.pc,
        sp: p.regs.sp,
        ax: p.regs.ax,
        gprs: p.cpu ? Array.from({ length: 8 }, (_, i) => p.cpu!.regs[i]) : [],
        flags: p.cpu?.flag ?? 0,
        halted: p.cpu?.halted ?? false,
        cpuMode: p.cpu?.mode ?? null,
        irqEnabled: p.cpu?.irqEnabled ?? false,
        pendingIrq: p.cpu?.pendingIrq ?? null,
        cause: p.cpu?.cause ?? null,
        ivtBase: p.cpu?.ivtBase ?? null,
        ksp: p.cpu?.ksp ?? null,
        usp: p.cpu?.usp ?? null,
        pages: p.pageTable.length,
        ticksUsed: p.ticksUsed,
        cwd: p.cwd,
        children: processes.filter((child) => child.ppid === p.pid && child.pid !== p.pid).map((child) => child.pid),
        exitCode: p.exitCode,
        waitDesc: p.waitDesc() as string | null,
        pts: p.pageTable,
        fds: describeFds(p),
      })),
      frames,
      mem: { total: m.total, used: m.used, free: m.free, framesUsed: m.framesUsed },
      tree: this.tree('/'),
      fs: k.fsStats(),
      disks: k.blockDevices(),
      storageOk: k.storageReady,
      dirty: k.pendingWriteback,
      ips: this.ips,
      trace: this.trace,
      kmsgText: k.kmsg(),
      fgPid: k.foregroundPid,
      panic: k.panic,
    }
  }
}
