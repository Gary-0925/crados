// CRFS：一个真实的盘上文件系统，全部结构都是设备字节数组里的字段
//
// 盘上布局
//   block 0        超级块
//   block 1        块位图（每 bit 一个块）
//   block 2        inode 位图
//   block 3..k     inode 表（每个 inode 32 字节）
//   block k+1..    数据块
//
// 文件的起止怎么标记：inode 里有 12 个直接块指针和一个 16 位 size 字段。
// 块指针给出文件占用了哪些块（不要求连续），size 给出最后一块用到第几字节。
// 目录同样是文件，它的数据是一串 16 字节的目录项（inode 号 + 名字）。

import { BlockDev } from './blockdev'
import type { Err } from './types'

export const MAGIC = 0x43524653 // "CRFS"
export const INODE_SIZE = 32
export const NDIRECT = 12
export const DIRENT_SIZE = 16
export const NAME_MAX = 14

export const T_FREE = 0
export const T_FILE = 1
export const T_DIR = 2
export const T_DEV = 3

// 超级块字段偏移
const SB_MAGIC = 0
const SB_BSIZE = 4
const SB_BLOCKS = 6
const SB_INODES = 8
const SB_ITABLE = 10
const SB_DATA = 12
const SB_LABEL = 16
const LABEL_MAX = 16

// inode 字段偏移
const I_TYPE = 0
const I_FLAGS = 1
const I_SIZE = 2
const I_PARENT = 4
const I_DRIVER = 6
const I_PTR = 8

export interface FNode {
  dev: BlockDev
  ino: number
  type: number
  size: number
  exec: boolean
  driver: number
  name: string
  path: string
}

const enc = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}
const dec = (b: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < b.length; i += 0x4000) s += String.fromCharCode(...b.subarray(i, i + 0x4000))
  return s
}

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

// ---------- 单个设备上的文件系统 ----------

export class CRFS {
  readonly itableStart: number
  readonly dataStart: number
  readonly inodeCount: number

  constructor(readonly dev: BlockDev) {
    this.inodeCount = dev.spec.inodeCount
    this.itableStart = 3
    const itableBlocks = Math.ceil((this.inodeCount * INODE_SIZE) / dev.blockSize)
    this.dataStart = this.itableStart + itableBlocks
  }

  // mkfs：把设备清零并写入超级块、位图、根目录
  format(label: string) {
    this.dev.bytes.fill(0)
    const d = this.dev
    d.setU16(SB_MAGIC, MAGIC >>> 16)
    d.setU16(SB_MAGIC + 2, MAGIC & 0xffff)
    d.setU16(SB_BSIZE, d.blockSize)
    d.setU16(SB_BLOCKS, d.blockCount)
    d.setU16(SB_INODES, this.inodeCount)
    d.setU16(SB_ITABLE, this.itableStart)
    d.setU16(SB_DATA, this.dataStart)
    const name = enc(label.slice(0, LABEL_MAX))
    d.bytes.set(name, SB_LABEL)
    for (let b = 0; b < this.dataStart; b++) this.setBlockBit(b, true) // 元数据区预占
    const root = this.allocInode(T_DIR, 0)
    if (root !== 1) throw new Error('mkfs: root inode must be 1')
  }

  valid(): boolean {
    return ((this.dev.u16(SB_MAGIC) << 16) | this.dev.u16(SB_MAGIC + 2)) >>> 0 === MAGIC
  }

  label(): string {
    return dec(this.dev.bytes.subarray(SB_LABEL, SB_LABEL + LABEL_MAX)).replace(/\0+$/, '')
  }

  setLabel(s: string) {
    this.dev.bytes.fill(0, SB_LABEL, SB_LABEL + LABEL_MAX)
    this.dev.bytes.set(enc(s.slice(0, LABEL_MAX)), SB_LABEL)
  }

  // ---------- 位图 ----------

