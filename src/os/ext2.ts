// ext2 格式层：真正按 ext2 规范读写的文件系统，不再有自定义的 CRFS 结构。
//
// 为什么是 ext2 而不是 ext4：这个系统要的是"一张盘的全部真相都能被看懂"。
// ext2 的每个结构都可讲——超级块、块位图、inode 位图、inode 表、直接块 + 一级
// 间接块、线性目录（rec_len 链）。ext4 多出来的部分（extent 树、日志、元数据
// 校验和、htree 目录索引、flex_bg、64 位块号）对教学内核只是额外的实现量与
// 看不见的状态，所以一个都不要。
//
// 采用的配置（经典 ext2 rev 1）：
//
//   块大小 1024（s_log_block_size = 0）    目录项 rec_len 链式布局
//   inode 128 字节                        块位图 / inode 位图
//   小端 32 位字段（CRX 只有 16 位寄存器，字节仍按小端摆放）
//   直接块 12 个 + 一级间接块             s_magic = 0xEF53
//
//   s_feature_compat    不用
//   s_feature_incompat  只用 filetype（目录项里带类型字节）
//   s_feature_ro_compat sparse_super | large_file（我们自己从不写 resize_inode，
//                       但别的工具造的盘带这一位时我们读得进）
//
// 验收方式不是"自己说自己对"，而是用真的 e2fs 工具：
//   npm run ext2   → 生成镜像，交给 e2fsck/debugfs/dumpe2fs 检查，并反向解析 mkfs 造出的盘

export const EXT2_MAGIC = 0xef53
export const BLOCK_SIZE = 1024
export const INODE_SIZE = 128
export const BOOT_BLOCK = 0 // 块 0 留给引导，不用
export const SB_BLOCK = 1 // 超级块在块 1（1 KiB 块大小）
export const GDT_BLOCK = 2
export const ROOT_INO = 2
export const LOST_FOUND_INO = 11
export const FIRST_INO = 11
export const SECTOR = 512 // i_blocks 以 512 字节扇区计数

// s_feature_*：只保留我们真的能解释的特性
export const FEATURE_COMPAT = 0x0000
export const FEATURE_INCOMPAT_FILE_TYPE = 0x0002
export const FEATURE_RO_SPARSE_SUPER = 0x0001
export const FEATURE_RO_LARGE_FILE = 0x0002
// resize_inode 只表示"预留了若干 GDT 块"，读盘不受影响。别的工具造的 ext2 盘
// 常带这一位，所以我们接受它，但自己从不设置。
export const FEATURE_RO_RESIZE_INODE = 0x0010
export const FEATURE_RO_DIR_NLINK = 0x0020

// i_mode 的类型位
export const S_IFREG = 0x8000
export const S_IFDIR = 0x4000
export const S_IFCHR = 0x2000
export const S_IFBLK = 0x6000
export const S_IFIFO = 0x1000
export const S_IFSOCK = 0xc000
export const S_IFMT = 0xf000

// 目录项的 file_type 字节
export const FT_REG = 1
export const FT_DIR = 2
export const FT_CHR = 3
export const FT_BLK = 4
export const FT_FIFO = 5
export const FT_SOCK = 6
export const FT_LINK = 7

// inode 字段偏移（相对 inode 起始字节）。u32 低半在低地址——小端。
export const I_MODE = 0x00
export const I_UID = 0x02
export const I_SIZE = 0x04
/** i_dtime：释放 inode 的时间戳，ext2 约定删除过的 inode 这里非 0 */
export const I_DTIME = 0x14
/** i_blocks：占用的 512 字节扇区数（1 KiB 块 → 每块 2） */
export const I_BLOCKS = 0x1c
export const I_LINKS = 0x1a
export const I_BLOCK = 0x28

// 目录项字段偏移
export const D_INO = 0x00
export const D_REC_LEN = 0x04
export const D_NAME_LEN = 0x06
export const D_FILE_TYPE = 0x07
export const D_NAME = 0x08

// 超级块与块组描述符里我们真正用到的字段
export const SB_INODES = 0x00
export const SB_BLOCKS = 0x04
export const SB_FREE_BLOCKS = 0x0c
export const SB_FREE_INODES = 0x10
export const SB_FIRST_DATA_BLOCK = 0x14
export const SB_MAGIC = 0x38
export const SB_INODE_SIZE = 0x58
export const BG_BLOCK_BITMAP = 0x00
export const BG_INODE_BITMAP = 0x04
export const BG_INODE_TABLE = 0x08
/** 目录计数：新建/删除目录时要跟着加减，否则 e2fsck 报 Directories count wrong */
export const BG_USED_DIRS = 0x10
export const BG_FREE_BLOCKS = 0x0c
export const BG_FREE_INODES = 0x0e

export const NDIRECT = 12 // i_block[0..11]
export const NINDIRECT = BLOCK_SIZE / 4 // 一级间接块能放 256 个块号

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: false })

