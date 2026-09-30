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

export const SDA_INODES = 256

// 盘上格式是 ext2：块大小 1 KiB（s_log_block_size = 0），sda 正好 1 MiB / 1024 块。
// 一张块位图（1 KiB = 8192 位）覆盖整个块组，因此 8192 块是这套实现的自然上限。
export const SPECS: Record<string, DevSpec> = {
  rom: { name: 'rom', model: 'CRADOS-FIRMWARE', blockSize: 1024, blockCount: 256, inodeCount: 64, removable: false },
  sda: { name: 'sda', model: 'CRADOS-ROOT', blockSize: 1024, blockCount: 1024, inodeCount: SDA_INODES, removable: false },
}

// 导入的镜像按 sdb、sdc、sdd… 顺序占位，容量与根盘一致，便于整盘互换
export const diskSpec = (name: string): DevSpec => ({
  name,
  model: 'CRADOS-DISK',
  blockSize: SPECS.sda.blockSize,
  blockCount: SPECS.sda.blockCount,
  inodeCount: SPECS.sda.inodeCount,
  removable: true,
})

// sdb 起按字母递增，跳过已占用的名字
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
  /** 上一次持久化时的内容：回写时只写变化的块，不必每次重写整盘 */
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

  load(raw: Uint8Array) {
    this.bytes.fill(0)
    this.bytes.set(raw.subarray(0, this.bytes.length))
  }
}

// ---------- 持久化：整盘按 16 KiB 分块存进浏览器 ----------
//
// ext2 的 sda 是 1 MiB，整盘 base64 之后约 1.37 MB；每秒重写一遍既浪费又容易顶到配额。
// 因此按块存储 + 只写变化的分块：一次 sync 通常只碰几个分块。

const CHUNK = 16 * 1024
const KEY = (name: string, chunk: number) => `crados.dev.${name}.${chunk}`
const INDEX_KEY = (name: string) => `crados.dev.${name}.chunks`
const DISKS_KEY = 'crados.disks'

// 记录曾经持久化过哪些可移动设备，重启后据此重新装载
export function listStoredDisks(): string[] {
  try {
    const raw = localStorage.getItem(DISKS_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

function setStoredDisks(names: string[]) {
  try {
    localStorage.setItem(DISKS_KEY, JSON.stringify(names))
  } catch {}
}

export function rememberDisk(name: string) {
  const list = listStoredDisks()
  if (!list.includes(name)) setStoredDisks([...list, name])
}

export function forgetDisk(name: string) {
  setStoredDisks(listStoredDisks().filter((n) => n !== name))
}

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

const chunkCount = (dev: BlockDev) => Math.ceil(dev.bytes.length / CHUNK)

export function saveDev(dev: BlockDev): boolean {
  const name = dev.spec.name
  try {
    const total = chunkCount(dev)
    let written = 0
    for (let c = 0; c < total; c++) {
      const from = c * CHUNK
      const to = Math.min(from + CHUNK, dev.bytes.length)
      if (!differs(dev.bytes, dev.shadow, from, to)) continue
      localStorage.setItem(KEY(name, c), toB64(dev.bytes.subarray(from, to)))
      dev.shadow.set(dev.bytes.subarray(from, to), from)
      written++
    }
    if (written) localStorage.setItem(INDEX_KEY(name), String(total))
    if (written || total) rememberDisk(name)
    return true
  } catch {
    return false
  }
}

function differs(a: Uint8Array, b: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (a[i] !== b[i]) return true
  return false
}

export function loadDev(dev: BlockDev): boolean {
  const name = dev.spec.name
  try {
    const total = Number(localStorage.getItem(INDEX_KEY(name)))
    if (!Number.isInteger(total) || total <= 0) return false
    for (let c = 0; c < total; c++) {
      const raw = localStorage.getItem(KEY(name, c))
      if (!raw) return false
      dev.bytes.set(fromB64(raw), c * CHUNK)
    }
    dev.shadow.set(dev.bytes)
    return true
  } catch {
    return false
  }
}

export function dropDev(name: string) {
  try {
    const total = Number(localStorage.getItem(INDEX_KEY(name))) || 0
    for (let c = 0; c < total; c++) localStorage.removeItem(KEY(name, c))
    localStorage.removeItem(INDEX_KEY(name))
  } catch {}
  forgetDisk(name)
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
