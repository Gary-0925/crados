// 虚拟硬件：把磁盘字节存进这台浏览器的持久介质（IndexedDB）。
//
// 磁盘在真实机器上是掉电不丢的介质；在浏览器里，扮演这个角色的就是 IndexedDB。
// 这里只认"设备"和"字节"，不认任何盘上格式——文件系统怎么解释这些字节与硬件无关。
//
// 整盘按 16 KiB 分块存放，且只写变化的分块：
//
//   chunks  key = "<设备名>/<分块号>" → Uint8Array(16 KiB)
//   media   key = "<设备名>"          → StoredMedia，登记这台浏览器存过哪些盘
//
// 全零分块不落盘（加载时缺的分块一律按零读，那就是一块新盘），落盘时记下哪些
// 分块真的有内容，其余的按零读——这正是旧版 localStorage 时代「存得下、读不回」
// 的病根所在。

import type { BlockDev } from './disk'

const DB_NAME = 'crados-disks'
const DB_VERSION = 1
const CHUNK_STORE = 'chunks'
const MEDIA_STORE = 'media'
const CHUNK = 16 * 1024

export interface StoredMedia {
  name: string
  /** 整盘的分块总数：容量 / 16 KiB */
  chunks: number
  /** 真的落了盘的分块号。全零分块与一块新盘一致，不必存，加载时按零读。 */
  stored: number[]
  bytes: number
  savedAt: number
}

const chunkKey = (name: string, index: number) => `${name}/${index}`

let dbPromise: Promise<IDBDatabase | null> | null = null
let dbDead = false

/** 这台浏览器能不能落盘。无头环境（Node 验收脚本）没有 IndexedDB，持久化整体停用。 */
export const persistAvailable = (): boolean => typeof indexedDB !== 'undefined' && !dbDead

function openStore(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === 'undefined') {
    dbDead = true
    return Promise.resolve(null)
  }
  dbPromise = new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      dbDead = true // 隐私模式之类的环境会 synchronously 拒绝
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(CHUNK_STORE)) db.createObjectStore(CHUNK_STORE)
      if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE)
      purgeLegacyLocalStorage()
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      dbDead = true
      resolve(null)
    }
    // 另一个标签页卡着旧版本：本次会话当作没有持久化，机器照常跑
    request.onblocked = () => {
      dbDead = true
      resolve(null)
    }
  })
  return dbPromise
}

/** 历史遗留：localStorage 时代的整盘 base64。IndexedDB 接管之后这些键没有用处。 */
function purgeLegacyLocalStorage() {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && (key === 'crados.disks' || key.startsWith('crados.dev.'))) doomed.push(key)
    }
    for (const key of doomed) localStorage.removeItem(key)
  } catch {}
}

// 同一块盘的写操作排队：分块 diff 与 shadow 对齐必须串行，否则并发写会丢数据
const queues = new Map<string, Promise<unknown>>()
function serialize<T>(name: string, job: () => Promise<T>): Promise<T> {
  const previous = queues.get(name) ?? Promise.resolve()
  const next = previous.then(job, job) // 上一次失败也要继续跑这一次
  queues.set(name, next.catch(() => {}))
  return next
}

const chunkCount = (dev: BlockDev) => Math.ceil(dev.bytes.length / CHUNK)

function differs(a: Uint8Array, b: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (a[i] !== b[i]) return true
  return false
}

function nonZero(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return true
  return false
}

function readMedia(db: IDBDatabase, name: string): Promise<StoredMedia | null> {
  return new Promise((resolve) => {
    const tx = db.transaction(MEDIA_STORE, 'readonly')
    const request = tx.objectStore(MEDIA_STORE).get(name)
    request.onsuccess = () => {
      const value = request.result
      resolve(value && typeof value === 'object' ? (value as StoredMedia) : null)
    }
    request.onerror = () => resolve(null)
    tx.onabort = () => resolve(null)
  })
}

/** 这台浏览器存过哪些盘。开机菜单靠它列出"从上次的盘启动"。 */
export async function listStoredDisks(): Promise<StoredMedia[]> {
  const db = await openStore()
  if (!db) return []
  return new Promise((resolve) => {
    const tx = db.transaction(MEDIA_STORE, 'readonly')
    const request = tx.objectStore(MEDIA_STORE).getAll()
    request.onsuccess = () => resolve(Array.isArray(request.result) ? (request.result as StoredMedia[]) : [])
    request.onerror = () => resolve([])
    tx.onabort = () => resolve([])
  })
}

