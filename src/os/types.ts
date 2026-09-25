// crados 内核公共类型：系统调用协议、进程状态、错误码
// 用户态程序只能通过 yield 一个 Syscall 对象陷入内核，与真实 CPU 的 int 0x80 对应

export type PState = 'new' | 'ready' | 'running' | 'blocked' | 'zombie'
export interface ReadBytes {
  bytes: Uint8Array
}

export type Syscall =
  | { call: 'yield' }
  | { call: 'write'; fd: number; data: string | Uint8Array }
  | { call: 'read'; fd: number; len?: number }
  | { call: 'open'; path: string; flags: 'r' | 'w' | 'a' }
  | { call: 'close'; fd: number }
  | { call: 'dup'; fd: number }
  | { call: 'dup2'; from: number; to: number }
  | { call: 'readdir'; path: string }
  | { call: 'stat'; path: string }
  | { call: 'mkdir'; path: string }
  | { call: 'unlink'; path: string }
  | { call: 'rename'; from: string; to: string }
  | { call: 'chmod'; path: string; exec: boolean }
  | { call: 'chdir'; path: string }
  | { call: 'getcwd' }
  | { call: 'spawn'; path: string; args: string[] }
  | { call: 'exit'; code: number }
  | { call: 'wait'; pid: number }
  | { call: 'sleep'; ticks: number }
  | { call: 'sleepSeconds'; seconds: number }
  | { call: 'kill'; pid: number; sig: number }
  | { call: 'getpid' }
  | { call: 'getenv'; key: string }
  | { call: 'tcsetpgrp'; pid: number }
  | { call: 'view'; kind: number; arg: string }
  | { call: 'assemble'; source: string; output: string }
  | { call: 'mount'; dev: string; dir: string }
  | { call: 'umount'; target: string }
  | { call: 'sync' }
  | { call: 'time' }

// 进程体：一个不断 yield 系统调用的生成器，内核是它的唯一执行者
export type Gen = Generator<Syscall, any, any>

export interface Err {
  err: string
}
export const isErr = (v: unknown): v is Err =>
  typeof v === 'object' && v !== null && 'err' in v

export const ERRMSG: Record<string, string> = {
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EEXIST: 'File exists',
  EBADF: 'Bad file descriptor',
  ENOMEM: 'Cannot allocate memory',
  ENOSPC: 'No space left on device',
  EFBIG: 'File too large',
  ENAMETOOLONG: 'File name too long',
  EAGAIN: 'Resource temporarily unavailable',
  ENOTEMPTY: 'Directory not empty',
  ESRCH: 'No such process',
  ECHILD: 'No child processes',
  ENOEXEC: 'Exec format error',
  EPERM: 'Operation not permitted',
  EACCES: 'Permission denied',
  ENODEV: 'No such device',
  EBUSY: 'Device or resource busy',
  EINVAL: 'Invalid argument',
  EXDEV: 'Invalid cross-device link',
}

export const strerror = (e: { err: string }): string => ERRMSG[e.err] ?? e.err

// 用户态库：构造系统调用请求的辅助函数（相当于 libc wrapper）
export const sys = {
  yield: (): Syscall => ({ call: 'yield' }),
  write: (fd: number, data: string | Uint8Array): Syscall => ({ call: 'write', fd, data }),
  read: (fd: number, len?: number): Syscall => ({ call: 'read', fd, len }),
  open: (path: string, flags: 'r' | 'w' | 'a' = 'r'): Syscall => ({ call: 'open', path, flags }),
  close: (fd: number): Syscall => ({ call: 'close', fd }),
  dup: (fd: number): Syscall => ({ call: 'dup', fd }),
  dup2: (from: number, to: number): Syscall => ({ call: 'dup2', from, to }),
  readdir: (path: string): Syscall => ({ call: 'readdir', path }),
  stat: (path: string): Syscall => ({ call: 'stat', path }),
  mkdir: (path: string): Syscall => ({ call: 'mkdir', path }),
  unlink: (path: string): Syscall => ({ call: 'unlink', path }),
  rename: (from: string, to: string): Syscall => ({ call: 'rename', from, to }),
  chmod: (path: string, exec: boolean): Syscall => ({ call: 'chmod', path, exec }),
  chdir: (path: string): Syscall => ({ call: 'chdir', path }),
  getcwd: (): Syscall => ({ call: 'getcwd' }),
  spawn: (path: string, args: string[] = []): Syscall => ({ call: 'spawn', path, args }),
  exit: (code: number): Syscall => ({ call: 'exit', code }),
  wait: (pid: number): Syscall => ({ call: 'wait', pid }),
  sleep: (ticks: number): Syscall => ({ call: 'sleep', ticks }),
  sleepSeconds: (seconds: number): Syscall => ({ call: 'sleepSeconds', seconds }),
  kill: (pid: number, sig = 15): Syscall => ({ call: 'kill', pid, sig }),
  getpid: (): Syscall => ({ call: 'getpid' }),
  getenv: (key: string): Syscall => ({ call: 'getenv', key }),
  tcsetpgrp: (pid: number): Syscall => ({ call: 'tcsetpgrp', pid }),
  view: (kind: number, arg = ''): Syscall => ({ call: 'view', kind, arg }),
  assemble: (source: string, output: string): Syscall => ({ call: 'assemble', source, output }),
  mount: (dev: string, dir: string): Syscall => ({ call: 'mount', dev, dir }),
  umount: (target: string): Syscall => ({ call: 'umount', target }),
  sync: (): Syscall => ({ call: 'sync' }),
  time: (): Syscall => ({ call: 'time' }),
}

export interface ProcInfo {
  pid: number
  ppid: number
  name: string
  state: PState
  cmd: string
  pages: number
  ticks: number
}

export interface BlkInfo {
  name: string
  model: string
  size: number
  used: number
  blocks: number
  usedBlocks: number
  blockSize: number
  removable: boolean
  present: boolean
  mountpoint: string | null
  persistent: boolean
}
