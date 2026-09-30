// 宿主侧文件系统层：在 ext2 之上提供系统需要的语义（类型、权限、属主、目录、设备节点）。
//
// 盘上格式的真相全部在 ext2.ts 里，这里不复制任何一份磁盘结构：
//   - 类型来自 i_mode 的 S_IFMT 位
//   - 权限就是 POSIX 位（M_* 现在是 0o755 这种真实掩码）
//   - 属主来自 i_uid，父目录来自目录里的 '..'
//   - 设备节点的次设备号放在 i_block[0] 的低字节（和 Linux 的 dev_t 布局一致）
//
// 这里另外提供一个 VFS：挂载表 + 跨设备路径解析，模拟真实内核的 vfsmount 查找。

import { BlockDev, SPECS } from '@/hw/disk'
import {
  BLOCK_SIZE,
  Ext2,
  NDIRECT,
  NINDIRECT,
  ROOT_INO,
  S_IFBLK,
  S_IFCHR,
  S_IFDIR,
  S_IFREG,
  formatExt2,
  modeType,
} from './ext2'
import type { Err } from './types'

// 宿主内部使用的类型常量（对应 ext2 的 S_IFMT 类别）
export const T_FILE = 1
export const T_DIR = 2
export const T_DEV = 3

// 设备节点的 driver 字段，等价于真实系统的次设备号
export const DRV_TTY = 1
export const DRV_NULL = 2

// POSIX 权限位。原来的 CRFS 用一套自造的扁平标志，现在直接用真实掩码。
export const M_EXEC = 0o100
export const M_WRITE = 0o200
export const M_READ = 0o400
export const M_GEXEC = 0o010
export const M_GWRITE = 0o020
export const M_GREAD = 0o040
export const M_OEXEC = 0o001
export const M_OWRITE = 0o002
export const M_OREAD = 0o004
export const M_STICKY = 0o1000
export const M_SETGID = 0o2000
export const M_SETUID = 0o4000

// 常用模式直接写八进制，和 ls -l / chmod 的读法一致，避免位名组合出错
export const MODE_FILE = 0o644
export const MODE_DIR = 0o755
export const MODE_DEV = 0o666
export const MODE_TMP = 0o1777

export const UID_ROOT = 0
export const UID_ROOT_NAME = 'root'

export interface FNode {
  dev: BlockDev
  ino: number
  type: number
  size: number
  exec: boolean
  uid: number
  mode: number
  driver: number
  name: string
  path: string
}

const _enc = new TextEncoder()
const _dec = new TextDecoder('utf-8', { fatal: false })
const encodeText = (s: string): Uint8Array => _enc.encode(s)
const dec = (b: Uint8Array): string => _dec.decode(b)

export const normalizePath = (path: string, cwd: string): string => {
  const raw = path.startsWith('/') ? path : cwd + '/' + path
  const parts: string[] = []
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return '/' + parts.join('/')
}
export const dirname = (abs: string): string => {
  const i = abs.lastIndexOf('/')
  return i <= 0 ? '/' : abs.slice(0, i)
}
export const basename = (abs: string): string => abs.slice(abs.lastIndexOf('/') + 1)

const errCode = (e: unknown): Err => {
  const msg = e instanceof Error ? e.message : String(e)
  const code = /^([A-Z]+):/.exec(msg)?.[1]
  return { err: code ?? 'EINVAL' }
}

export interface FSLayout {
  blockSize: number
  inodeSize: number
  inodeCount: number
  inodeTableBlock: number
  inodeTableByte: number
}

// ---------- 单个设备上的 ext2 文件系统 ----------

export class FS {
  private cached: Ext2 | null = null

  constructor(readonly dev: BlockDev) {}

  /**
   * 空盘或坏盘上构造 ext2 会抛错，所以这里只做尝试；
   * 所有操作都先过 valid()，没有通过就当设备上没有文件系统。
   */
  private tryExt(): Ext2 | null {
    if (this.cached) return this.cached
    try {
      this.cached = new Ext2(this.dev.bytes)
      return this.cached
    } catch {
      return null
    }
  }

  valid(): boolean {
    return this.tryExt() !== null
  }

  /** 抹掉这张盘，按 ext2 重新格式化；可移动盘出厂即 1777 的公共暂存区 */
  format(label: string) {
    const image = formatExt2({
      blockCount: this.dev.blockCount,
      inodeCount: this.dev.spec.inodeCount,
      label: label || this.dev.spec.name,
    })
    if (this.dev.spec.removable) new Ext2(image).chmod(ROOT_INO, MODE_TMP)
    this.dev.load(image)
    this.cached = null
  }