export const modeType = (mode: number): number => mode & S_IFMT
export const fileTypeOf = (mode: number): number =>
  modeType(mode) === S_IFDIR
    ? FT_DIR
    : modeType(mode) === S_IFCHR
      ? FT_CHR
      : modeType(mode) === S_IFBLK
        ? FT_BLK
        : modeType(mode) === S_IFIFO
          ? FT_FIFO
          : modeType(mode) === S_IFSOCK
            ? FT_SOCK
            : FT_REG

export interface Ext2Inode {
  ino: number
  mode: number
  uid: number
  gid: number
  size: number
  links: number
  atime: number
  ctime: number
  mtime: number
  dtime: number
  /** i_block 的 15 个指针，直接块 + 间接块（原样给出，便于调试） */
  ptr: number[]
}

export interface DirEntry {
  ino: number
  name: string
  type: number
  /** 目录项记录在目录文件里的字节偏移 */
  at: number
  recLen: number
  nameLen: number
}

export interface Ext2Options {
  blockCount?: number
  inodeCount?: number
  label?: string
  uuid?: Uint8Array
  now?: number
}

const align = (n: number, to: number) => Math.ceil(n / to) * to

export interface Ext2Layout {
  blockSize: number
  inodeSize: number
  inodeCount: number
  blockCount: number
  blockBitmapBlock: number
  inodeBitmapBlock: number
  inodeTableBlock: number
  inodeTableByte: number
  firstDataBlock: number
  blocksPerGroup: number
}

/**
 * 单块组 ext2 的元数据布局。宿主格式化用它，CRX 机器码也用它算常量——
 * 两边只有一个来源，不会漂移。
 */
export function ext2Layout(blockCount: number, inodeCount: number): Ext2Layout {
  const blockBitmapBlock = GDT_BLOCK + 1
  const inodeBitmapBlock = blockBitmapBlock + 1
  const inodeTableBlock = inodeBitmapBlock + 1
  const inodeTableBlocks = align((inodeCount * INODE_SIZE) / BLOCK_SIZE, 1)
  const firstDataBlock = inodeTableBlock + inodeTableBlocks
  return {
    blockSize: BLOCK_SIZE,
    inodeSize: INODE_SIZE,
    inodeCount,
    blockCount,
    blockBitmapBlock,
    inodeBitmapBlock,
    inodeTableBlock,
    inodeTableByte: inodeTableBlock * BLOCK_SIZE,
    firstDataBlock,
    blocksPerGroup: 8192,
  }
}

