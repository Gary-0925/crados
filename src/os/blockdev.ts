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

export const SPECS: Record<string, DevSpec> = {
  rom: { name: 'rom', model: 'CRADOS-FIRMWARE', blockSize: 1024, blockCount: 256, inodeCount: 64, removable: false },
  // 一个 256 B 的块位图可寻址 2048 个块，因此 512 KiB 是当前 CRFS v1 的自然上限。
  sda: { name: 'sda', model: 'CRADOS-ROOT', blockSize: 256, blockCount: 2048, inodeCount: SDA_INODES, removable: false },
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
const INDEX_KEY = 'crados.disks'

// 记录曾经持久化过哪些可移动设备，重启后据此重新装载
export function listStoredDisks(): string[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

function setStoredDisks(names: string[]) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(names))
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
