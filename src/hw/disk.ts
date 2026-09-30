// 虚拟硬件：块设备。一块真实的字节数组，所有读写都以块为单位。
//
// 设备上的内容就是文件系统的全部真相，没有任何 JS 对象在旁边"影子存储"。
// 这台机器认得出哪些盘、每块盘多大、怎么整盘读写，但不认识盘上的格式：
// ext2 的超级块、inode、位图都是操作系统的事（os/ext2.ts）。

export interface DevSpec {
  name: string
  model: string
  blockSize: number
  blockCount: number
  inodeCount: number
  removable: boolean
}

export const SDA_INODES = 256

// 系统盘固定 1 MiB / 1024 块、块大小 1 KiB：出厂镜像（os/rootimg.ts）与导入的
// .img 都按这个几何造，CRX 机器码也是按它写死的。一张块位图（1 KiB = 8192 位）
// 覆盖整个块组，因此 8192 块是这套实现的自然上限。
export const SPECS: Record<string, DevSpec> = {
  sda: { name: 'sda', model: 'CRADOS-ROOT', blockSize: 1024, blockCount: 1024, inodeCount: SDA_INODES, removable: false },
}

// 可移动设备按 sdb、sdc、sdd… 顺序占位，容量与根盘一致，便于整盘互换
export const diskSpec = (name: string): DevSpec => ({
  name,
  model: 'CRADOS-DISK',
  blockSize: SPECS.sda.blockSize,
  blockCount: SPECS.sda.blockCount,
  inodeCount: SPECS.sda.inodeCount,
  removable: true,
})

// 磁盘控制器上的设备号：sdX 是 1..26，与 CRX 内核看到的号一致
export const deviceCode = (name: string): number => {
  const m = /^sd([a-z])$/.exec(name)
  return m ? m[1].charCodeAt(0) - 96 : 0
}

export const deviceName = (code: number): string =>
  code >= 1 && code <= 26 ? 'sd' + String.fromCharCode(96 + code) : ''

// sdb 起按字母递增，跳过已占用的名字；盘位用满返回 null
export function nextDiskName(taken: Iterable<string>): string | null {
  const used = new Set(taken)
  for (let i = 1; i < 26; i++) {
    const name = 'sd' + String.fromCharCode(97 + i)
    if (!used.has(name)) return name
  }
  return null
}

export class BlockDev {
  readonly bytes: Uint8Array
  readonly blockSize: number
  readonly blockCount: number
  /** 上一次持久化时的内容：回写时只写变化的分块，不必每次重写整盘 */
  readonly shadow: Uint8Array

  constructor(readonly spec: DevSpec) {
    this.blockSize = spec.blockSize
    this.blockCount = spec.blockCount
    this.bytes = new Uint8Array(spec.blockSize * spec.blockCount)
    this.shadow = new Uint8Array(this.bytes.length)
  }

  get size(): number {
    return this.bytes.length
  }

  block(no: number): Uint8Array {
    return this.bytes.subarray(no * this.blockSize, (no + 1) * this.blockSize)
  }

  writeBlock(no: number, data: Uint8Array) {
    const dst = this.block(no)
    dst.fill(0)
    dst.set(data.subarray(0, dst.length))
  }

  u8(at: number): number {
    return this.bytes[at]
  }
  setU8(at: number, v: number) {
    this.bytes[at] = v & 0xff
  }
  u16(at: number): number {
    return (this.bytes[at] << 8) | this.bytes[at + 1]
  }
  setU16(at: number, v: number) {
    this.bytes[at] = (v >> 8) & 0xff
    this.bytes[at + 1] = v & 0xff
  }

  /** 整盘换内容：装入一份镜像字节（短的按零补齐，长的截断） */
  load(raw: Uint8Array) {
    this.bytes.fill(0)
    this.bytes.set(raw.subarray(0, this.bytes.length))
  }
}