/** 生成一张全新的 ext2 盘（mke2fs 的最小可用子集：单块组、rev 1、无扩展特性）。 */
export function formatExt2(opts: Ext2Options = {}): Uint8Array {
  const blockCount = opts.blockCount ?? 1024
  const inodeCount = opts.inodeCount ?? 256
  const shape = ext2Layout(blockCount, inodeCount)
  const blocksPerGroup = shape.blocksPerGroup
  const inodesPerGroup = inodeCount
  const groupCount = Math.ceil((blockCount - 1) / blocksPerGroup)
  if (groupCount > 1) throw new Error(`ext2 布局只支持单块组，${blockCount} 个块需要 ${groupCount} 组`)

  const bytes = new Uint8Array(blockCount * BLOCK_SIZE)
  const view = new DataView(bytes.buffer)
  const now = opts.now ?? Math.floor(Date.now() / 1000)

  // 元数据区布局来自 ext2Layout()：块 1 超级块、块 2 块组描述符、两张位图、inode 表
  const blockBitmapBlock = shape.blockBitmapBlock
  const inodeBitmapBlock = shape.inodeBitmapBlock
  const inodeTableBlock = shape.inodeTableBlock
  const firstDataBlock = shape.firstDataBlock
  const overhead = firstDataBlock - 1 // 块 1..firstDataBlock-1 都是元数据
  if (overhead + 2 > blockCount) throw new Error('块数太少，放不下元数据区')

  const sb = SB_BLOCK * BLOCK_SIZE
  view.setUint32(sb + 0x00, inodeCount, true)
  view.setUint32(sb + 0x04, blockCount, true)
  view.setUint32(sb + 0x08, 0, true) // s_r_blocks_count_lo
  view.setUint32(sb + 0x14, 1, true) // s_first_data_block
  view.setUint32(sb + 0x18, 0, true) // s_log_block_size → 1024
  view.setUint32(sb + 0x1c, 0, true) // s_log_cluster_size
  view.setUint32(sb + 0x20, blocksPerGroup, true)
  view.setUint32(sb + 0x24, blocksPerGroup, true)
  view.setUint32(sb + 0x28, inodesPerGroup, true)
  view.setUint32(sb + 0x2c, 0, true) // s_mtime：干净的盘没有挂载时间
  view.setUint32(sb + 0x30, now, true) // s_wtime
  view.setUint16(sb + 0x34, 0, true) // s_mnt_count
  view.setUint16(sb + 0x36, 0xffff, true) // s_max_mnt_count = -1
  view.setUint16(sb + 0x38, EXT2_MAGIC, true)
  view.setUint16(sb + 0x3a, 1, true) // s_state = clean
  view.setUint16(sb + 0x3c, 1, true) // s_errors = continue
  view.setUint16(sb + 0x3e, 0, true) // s_minor_rev_level
  view.setUint32(sb + 0x40, now, true) // s_lastcheck
  view.setUint32(sb + 0x44, 0, true) // s_checkinterval = 0（不按时间强制检查）
  view.setUint32(sb + 0x48, 0, true) // s_creator_os = Linux
  view.setUint32(sb + 0x4c, 1, true) // s_rev_level = dynamic
  view.setUint16(sb + 0x50, 0, true)
  view.setUint16(sb + 0x52, 0, true)
  view.setUint32(sb + 0x54, FIRST_INO, true)
  view.setUint16(sb + 0x58, INODE_SIZE, true)
  view.setUint16(sb + 0x5a, 0, true)
  view.setUint32(sb + 0x5c, FEATURE_COMPAT, true)
  view.setUint32(sb + 0x60, FEATURE_INCOMPAT_FILE_TYPE, true)
  view.setUint32(sb + 0x64, FEATURE_RO_SPARSE_SUPER | FEATURE_RO_LARGE_FILE , true)
  view.setUint32(sb + 0xf8, now, true) // s_mkfs_time
  const uuid = opts.uuid ?? crypto.getRandomValues(new Uint8Array(16))
  bytes.set(uuid.subarray(0, 16), sb + 0x68)
  const label = enc.encode((opts.label ?? 'crados').slice(0, 16))
  bytes.set(label, sb + 0x78)

  // 块组描述符
  const gd = GDT_BLOCK * BLOCK_SIZE
  view.setUint32(gd + 0x00, blockBitmapBlock, true)
  view.setUint32(gd + 0x04, inodeBitmapBlock, true)
  view.setUint32(gd + 0x08, inodeTableBlock, true)
  view.setUint16(gd + 0x10, 0, true) // bg_used_dirs_count：等根目录与 lost+found 建好后再写

  const fs = new Ext2(bytes)
  // 元数据块在位图里预占，e2fsck 要求位图与 inode 表/元数据一致
  for (let b = 1; b < firstDataBlock; b++) fs.setBlockUsed(b, true)
  // inode 1..FIRST_INO-1 是保留区（inode 1 = 坏块表，其余留给将来），mke2fs 也是这么标的
  for (let ino = 1; ino < FIRST_INO; ino++) fs.setInodeUsed(ino, true)
  fs.sealBitmapPadding()

  const initDir = (ino: number, parent: number) => {
    fs.initInode(ino, S_IFDIR | 0o755, 0, 0)
    fs.writeDirData(ino, [
      { ino, name: '.', type: FT_DIR },
      { ino: parent, name: '..', type: FT_DIR },
    ])
  }
  initDir(ROOT_INO, ROOT_INO)
  fs.setLinks(ROOT_INO, 3) // . + lost+found 的 ..

  initDir(LOST_FOUND_INO, ROOT_INO)
  fs.bumpDirs()
  fs.addDirEntry(ROOT_INO, 'lost+found', LOST_FOUND_INO, FT_DIR)
  fs.flushCounters(now)
  return bytes
}