  /**
   * 盘上几何：CRX 内核要用 inode 表的字节偏移和 inode 总数来算偏移、验 inode 号。
   * 宿主只发布这些数字，inode 里的字段仍是内核自己按字节读的。
   */
  layout(): FSLayout | null {
    const e = this.tryExt()
    if (!e) return null
    return {
      blockSize: e.blockSize,
      inodeSize: e.inodeSize,
      inodeCount: e.inodeCount,
      inodeTableBlock: e.inodeTableBlock,
      inodeTableByte: e.inodeTableBlock * e.blockSize,
    }
  }

  label(): string {
    return this.tryExt()?.statfs().label ?? ''
  }

  get inodeCount(): number {
    return this.tryExt()?.statfs().inodes ?? this.dev.spec.inodeCount
  }

  inodeUsed(ino: number): boolean {
    return this.tryExt()?.isInodeUsed(ino) ?? false
  }

  itype(ino: number): number {
    const e = this.tryExt()
    if (!e || ino <= 0 || !e.isInodeUsed(ino)) return 0
    const t = modeType(e.readInode(ino).mode)
    if (t === S_IFDIR) return T_DIR
    if (t === S_IFCHR || t === S_IFBLK) return T_DEV
    return T_FILE
  }

  isize(ino: number): number {
    const e = this.tryExt()
    return e && ino > 0 && e.isInodeUsed(ino) ? e.readInode(ino).size : 0
  }

  /** 权限位（不含类型） */
  iflags(ino: number): number {
    const e = this.tryExt()
    return e && ino > 0 ? e.readInode(ino).mode & 0o7777 : 0
  }
  setFlags(ino: number, mode: number) {
    this.tryExt()?.chmod(ino, mode)
  }
  iexec(ino: number): boolean {
    return (this.iflags(ino) & 0o111) !== 0
  }
  setExec(ino: number, on: boolean) {
    const e = this.tryExt()
    if (!e || ino <= 0) return
    const mode = e.readInode(ino).mode & 0o7777
    e.chmod(ino, on ? mode | 0o111 : mode & ~0o111)
  }

  iowner(ino: number): number {
    const e = this.tryExt()
    return e && ino > 0 && e.isInodeUsed(ino) ? e.readInode(ino).uid : 0
  }
  setOwner(ino: number, uid: number) {
    this.tryExt()?.chown(ino, uid, 0)
  }

  /** ext2 的 inode 里没有父目录字段：父目录就是目录项 '..' */
  iparent(ino: number): number {
    const e = this.tryExt()
    if (!e || ino <= 0 || this.itype(ino) !== T_DIR) return 0
    return e.lookup(ino, '..')
  }

  idriver(ino: number): number {
    const e = this.tryExt()
    return e && ino > 0 ? e.readInode(ino).ptr[0] & 0xff : 0
  }
  setDriver(ino: number, d: number) {
    this.tryExt()?.setDevice(ino, d)
  }

  /** 该 inode 用到的数据块号（不含间接块自身） */
  blocksOf(ino: number): number[] {
    return this.tryExt()?.dataBlocksOf(ino) ?? []
  }

  maxFileSize(): number {
    return (NDIRECT + NINDIRECT) * BLOCK_SIZE
  }

  readBytes(ino: number): Uint8Array {
    return this.tryExt()?.readFile(ino) ?? new Uint8Array(0)
  }
  read(ino: number): string {
    return dec(this.readBytes(ino))
  }

  writeBytes(ino: number, data: Uint8Array): number | Err {
    const e = this.tryExt()
    if (!e) return { err: 'ENOSPC' }
    if (data.length > this.maxFileSize()) return { err: 'EFBIG' }
    try {
      e.writeFile(ino, data)
      return data.length
    } catch (err) {
      return errCode(err)
    }
  }
  write(ino: number, text: string): number | Err {
    return this.writeBytes(ino, encodeText(text))
  }

  /** 目录内容。'.' 与 '..' 不返回：调用方要的是"用户看得见的条目"。 */
  entries(ino: number): { name: string; ino: number; type: number }[] {
    const e = this.tryExt()
    if (!e || this.itype(ino) !== T_DIR) return []
    try {
      return e
        .listDir(ino)
        .filter((x) => x.name !== '.' && x.name !== '..')
        .map((x) => ({ name: x.name, ino: x.ino, type: this.itype(x.ino) }))
    } catch {
      return []
    }
  }

  lookup(dirIno: number, name: string): number {
    const e = this.tryExt()
    if (!e || this.itype(dirIno) !== T_DIR) return 0
    try {
      return e.lookup(dirIno, name)
    } catch {
      return 0
    }
  }