  private bitAt(bitmapBlock: number, idx: number): boolean {
    const at = bitmapBlock * this.dev.blockSize + (idx >> 3)
    return (this.dev.u8(at) & (1 << (idx & 7))) !== 0
  }
  private setBit(bitmapBlock: number, idx: number, on: boolean) {
    const at = bitmapBlock * this.dev.blockSize + (idx >> 3)
    const cur = this.dev.u8(at)
    this.dev.setU8(at, on ? cur | (1 << (idx & 7)) : cur & ~(1 << (idx & 7)))
  }
  blockUsed(no: number): boolean {
    return this.bitAt(1, no)
  }
  private setBlockBit(no: number, on: boolean) {
    this.setBit(1, no, on)
  }
  inodeUsed(ino: number): boolean {
    return this.bitAt(2, ino)
  }

  private allocBlock(): number {
    for (let b = this.dataStart; b < this.dev.blockCount; b++) {
      if (!this.blockUsed(b)) {
        this.setBlockBit(b, true)
        this.dev.block(b).fill(0)
        return b
      }
    }
    return -1
  }
  private freeBlock(no: number) {
    if (no <= 0) return
    this.setBlockBit(no, false)
    this.dev.block(no).fill(0)
  }

  // ---------- inode ----------

  private inodeAt(ino: number): number {
    return this.itableStart * this.dev.blockSize + ino * INODE_SIZE
  }

  private allocInode(type: number, parent: number): number {
    for (let i = 1; i < this.inodeCount; i++) {
      if (this.inodeUsed(i)) continue
      this.setBit(2, i, true)
      const at = this.inodeAt(i)
      this.dev.bytes.fill(0, at, at + INODE_SIZE)
      this.dev.setU8(at + I_TYPE, type)
      this.dev.setU16(at + I_PARENT, parent)
      return i
    }
    return -1
  }

  itype(ino: number): number {
    return this.dev.u8(this.inodeAt(ino) + I_TYPE)
  }
  isize(ino: number): number {
    return this.dev.u16(this.inodeAt(ino) + I_SIZE)
  }
  private setSize(ino: number, n: number) {
    this.dev.setU16(this.inodeAt(ino) + I_SIZE, n)
  }
  iexec(ino: number): boolean {
    return (this.dev.u8(this.inodeAt(ino) + I_FLAGS) & 1) !== 0
  }
  setExec(ino: number, on: boolean) {
    const at = this.inodeAt(ino) + I_FLAGS
    const cur = this.dev.u8(at)
    this.dev.setU8(at, on ? cur | 1 : cur & ~1)
  }
  iparent(ino: number): number {
    return this.dev.u16(this.inodeAt(ino) + I_PARENT)
  }
  private setParent(ino: number, p: number) {
    this.dev.setU16(this.inodeAt(ino) + I_PARENT, p)
  }
  idriver(ino: number): number {
    return this.dev.u8(this.inodeAt(ino) + I_DRIVER)
  }
  setDriver(ino: number, d: number) {
    this.dev.setU8(this.inodeAt(ino) + I_DRIVER, d)
  }

  ptr(ino: number, k: number): number {
    return this.dev.u16(this.inodeAt(ino) + I_PTR + k * 2)
  }
  private setPtr(ino: number, k: number, b: number) {
    this.dev.setU16(this.inodeAt(ino) + I_PTR + k * 2, b)
  }

  blocksOf(ino: number): number[] {
    const out: number[] = []
    for (let k = 0; k < NDIRECT; k++) {
      const b = this.ptr(ino, k)
      if (b) out.push(b)
    }
    return out
  }

  maxFileSize(): number {
    return NDIRECT * this.dev.blockSize
  }

  // ---------- 文件数据：按块读写 ----------

  readBytes(ino: number): Uint8Array {
    const size = this.isize(ino)
    const out = new Uint8Array(size)
    let at = 0
    for (let k = 0; k < NDIRECT && at < size; k++) {
      const b = this.ptr(ino, k)
      if (!b) break
      const chunk = this.dev.block(b)
      const n = Math.min(chunk.length, size - at)
      out.set(chunk.subarray(0, n), at)
      at += n
    }
    return out
  }

  read(ino: number): string {
    return dec(this.readBytes(ino))
  }