/** 从字节数组解析并操作一张 ext2 盘。 */
export class Ext2 {
  readonly bytes: Uint8Array
  private readonly view: DataView
  readonly blockSize: number
  readonly inodeSize: number
  readonly inodeCount: number
  readonly blockCount: number
  readonly firstDataBlock: number
  readonly blocksPerGroup: number
  readonly inodesPerGroup: number
  readonly inodeTableBlock: number
  readonly blockBitmapBlock: number
  readonly inodeBitmapBlock: number

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const sb = SB_BLOCK * BLOCK_SIZE
    if (this.u16(sb + 0x38) !== EXT2_MAGIC) throw new Error('不是 ext2 文件系统：s_magic 不匹配')
    const logBlock = this.u32(sb + 0x18)
    if (logBlock !== 0) throw new Error(`只支持 1 KiB 块（s_log_block_size = ${logBlock}）`)
    const incompat = this.u32(sb + 0x60)
    if (incompat & ~FEATURE_INCOMPAT_FILE_TYPE) {
      throw new Error(`不支持的 s_feature_incompat: 0x${incompat.toString(16)}`)
    }
    const ro = this.u32(sb + 0x64)
    if (ro & ~(FEATURE_RO_SPARSE_SUPER | FEATURE_RO_LARGE_FILE | FEATURE_RO_RESIZE_INODE)) {
      throw new Error(`不支持的 s_feature_ro_compat: 0x${ro.toString(16)}`)
    }
    this.blockSize = BLOCK_SIZE
    this.inodeSize = this.u16(sb + 0x58)
    if (this.inodeSize !== INODE_SIZE) throw new Error(`不支持 ${this.inodeSize} 字节的 inode`)
    this.inodeCount = this.u32(sb + 0x00)
    this.blockCount = this.u32(sb + 0x04)
    this.firstDataBlock = this.u32(sb + 0x14)
    this.blocksPerGroup = this.u32(sb + 0x20)
    this.inodesPerGroup = this.u32(sb + 0x28)
    const gd = GDT_BLOCK * BLOCK_SIZE
    this.blockBitmapBlock = this.u32(gd + 0x00)
    this.inodeBitmapBlock = this.u32(gd + 0x04)
    this.inodeTableBlock = this.u32(gd + 0x08)
    if (this.bytes.length < this.blockCount * BLOCK_SIZE) throw new Error('镜像字节数少于超级块声明的块数')
  }

  get groupCount(): number {
    return Math.ceil((this.blockCount - this.firstDataBlock) / this.blocksPerGroup)
  }

  // ---------- 小端字段 ----------
  u8(at: number): number {
    return this.bytes[at]
  }
  u16(at: number): number {
    return this.view.getUint16(at, true)
  }
  u32(at: number): number {
    return this.view.getUint32(at, true)
  }
  setU8(at: number, v: number) {
    this.bytes[at] = v & 0xff
  }
  setU16(at: number, v: number) {
    this.view.setUint16(at, v & 0xffff, true)
  }
  setU32(at: number, v: number) {
    this.view.setUint32(at, v >>> 0, true)
  }
  readBlock(no: number): Uint8Array {
    return this.bytes.subarray(no * this.blockSize, (no + 1) * this.blockSize)
  }

  // ---------- 位图 ----------
  private bitAt(bitmapBlock: number, index: number): boolean {
    const at = bitmapBlock * this.blockSize + (index >> 3)
    return (this.bytes[at] & (1 << (index & 7))) !== 0
  }
  private setBitAt(bitmapBlock: number, index: number, on: boolean) {
    const at = bitmapBlock * this.blockSize + (index >> 3)
    const mask = 1 << (index & 7)
    if (on) this.bytes[at] |= mask
    else this.bytes[at] &= ~mask
  }
  /** 数据块在位图里的下标：块组 0 的位图从 first_data_block 开始计数 */
  private blockIndex(block: number): number {
    return block - this.firstDataBlock
  }
  isBlockUsed(block: number): boolean {
    return this.bitAt(this.blockBitmapBlock, this.blockIndex(block))
  }
  setBlockUsed(block: number, used: boolean) {
    this.setBitAt(this.blockBitmapBlock, this.blockIndex(block), used)
    this.afterBitmapChange()
  }
  isInodeUsed(ino: number): boolean {
    return this.bitAt(this.inodeBitmapBlock, ino - 1)
  }
  setInodeUsed(ino: number, used: boolean) {
    this.setBitAt(this.inodeBitmapBlock, ino - 1, used)
    this.afterBitmapChange()
  }
  private afterBitmapChange() {
    const sb = SB_BLOCK * this.blockSize
    const freeBlocks = this.countFree(this.blockBitmapBlock, this.blockCount - this.firstDataBlock)
    this.setU32(sb + 0x0c, freeBlocks)
    this.setU16(GDT_BLOCK * this.blockSize + 0x0c, Math.min(freeBlocks, 0xffff))
    const freeInodes = this.countFree(this.inodeBitmapBlock, this.inodeCount)
    this.setU32(sb + 0x10, freeInodes)
    this.setU16(GDT_BLOCK * this.blockSize + 0x0e, Math.min(freeInodes, 0xffff))
  }
  private countFree(bitmapBlock: number, count: number): number {
    let free = 0
    for (let i = 0; i < count; i++) if (!this.bitAt(bitmapBlock, i)) free++
    return free
  }
  /** 把超级块的时间戳与挂载计数更新成"已检查过的干净盘" */
  flushCounters(now = Math.floor(Date.now() / 1000)) {
    const sb = SB_BLOCK * this.blockSize
    this.setU32(sb + 0x40, now)
    this.setU32(sb + 0x30, now)
    this.afterBitmapChange()
  }
  /** 目录计数：bg_used_dirs_count 必须与实际目录数一致 */
  bumpDirs() {
    const sb = SB_BLOCK * this.blockSize
    const dirs = this.countDirs()
    this.setU16(GDT_BLOCK * this.blockSize + 0x10, dirs)
    this.setU16(sb + 0x34, this.u16(sb + 0x34)) // 保持 mnt_count 不变
  }
  private countDirs(): number {
    let dirs = 0
    for (let ino = 1; ino <= this.inodeCount; ino++) {
      if (!this.isInodeUsed(ino)) continue
      if (modeType(this.readInode(ino).mode) === S_IFDIR) dirs++
    }
    return dirs
  }

  /**
   * 位图末尾的填充位必须置 1：位图按块组大小（8192 位）分配，而本盘只有 1024 个块，
   * 多出来的位表示"不可用"，置 1 之后 e2fsck 才不会报 "padding is not set"。
   */
  sealBitmapPadding() {
    const seal = (bitmapBlock: number, valid: number) => {
      for (let i = valid; i < this.blockSize * 8; i++) this.setBitAt(bitmapBlock, i, true)
    }
    seal(this.blockBitmapBlock, this.blockCount - this.firstDataBlock)
    seal(this.inodeBitmapBlock, this.inodesPerGroup)
    this.afterBitmapChange()
  }

  allocBlock(): number {
    for (let b = this.firstDataBlock; b < this.blockCount; b++) {
      if (!this.isBlockUsed(b)) {
        this.setBlockUsed(b, true)
        this.bytes.fill(0, b * this.blockSize, (b + 1) * this.blockSize)
        return b
      }
    }
    return 0
  }
  freeBlock(block: number) {
    if (block < this.firstDataBlock || block >= this.blockCount) return
    this.setBlockUsed(block, false)
  }
  allocInode(): number {
    for (let ino = FIRST_INO; ino <= this.inodeCount; ino++) {
      if (!this.isInodeUsed(ino)) {
        this.setInodeUsed(ino, true)
        return ino
      }
    }
    return 0
  }
  freeInode(ino: number) {
    this.setInodeUsed(ino, false)
    this.bytes.fill(0, this.inodeOffset(ino), this.inodeOffset(ino) + this.inodeSize)
    this.bumpDirs()
  }

  // ---------- inode ----------
  inodeOffset(ino: number): number {
    return this.inodeTableBlock * this.blockSize + (ino - 1) * this.inodeSize
  }
  readInode(ino: number): Ext2Inode {
    const at = this.inodeOffset(ino)
    const ptr: number[] = []
    for (let i = 0; i < 15; i++) ptr.push(this.u32(at + 0x28 + i * 4))
    return {
      ino,
      mode: this.u16(at + 0x00),
      uid: this.u16(at + 0x02),
      size: this.u32(at + 0x04),
      atime: this.u32(at + 0x08),
      ctime: this.u32(at + 0x0c),
      mtime: this.u32(at + 0x10),
      dtime: this.u32(at + 0x14),
      gid: this.u16(at + 0x18),
      links: this.u16(at + 0x1a),
      ptr,
    }
  }
  /**
   * 写回 inode。`ptr` 决定是否连 i_block 的 15 个块指针一起写：
   * 指针由 blockFor / freeInodeData 单独维护，调用方手里那份 inode 往往是
   * 之前读的旧副本，拿它去覆盖指针会把刚分配的块从 inode 里抹掉。
   */
  writeInode(ino: number, inode: Ext2Inode, ptr = false) {
    const at = this.inodeOffset(ino)
    this.setU16(at + 0x00, inode.mode)
    this.setU16(at + 0x02, inode.uid)
    this.setU32(at + 0x04, inode.size)
    this.setU32(at + 0x08, inode.atime)
    this.setU32(at + 0x0c, inode.ctime)
    this.setU32(at + 0x10, inode.mtime)
    this.setU32(at + 0x14, inode.dtime)
    this.setU16(at + 0x18, inode.gid)
    this.setU16(at + 0x1a, inode.links)
    if (!ptr) return
    for (let i = 0; i < 15; i++) this.setU32(at + 0x28 + i * 4, inode.ptr[i] ?? 0)
    this.syncInodeBlocks(inode)
  }
  /** i_blocks 以 512 字节扇区计，e2fsck 会逐 inode 核对 */
  private syncInodeBlocks(inode: Ext2Inode) {
    const at = this.inodeOffset(inode.ino)
    const type = modeType(inode.mode)
    if (type === S_IFCHR || type === S_IFBLK) {
      // 设备节点的 i_block[0] 存的是设备号，不是数据块
      this.setU32(at + 0x1c, 0)
      return
    }
    const data = this.dataBlocksOf(inode.ino)
    const indirect = inode.ptr[NDIRECT] ? 1 : 0
    this.setU32(at + 0x1c, (data.length + indirect) * (this.blockSize / SECTOR))
  }

  /**
   * 字符/块设备节点的设备号。ext2 把它放在 i_block[0] 里（Linux 的 dev_t 布局：
   * 低 8 位是次设备号），这样 nodem 之外的实现不用额外字段就能识别设备。
   */
  setDevice(ino: number, devnum: number) {
    const inode = this.readInode(ino)
    inode.ptr[0] = devnum >>> 0
    this.writeInode(ino, inode, true)
  }
  setLinks(ino: number, links: number) {
    this.setU16(this.inodeOffset(ino) + 0x1a, links)
  }
  /** 建成一个新 inode：位图、模式、时间戳、链接数 */
  initInode(ino: number, mode: number, uid: number, gid: number, now = Math.floor(Date.now() / 1000)): Ext2Inode {
    this.setInodeUsed(ino, true)
    const inode: Ext2Inode = { ino, mode, uid, gid, size: 0, links: 1, atime: now, ctime: now, mtime: now, dtime: 0, ptr: new Array(15).fill(0) }
    this.writeInode(ino, inode, true)
    return inode
  }

  /** 该 inode 用到的数据块号（不含间接块自身） */
  dataBlocksOf(ino: number): number[] {
    const inode = this.readInode(ino)
    const out: number[] = []
    for (let i = 0; i < NDIRECT; i++) if (inode.ptr[i]) out.push(inode.ptr[i])
    const indirect = inode.ptr[NDIRECT]
    if (indirect) {
      for (let i = 0; i < NINDIRECT; i++) {
        const b = this.u32(indirect * this.blockSize + i * 4)
        if (b) out.push(b)
      }
    }
    return out
  }

  /** 把文件第 index 个逻辑块映射到物理块，missing 为 true 时分配一个 */
  private blockFor(ino: number, index: number, alloc: boolean): number {
    const inode = this.readInode(ino)
    if (index < NDIRECT) {
      let b = inode.ptr[index]
      if (!b && alloc) {
        b = this.allocBlock()
        inode.ptr[index] = b
        this.writeInode(ino, inode, true)
      }
      return b
    }
    const iIndex = index - NDIRECT
    if (iIndex >= NINDIRECT) throw new Error('文件超过 12 + 256 块（ext2 实现只做到一级间接）')
    let indirect = inode.ptr[NDIRECT]
    if (!indirect) {
      if (!alloc) return 0
      indirect = this.allocBlock()
      inode.ptr[NDIRECT] = indirect
      this.writeInode(ino, inode, true)
    }
    const at = indirect * this.blockSize + iIndex * 4
    let b = this.u32(at)
    if (!b && alloc) {
      b = this.allocBlock()
      this.setU32(at, b)
      this.writeInode(ino, inode, true) // 间接块里多了一个块号：同步 i_blocks
    }
    return b
  }

  private freeInodeData(ino: number) {
    const inode = this.readInode(ino)
    for (const b of this.dataBlocksOf(ino)) this.freeBlock(b)
    if (inode.ptr[NDIRECT]) this.freeBlock(inode.ptr[NDIRECT])
    inode.ptr = new Array(15).fill(0)
    inode.size = 0
    this.writeInode(ino, inode, true)
  }

  // ---------- 文件 ----------
  readFile(ino: number): Uint8Array {
    const inode = this.readInode(ino)
    if (modeType(inode.mode) !== S_IFREG) return new Uint8Array(0)
    const out = new Uint8Array(inode.size)
    for (let index = 0; index * this.blockSize < inode.size; index++) {
      const b = this.blockFor(ino, index, false)
      const from = index * this.blockSize
      const n = Math.min(this.blockSize, inode.size - from)
      if (b) out.set(this.bytes.subarray(b * this.blockSize, b * this.blockSize + n), from)
    }
    return out
  }

  writeFile(ino: number, data: Uint8Array, now = Math.floor(Date.now() / 1000)) {
    const inode = this.readInode(ino)
    const need = Math.ceil(data.length / this.blockSize)
    for (let index = 0; index < need; index++) {
      const b = this.blockFor(ino, index, true)
      const from = index * this.blockSize
      const n = Math.min(this.blockSize, data.length - from)
      this.bytes.fill(0, b * this.blockSize, (b + 1) * this.blockSize)
      this.bytes.set(data.subarray(from, from + n), b * this.blockSize)
    }
    // 变短了就把多余的数据块还给位图
    const old = Math.ceil(inode.size / this.blockSize)
    for (let index = need; index < old; index++) {
      const b = this.blockFor(ino, index, false)
      if (!b) continue
      this.freeBlock(b)
      this.clearBlockPointer(ino, index)
    }
    inode.size = data.length
    inode.mtime = now
    inode.ctime = now
    this.writeInode(ino, inode) // 只写元数据，块指针已经在 blockFor 里落盘
  }

  private clearBlockPointer(ino: number, index: number) {
    const inode = this.readInode(ino)
    if (index < NDIRECT) inode.ptr[index] = 0
    else {
      const indirect = inode.ptr[NDIRECT]
      if (indirect) this.setU32(indirect * this.blockSize + (index - NDIRECT) * 4, 0)
    }
    this.writeInode(ino, inode, true)
  }

  // ---------- 目录 ----------
  listDir(ino: number): DirEntry[] {
    const inode = this.readInode(ino)
    if (modeType(inode.mode) !== S_IFDIR) throw new Error(`inode ${ino} 不是目录`)
    const out: DirEntry[] = []
    for (let offset = 0; offset + 8 <= inode.size; ) {
      const b = Math.floor(offset / this.blockSize)
      const inBlock = offset % this.blockSize
      const block = this.blockFor(ino, b, false)
      if (!block) break
      const at = block * this.blockSize + inBlock
      const recLen = this.u16(at + 4)
      const nameLen = this.u8(at + 6)
      const childIno = this.u32(at + 0)
      if (recLen < 8 || inBlock + recLen > this.blockSize) throw new Error(`inode ${ino} 偏移 ${offset} 的目录项 rec_len=${recLen} 非法`)
      if (childIno !== 0) {
        const name = dec.decode(this.bytes.subarray(at + 8, at + 8 + nameLen))
        out.push({ ino: childIno, name, type: this.u8(at + 7), at, recLen, nameLen })
      }
      offset += recLen
    }
    return out
  }

  lookup(dirIno: number, name: string): number {
    for (const e of this.listDir(dirIno)) if (e.name === name) return e.ino
    return 0
  }

  /** 目录项需要对齐到 4 字节 */
  private static entrySize(nameLen: number): number {
    return align(8 + nameLen, 4)
  }

  addDirEntry(dirIno: number, name: string, childIno: number, type: number): void {
    const raw = enc.encode(name)
    if (raw.length > 255) throw new Error('文件名超过 255 字节')
    const need = Ext2.entrySize(raw.length)
    const inode = this.readInode(dirIno)
    let offset = 0
    while (offset < inode.size) {
      const b = Math.floor(offset / this.blockSize)
      const inBlock = offset % this.blockSize
      const block = this.blockFor(dirIno, b, false)
      const at = block * this.blockSize + inBlock
      const recLen = this.u16(at + 4)
      if (recLen < 8) throw new Error(`inode ${dirIno} 偏移 ${offset} 的 rec_len=${recLen}，目录项链断了`)
      const used = Ext2.entrySize(this.u8(at + 6))
      if (this.u32(at) === 0 && recLen >= need) {
        // 整条空闲项：直接占用
        this.setU32(at, childIno)
        this.setU16(at + 4, recLen)
        this.setU8(at + 6, raw.length)
        this.setU8(at + 7, type)
        this.bytes.set(raw, at + 8)
        return
      }
      if (recLen - used >= need) {
        // 拆分：前面的项缩短，空出来的部分放新项
        this.setU16(at + 4, used)
        const at2 = at + used
        this.setU32(at2, childIno)
        this.setU16(at2 + 4, recLen - used)
        this.setU8(at2 + 6, raw.length)
        this.setU8(at2 + 7, type)
        this.bytes.set(raw, at2 + 8)
        return
      }
      offset += recLen
    }
    // 目录里没有空位：追加一个整块，并把新块写成一条大空闲项
    if (inode.size % this.blockSize !== 0) throw new Error('目录大小不是块整数倍')
    const b = this.blockFor(dirIno, inode.size / this.blockSize, true)
    const at = b * this.blockSize
    this.setU32(at, childIno)
    this.setU16(at + 4, this.blockSize)
    this.setU8(at + 6, raw.length)
    this.setU8(at + 7, type)
    this.bytes.set(raw, at + 8)
    inode.size += this.blockSize
    inode.mtime = Math.floor(Date.now() / 1000)
    this.writeInode(dirIno, inode)
  }

  removeDirEntry(dirIno: number, name: string): boolean {
    const entries = this.listDir(dirIno)
    const target = entries.find((e) => e.name === name)
    if (!target) return false
    if (name === '.' || name === '..') throw new Error('不能删除 . 或 ..')
    const isLast = target.at + target.recLen === Math.floor(target.at / this.blockSize) * this.blockSize + this.blockSize
    if (isLast) {
      // 块里最后一项：只清 inode 号，保留 rec_len 当作空闲空间
      this.setU32(target.at, 0)
      this.setU8(target.at + 6, 0)
    } else {
      // 与前一项合并：把 rec_len 并进前一条记录
      const prev = [...entries].reverse().find((e) => e.at < target.at)
      if (!prev) throw new Error('目录项前面没有可合并的记录')
      this.setU16(prev.at + 4, prev.recLen + target.recLen)
    }
    const inode = this.readInode(dirIno)
    inode.mtime = Math.floor(Date.now() / 1000)
    this.writeInode(dirIno, inode)
    return true
  }

  /** 把整个目录内容重写成给定的若干项（用于初始化 . 与 ..） */
  writeDirData(dirIno: number, entries: Array<{ ino: number; name: string; type: number }>) {
    const inode = this.readInode(dirIno)
    const block = this.blockFor(dirIno, 0, true)
    this.bytes.fill(0, block * this.blockSize, (block + 1) * this.blockSize)
    let offset = 0
    entries.forEach((e, i) => {
      const raw = enc.encode(e.name)
      const size = i === entries.length - 1 ? this.blockSize - offset : Ext2.entrySize(raw.length)
      const at = block * this.blockSize + offset
      this.setU32(at, e.ino)
      this.setU16(at + 4, size)
      this.setU8(at + 6, raw.length)
      this.setU8(at + 7, e.type)
      this.bytes.set(raw, at + 8)
      offset += size
    })
    inode.size = this.blockSize
    inode.links = 2
    this.writeInode(dirIno, inode)
  }

  // ---------- 路径与高层操作 ----------
  resolve(path: string, cwd = '/'): number {
    let ino = cwd === '/' ? ROOT_INO : this.resolve(cwd)
    for (const seg of path.split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') {
        const parent = this.lookup(ino, '..')
        ino = parent || ROOT_INO
        continue
      }
      const next = this.lookup(ino, seg)
      if (!next) return 0
      ino = next
    }
    return ino
  }

  /**
   * 由 inode 反查路径。目录可以靠 '..' 逐级上溯，普通文件没有 '..'，
   * 所以统一从根往下找：ext2 的目录是线性表，这一步就是深度优先搜索。
   */
  pathOf(ino: number): string {
    if (ino === ROOT_INO) return '/'
    return this.findPath(ROOT_INO, ino, [], 0) ?? '?'
  }

  private findPath(parent: number, target: number, trail: string[], depth: number): string | null {
    if (depth > 32) return null
    for (const e of this.listDir(parent)) {
      if (e.name === '.' || e.name === '..') continue
      const path = [...trail, e.name]
      if (e.ino === target) return '/' + path.join('/')
      if (e.type === FT_DIR) {
        const found = this.findPath(e.ino, target, path, depth + 1)
        if (found) return found
      }
    }
    return null
  }

  create(parentIno: number, name: string, mode: number, uid = 0, gid = 0): number {
    if (this.lookup(parentIno, name)) throw new Error(`EEXIST: ${name}`)
    const ino = this.allocInode()
    if (!ino) throw new Error('ENOSPC: inode 用完了')
    // mode 只给权限位时按普通文件处理：i_mode 必须带类型位，否则 e2fsck 判为非法 inode
    this.initInode(ino, (mode & S_IFMT) === 0 ? S_IFREG | (mode & 0o7777) : mode, uid, gid)
    this.addDirEntry(parentIno, name, ino, fileTypeOf(mode))
    return ino
  }

  mkdir(parentIno: number, name: string, mode = 0o755, uid = 0, gid = 0): number {
    if (this.lookup(parentIno, name)) throw new Error(`EEXIST: ${name}`)
    const ino = this.allocInode()
    if (!ino) throw new Error('ENOSPC: inode 用完了')
    this.initInode(ino, S_IFDIR | (mode & 0o7777), uid, gid)
    this.writeDirData(ino, [
      { ino, name: '.', type: FT_DIR },
      { ino: parentIno, name: '..', type: FT_DIR },
    ])
    this.addDirEntry(parentIno, name, ino, FT_DIR)
    const parent = this.readInode(parentIno)
    parent.links += 1 // 新目录的 .. 指向父目录
    this.writeInode(parentIno, parent)
    this.bumpDirs()
    return ino
  }

  unlink(parentIno: number, name: string): void {
    const ino = this.lookup(parentIno, name)
    if (!ino) throw new Error(`ENOENT: ${name}`)
    const inode = this.readInode(ino)
    if (modeType(inode.mode) === S_IFDIR) {
      const kids = this.listDir(ino).filter((e) => e.name !== '.' && e.name !== '..')
      if (kids.length) throw new Error(`ENOTEMPTY: ${name}`)
      const parent = this.readInode(parentIno)
      parent.links = Math.max(1, parent.links - 1)
      this.writeInode(parentIno, parent)
    }
    this.removeDirEntry(parentIno, name)
    inode.links -= 1
    if (inode.links <= 0) {
      this.freeInodeData(ino)
      inode.links = 0
      inode.dtime = Math.floor(Date.now() / 1000)
      this.writeInode(ino, inode)
      this.freeInode(ino)
    } else {
      inode.ctime = Math.floor(Date.now() / 1000)
      this.writeInode(ino, inode)
    }
  }

  rename(oldParent: number, oldName: string, newParent: number, newName: string): void {
    const ino = this.lookup(oldParent, oldName)
    if (!ino) throw new Error(`ENOENT: ${oldName}`)
    const existing = this.lookup(newParent, newName)
    if (existing) this.unlink(newParent, newName)
    this.removeDirEntry(oldParent, oldName)
    this.addDirEntry(newParent, newName, ino, fileTypeOf(this.readInode(ino).mode))
    if (oldParent !== newParent && modeType(this.readInode(ino).mode) === S_IFDIR) {
      const dir = this.listDir(ino).find((e) => e.name === '..')
      if (dir) {
        this.setU32(dir.at, newParent)
        const oldP = this.readInode(oldParent)
        oldP.links = Math.max(1, oldP.links - 1)
        this.writeInode(oldParent, oldP)
        const newP = this.readInode(newParent)
        newP.links += 1
        this.writeInode(newParent, newP)
      }
    }
  }

  chmod(ino: number, mode: number) {
    const inode = this.readInode(ino)
    inode.mode = (inode.mode & S_IFMT) | (mode & 0o7777)
    inode.ctime = Math.floor(Date.now() / 1000)
    this.writeInode(ino, inode)
  }

  chown(ino: number, uid: number, gid: number) {
    const inode = this.readInode(ino)
    inode.uid = uid
    inode.gid = gid
    inode.ctime = Math.floor(Date.now() / 1000)
    this.writeInode(ino, inode)
  }

  statfs() {
    const sb = SB_BLOCK * this.blockSize
    return {
      blocks: this.blockCount,
      freeBlocks: this.u32(sb + 0x0c),
      inodes: this.inodeCount,
      freeInodes: this.u32(sb + 0x10),
      blockSize: this.blockSize,
      label: dec.decode(this.bytes.subarray(sb + 0x78, sb + 0x78 + 16)).replace(/\0+$/, ''),
    }
  }
}