/**
 * 把一块盘写进 IndexedDB，回到"是否写成"。
 *
 * 全零分块根本不落盘；剩下的分块里，只有内容真改过（与 shadow 不同）的才写。
 * shadow 在落盘成功之后才对齐，失败的话下次同步会重写同样的分块。
 */
export async function saveDev(dev: BlockDev): Promise<boolean> {
  const db = await openStore()
  if (!db) return false
  return serialize(dev.spec.name, async () => {
    const name = dev.spec.name
    const total = chunkCount(dev)
    const changed: [string, Uint8Array][] = []
    const stored: number[] = []
    for (let c = 0; c < total; c++) {
      const from = c * CHUNK
      const to = Math.min(from + CHUNK, dev.bytes.length)
      if (!nonZero(dev.bytes, from, to)) continue
      stored.push(c)
      if (!differs(dev.bytes, dev.shadow, from, to)) continue
      changed.push([chunkKey(name, c), dev.bytes.slice(from, to)])
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([CHUNK_STORE, MEDIA_STORE], 'readwrite')
      const chunks = tx.objectStore(CHUNK_STORE)
      for (const [key, bytes] of changed) chunks.put(bytes, key)
      const media: StoredMedia = { name, chunks: total, stored, bytes: dev.bytes.length, savedAt: Date.now() }
      tx.objectStore(MEDIA_STORE).put(media, name)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
    })
    dev.shadow.set(dev.bytes)
    return true
  }).catch(() => false)
}

/** 从 IndexedDB 恢复整盘字节。没有记录、缺分块或尺寸不符都算失败。 */
export async function loadDev(dev: BlockDev): Promise<boolean> {
  const db = await openStore()
  if (!db) return false
  const media = await readMedia(db, dev.spec.name)
  if (!media || !Number.isInteger(media.chunks) || media.chunks <= 0) return false
  // 清单里没有的分块是零：新盘如此，被抹掉的盘也是如此
  const wanted = Array.isArray(media.stored)
    ? media.stored.filter((c) => Number.isInteger(c) && c >= 0 && c < media.chunks)
    : Array.from({ length: media.chunks }, (_, c) => c)
  const parts = await new Promise<(Uint8Array | null)[]>((resolve) => {
    const tx = db.transaction(CHUNK_STORE, 'readonly')
    const store = tx.objectStore(CHUNK_STORE)
    const out: (Uint8Array | null)[] = new Array(media.chunks).fill(null)
    let pending = wanted.length
    if (pending === 0) {
      resolve(out)
      return
    }
    for (const c of wanted) {
      const request = store.get(chunkKey(dev.spec.name, c))
      request.onsuccess = () => {
        out[c] = request.result instanceof Uint8Array ? request.result : null
        if (--pending === 0) resolve(out)
      }
      request.onerror = () => {
        if (--pending === 0) resolve(out)
      }
    }
    tx.onabort = () => resolve(out.map(() => null))
  })
  try {
    dev.bytes.fill(0)
    for (const c of wanted) {
      const part = parts[c]
      if (!part) return false
      dev.bytes.set(part, c * CHUNK)
    }
  } catch {
    return false // 存着的盘比现在的设备大：几何变过，当没有
  }
  dev.shadow.set(dev.bytes)
  return true
}

/** 撤掉一台设备在浏览器里的存档（拔盘时用）。 */
export async function dropDev(name: string): Promise<void> {
  const db = await openStore()
  if (!db) return
  await serialize(name, async () => {
    await new Promise<void>((resolve) => {
      const tx = db.transaction([CHUNK_STORE, MEDIA_STORE], 'readwrite')
      const chunks = tx.objectStore(CHUNK_STORE)
      const mediaRequest = tx.objectStore(MEDIA_STORE).get(name)
      mediaRequest.onsuccess = () => {
        const media = mediaRequest.result as StoredMedia | undefined
        if (media && Number.isInteger(media.chunks)) {
          for (let c = 0; c < media.chunks; c++) chunks.delete(chunkKey(name, c))
        }
        tx.objectStore(MEDIA_STORE).delete(name)
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  }).catch(() => {})
}

/** 导出整盘字节：交给宿主的下载通道写成 .img 文件。 */
export function downloadDev(dev: BlockDev, filename: string) {
  const blob = new Blob([dev.bytes.slice() as unknown as BlobPart], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