  writeBytes(ino: number, data: Uint8Array): number | Err {
    if (data.length > this.maxFileSize()) return { err: 'EFBIG' }
    const need = Math.ceil(data.length / this.dev.blockSize)
    const have = this.blocksOf(ino)
    if (need > have.length) {
      const free = this.freeBlocks()
      if (need - have.length > free) return { err: 'ENOSPC' }
    }
    for (const b of have) this.freeBlock(b)
    for (let k = 0; k < NDIRECT; k++) this.setPtr(ino, k, 0)
    for (let k = 0; k < need; k++) {
      const b = this.allocBlock()
      if (b < 0) {
        this.setSize(ino, 0)
        return { err: 'ENOSPC' }
      }
      this.setPtr(ino, k, b)
      this.dev.writeBlock(b, data.subarray(k * this.dev.blockSize, (k + 1) * this.dev.blockSize))
    }
    this.setSize(ino, data.length)
    return data.length
  }

  write(ino: number, text: string): number | Err {
    return this.writeBytes(ino, enc(text))
  }

  // 部分读：只碰落在 [pos, pos+len) 区间内的那几个块
  readAt(ino: number, pos: number, len: number): Uint8Array {
    const size = this.isize(ino)
    const end = Math.min(size, pos + len)
    if (pos >= end) return new Uint8Array(0)
    const out = new Uint8Array(end - pos)
    const bs = this.dev.blockSize
    for (let at = pos; at < end; ) {
      const k = Math.floor(at / bs)
      const b = this.ptr(ino, k)
      const inBlock = at % bs
      const n = Math.min(bs - inBlock, end - at)
      if (b) out.set(this.dev.block(b).subarray(inBlock, inBlock + n), at - pos)
      at += n
    }
    return out
  }

  // 部分写：按需分配块，只改写受影响的块，size 只在文件被撑大时增长
  writeAt(ino: number, pos: number, data: Uint8Array): number | Err {
    const bs = this.dev.blockSize
    const end = pos + data.length
    if (end > this.maxFileSize()) return { err: 'EFBIG' }

    const lastK = Math.ceil(end / bs) - 1
    let needed = 0
    for (let k = 0; k <= lastK; k++) if (!this.ptr(ino, k)) needed++
    if (needed > this.freeBlocks()) return { err: 'ENOSPC' }

    for (let at = pos; at < end; ) {
      const k = Math.floor(at / bs)
      let b = this.ptr(ino, k)
      if (!b) {
        b = this.allocBlock()
        if (b < 0) return { err: 'ENOSPC' }
        this.setPtr(ino, k, b)
      }
      const inBlock = at % bs
      const n = Math.min(bs - inBlock, end - at)
      this.dev.block(b).set(data.subarray(at - pos, at - pos + n), inBlock)
      at += n
    }
    if (end > this.isize(ino)) this.setSize(ino, end)
    return data.length
  }

  truncate(ino: number) {
    for (const b of this.blocksOf(ino)) this.freeBlock(b)
    for (let k = 0; k < NDIRECT; k++) this.setPtr(ino, k, 0)
    this.setSize(ino, 0)
  }

  // ---------- 目录项 ----------

  entries(ino: number): { name: string; ino: number }[] {
    const raw = this.readBytes(ino)
    const out: { name: string; ino: number }[] = []
    for (let at = 0; at + DIRENT_SIZE <= raw.length; at += DIRENT_SIZE) {
      const child = (raw[at] << 8) | raw[at + 1]
      if (!child) continue
      const name = dec(raw.subarray(at + 2, at + DIRENT_SIZE)).replace(/\0+$/, '')
      if (name) out.push({ name, ino: child })
    }
    return out
  }

  private writeEntries(ino: number, list: { name: string; ino: number }[]): number | Err {
    const raw = new Uint8Array(list.length * DIRENT_SIZE)
    list.forEach((e, i) => {
      const at = i * DIRENT_SIZE
      raw[at] = (e.ino >> 8) & 0xff
      raw[at + 1] = e.ino & 0xff
      raw.set(enc(e.name.slice(0, NAME_MAX)), at + 2)
    })
    return this.writeBytes(ino, raw)
  }

  lookup(dirIno: number, name: string): number {
    for (const e of this.entries(dirIno)) if (e.name === name) return e.ino
    return 0
  }

  link(dirIno: number, name: string, ino: number): 0 | Err {
    const list = this.entries(dirIno)
    if (list.some((e) => e.name === name)) return { err: 'EEXIST' }
    list.push({ name, ino })
    const r = this.writeEntries(dirIno, list)
    return typeof r === 'number' ? 0 : r
  }