  create(dirIno: number, name: string, type: number): number | Err {
    const e = this.tryExt()
    if (!e) return { err: 'ENOSPC' }
    try {
      if (type === T_DIR) return e.mkdir(dirIno, name, MODE_DIR)
      if (type === T_DEV) return e.create(dirIno, name, S_IFCHR | MODE_DEV)
      return e.create(dirIno, name, S_IFREG | MODE_FILE)
    } catch (err) {
      return errCode(err)
    }
  }

  unlink(dirIno: number, name: string): 0 | Err {
    const e = this.tryExt()
    if (!e) return { err: 'ENOENT' }
    try {
      e.unlink(dirIno, name)
      return 0
    } catch (err) {
      return errCode(err)
    }
  }

  rename(oldDir: number, oldName: string, newDir: number, newName: string): 0 | Err {
    const e = this.tryExt()
    if (!e) return { err: 'ENOENT' }
    try {
      e.rename(oldDir, oldName, newDir, newName)
      return 0
    } catch (err) {
      return errCode(err)
    }
  }

  usedBlocks(): number {
    const s = this.tryExt()?.statfs()
    return s ? s.blocks - s.freeBlocks : 0
  }
  freeBlocks(): number {
    return this.tryExt()?.statfs().freeBlocks ?? 0
  }
  usedInodes(): number {
    const s = this.tryExt()?.statfs()
    return s ? s.inodes - s.freeInodes : 0
  }

  /** /etc/passwd 是否已就位（账户表的"已初始化"标志就隐含在这张表本身） */
  accountsReady(): boolean {
    const ino = lookupAbs(this, '/etc/passwd')
    return ino !== 0 && this.isize(ino) > 0
  }

  /** 存储面板用的块用途图：元数据、位图、inode 表、目录、文件、空闲 */
  blockMap(): { no: number; kind: string; label: string }[] {
    const out: { no: number; kind: string; label: string }[] = []
    for (let b = 0; b < this.dev.blockCount; b++) out.push({ no: b, kind: 'free', label: '' })
    const e = this.tryExt()
    if (!e) return out
    const mark = (no: number, kind: string, label: string) => {
      if (no >= 0 && no < out.length) out[no] = { no, kind, label }
    }
    mark(0, 'super', 'boot block')
    mark(1, 'super', 'superblock (s_magic 0xEF53)')
    mark(2, 'super', 'block group descriptor')
    mark(e.blockBitmapBlock, 'bitmap', `block bitmap (${e.blockCount} bits)`)
    mark(e.inodeBitmapBlock, 'bitmap', `inode bitmap (${e.inodeCount} bits)`)
    for (let b = e.inodeTableBlock; b < e.inodeTableBlock + Math.ceil((e.inodesPerGroup * e.inodeSize) / BLOCK_SIZE); b++) {
      mark(b, 'itable', 'inode table')
    }
    for (let ino = 1; ino <= e.inodeCount; ino++) {
      if (!e.isInodeUsed(ino)) continue
      const inode = e.readInode(ino)
      if (modeType(inode.mode) === S_IFCHR || modeType(inode.mode) === S_IFBLK) continue
      const kind = modeType(inode.mode) === S_IFDIR ? 'dir' : 'file'
      const label = `${this.pathOfQuiet(ino)} (inode ${ino})`
      for (const b of e.dataBlocksOf(ino)) mark(b, kind, label)
      if (inode.ptr[NDIRECT]) mark(inode.ptr[NDIRECT], 'data', `indirect block for inode ${ino}`)
    }
    return out
  }

  private pathOfQuiet(ino: number): string {
    try {
      return this.tryExt()?.pathOf(ino) ?? '?'
    } catch {
      return '?'
    }
  }
}

export function lookupAbs(fs: FS, path: string): number {
  let ino = ROOT_INO
  for (const seg of path.split('/').filter(Boolean)) {
    const next = fs.lookup(ino, seg)
    if (!next) return 0
    ino = next
  }
  return ino
}

/**
 * 系统盘权限策略。ext2 格式化时目录已经是 0755、文件 0644，这里只补那些
 * "出厂设置里没有、但语义上必须存在"的例外：/tmp 是 1777 的公共暂存区
 * （sticky 位让普通用户删不掉别人的文件）。
 */
export function applySystemPolicy(fs: FS) {
  const tmp = lookupAbs(fs, '/tmp')
  if (tmp && fs.itype(tmp) === T_DIR) {
    fs.setOwner(tmp, UID_ROOT)
    fs.setFlags(tmp, MODE_TMP)
  }
}

