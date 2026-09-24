// 块设备：一块真实的字节数组，所有读写都以块为单位
// 设备上的内容就是文件系统的全部真相，没有任何 JS 对象在旁边"影子存储"

export interface DevSpec {
  name: string
  model: string
  blockSize: number
  blockCount: number
  inodeCount: number
  removable: boolean
}

export const SPECS: Record<string, DevSpec> = {
  rom: { name: 'rom', model: 'CRADOS-FIRMWARE', blockSize: 1024, blockCount: 256, inodeCount: 64, removable: false },
  sda: { name: 'sda', model: 'CRADOS-ROOT', blockSize: 256, blockCount: 192, inodeCount: 64, removable: false },
  sdb: { name: 'sdb', model: 'CRADOS-USB', blockSize: 256, blockCount: 64, inodeCount: 32, removable: true },
}

export class BlockDev {
  readonly bytes: Uint8Array
  readonly blockSize: number
  readonly blockCount: number

  constructor(readonly spec: DevSpec) {
    this.blockSize = spec.blockSize
    this.blockCount = spec.blockCount
    this.bytes = new Uint8Array(spec.blockSize * spec.blockCount)
  }

  get size(): number {
    return this.bytes.length
  }

  block(no: number): Uint8Array {
    return this.bytes.subarray(no * this.blockSize, (no + 1) * this.blockSize)
  }

  readBlock(no: number, out: Uint8Array, at: number): number {
    const src = this.block(no)
    const n = Math.min(src.length, out.length - at)
    out.set(src.subarray(0, n), at)
    return n
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

  load(raw: Uint8Array) {
    this.bytes.fill(0)
    this.bytes.set(raw.subarray(0, this.bytes.length))
  }
}

// ---------- 持久化：整盘字节以 base64 存入浏览器 ----------

const KEY = (name: string) => `crados.dev.${name}`

const toB64 = (b: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

const fromB64 = (s: string): Uint8Array => {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function saveDev(dev: BlockDev): boolean {
  try {
    localStorage.setItem(KEY(dev.spec.name), toB64(dev.bytes))
    return true
  } catch {
    return false
  }
}

export function loadDev(dev: BlockDev): boolean {
  try {
    const raw = localStorage.getItem(KEY(dev.spec.name))
    if (!raw) return false
    dev.load(fromB64(raw))
    return true
  } catch {
    return false
  }
}

export function dropDev(name: string) {
  try {
    localStorage.removeItem(KEY(name))
  } catch {
    /* ignore */
  }
}

export function downloadDev(dev: BlockDev, filename: string) {
  const blob = new Blob([dev.bytes.slice() as unknown as BlobPart], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