  unlink(dirIno: number, name: string): 0 | Err {
    const list = this.entries(dirIno).filter((e) => e.name !== name)
    const r = this.writeEntries(dirIno, list)
    return typeof r === 'number' ? 0 : r
  }

  create(dirIno: number, name: string, type: number): number | Err {
    if (name.length > NAME_MAX) return { err: 'ENAMETOOLONG' }
    if (this.lookup(dirIno, name)) return { err: 'EEXIST' }
    const ino = this.allocInode(type, dirIno)
    if (ino < 0) return { err: 'ENOSPC' }
    const r = this.link(dirIno, name, ino)
    if (r !== 0) {
      this.setBit(2, ino, false)
      return r
    }
    return ino
  }

  destroy(ino: number) {
    for (const b of this.blocksOf(ino)) this.freeBlock(b)
    const at = this.inodeAt(ino)
    this.dev.bytes.fill(0, at, at + INODE_SIZE)
    this.setBit(2, ino, false)
  }

  reparent(ino: number, parent: number) {
    this.setParent(ino, parent)
  }

  // ---------- 统计 ----------

  usedBlocks(): number {
    let n = 0
    for (let b = 0; b < this.dev.blockCount; b++) if (this.blockUsed(b)) n++
    return n
  }
  freeBlocks(): number {
    return this.dev.blockCount - this.usedBlocks()
  }
  usedInodes(): number {
    let n = 0
    for (let i = 1; i < this.inodeCount; i++) if (this.inodeUsed(i)) n++
    return n
  }

  // 块地图：供窥探面板标注每一块的用途
  blockMap(): { no: number; kind: string; label: string }[] {
    const map = Array.from({ length: this.dev.blockCount }, (_, no) => ({
      no,
      kind: this.blockUsed(no) ? 'data' : 'free',
      label: this.blockUsed(no) ? 'allocated' : 'free',
    }))
    map[0] = { no: 0, kind: 'super', label: 'superblock' }
    map[1] = { no: 1, kind: 'bitmap', label: 'block bitmap' }
    map[2] = { no: 2, kind: 'bitmap', label: 'inode bitmap' }
    for (let b = this.itableStart; b < this.dataStart; b++)
      map[b] = { no: b, kind: 'itable', label: `inode table ${b - this.itableStart}` }
    for (let ino = 1; ino < this.inodeCount; ino++) {
      if (!this.inodeUsed(ino)) continue
      const type = this.itype(ino)
      const blocks = this.blocksOf(ino)
      blocks.forEach((b, k) => {
        map[b] = {
          no: b,
          kind: type === T_DIR ? 'dir' : 'file',
          label: `inode ${ino} ${type === T_DIR ? 'dirents' : 'data'} block ${k}`,
        }
      })
    }
    return map
  }
}

// ---------- VFS：挂载表 + 跨设备路径解析 ----------

export interface Mount {
  path: string
  fs: CRFS
}

export class VFS {
  readonly mounts: Mount[] = []

  mount(path: string, fs: CRFS) {
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

  root(): CRFS {
    return this.mounts[this.mounts.length - 1].fs
  }

  resolve(path: string, cwd: string): FNode | Err {
    const abs = normalizePath(path, cwd)
    const m = this.owner(abs)
    const rel = abs.slice(m.path === '/' ? 0 : m.path.length) || '/'
    let ino = 1
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

  node(fs: CRFS, ino: number, name: string, path: string): FNode {
    return {
      dev: fs.dev,
      ino,
      type: fs.itype(ino),
      size: fs.isize(ino),
      exec: fs.iexec(ino),
      driver: fs.idriver(ino),
      name,
      path,
    }
  }

  fsOf(node: FNode): CRFS {
    return this.mounts.find((m) => m.fs.dev === node.dev)!.fs
  }

  fsFor(abs: string): CRFS {
    return this.owner(abs).fs
  }

  // 该绝对路径是否为某个设备的挂载点
  isMountPoint(abs: string): boolean {
    return this.mounts.some((m) => m.path === abs && m.path !== '/')
  }
}