/** 标准 ls -l 风格的 9 字符权限串 */
export function modeText(mode: number): string {
  const bit = (mask: number, ch: string) => ((mode & mask) !== 0 ? ch : '-')
  const ownerX = (mode & M_EXEC) !== 0 ? ((mode & M_SETUID) !== 0 ? 's' : 'x') : (mode & M_SETUID) !== 0 ? 'S' : '-'
  const otherX = (mode & M_OEXEC) !== 0 ? ((mode & M_STICKY) !== 0 ? 't' : 'x') : (mode & M_STICKY) !== 0 ? 'T' : '-'
  return (
    bit(M_READ, 'r') +
    bit(M_WRITE, 'w') +
    ownerX +
    bit(M_GREAD, 'r') +
    bit(M_GWRITE, 'w') +
    bit(M_GEXEC, 'x') +
    bit(M_OREAD, 'r') +
    bit(M_OWRITE, 'w') +
    otherX
  )
}

// ---------- VFS：挂载表 + 跨设备路径解析 ----------

export interface Mount {
  path: string
  fs: FS
}

export class VFS {
  readonly mounts: Mount[] = []

  mount(path: string, fs: FS) {
    this.mounts.push({ path, fs })
    this.mounts.sort((a, b) => b.path.length - a.path.length)
  }

  umount(path: string): boolean {
    const i = this.mounts.findIndex((m) => m.path === path)
    if (i < 0) return false
    this.mounts.splice(i, 1)
    return true
  }

  mountAt(path: string): Mount | null {
    return this.mounts.find((m) => m.path === path) ?? null
  }

  // 最长前缀匹配，模拟真实内核的 vfsmount 查找
  private owner(abs: string): Mount {
    return this.mounts.find((m) => m.path === '/' || abs === m.path || abs.startsWith(m.path + '/'))!
  }

  resolve(path: string, cwd: string): FNode | Err {
    const abs = normalizePath(path, cwd)
    const m = this.owner(abs)
    const rel = abs.slice(m.path === '/' ? 0 : m.path.length) || '/'
    let ino = ROOT_INO
    let name = m.path === '/' ? '/' : basename(m.path)
    if (rel !== '/') {
      for (const seg of rel.slice(1).split('/')) {
        if (!seg) continue
        if (m.fs.itype(ino) !== T_DIR) return { err: 'ENOTDIR' }
        const next = m.fs.lookup(ino, seg)
        if (!next) return { err: 'ENOENT' }
        ino = next
        name = seg
      }
    }
    return this.node(m.fs, ino, name, abs)
  }

  node(fs: FS, ino: number, name: string, path: string): FNode {
    return {
      dev: fs.dev,
      ino,
      type: fs.itype(ino),
      size: fs.isize(ino),
      exec: fs.iexec(ino),
      uid: fs.iowner(ino),
      mode: fs.iflags(ino),
      driver: fs.idriver(ino),
      name,
      path,
    }
  }

  fsOf(node: FNode): FS {
    return this.mounts.find((m) => m.fs.dev === node.dev)!.fs
  }

  fsFor(abs: string): FS {
    return this.owner(abs).fs
  }

  // 该绝对路径是否为某个设备的挂载点
  isMountPoint(abs: string): boolean {
    return this.mounts.some((m) => m.path === abs && m.path !== '/')
  }
}

/**
 * 本机系统盘的参照几何。CRX 机器码是按固定布局汇编的（inode 表在哪、位图在哪、
 * 块总数多少都是常量），别的布局它读不了：挂载前、把 .img 当系统盘引导前，
 * 都要拿这张表核对。宿主只发布事实，几何不符一律拒绝。几何是常量，算一次就够。
 */
let geometryCache: FSLayout | null | undefined
export function systemGeometry(): FSLayout | null {
  if (geometryCache !== undefined) return geometryCache
  const dev = new BlockDev(SPECS.sda)
  dev.load(formatExt2({ blockCount: SPECS.sda.blockCount, inodeCount: SPECS.sda.inodeCount, label: 'geometry' }))
  geometryCache = new FS(dev).layout()
  return geometryCache
}

/** 两份盘上几何是否逐字段一致（任一侧缺失即不符） */
export function sameGeometry(a: FSLayout | null, b: FSLayout | null): boolean {
  if (!a || !b) return false
  return (
    a.blockSize === b.blockSize &&
    a.inodeSize === b.inodeSize &&
    a.inodeCount === b.inodeCount &&
    a.inodeTableBlock === b.inodeTableBlock &&
    a.inodeTableByte === b.inodeTableByte
  )
}
