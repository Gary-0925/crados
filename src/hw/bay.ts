// 虚拟硬件：盘位（热插拔的磁盘控制器）。
//
// 这台机器上插着哪些盘、每块盘是空盘还是镜像、内容什么时候写回浏览器的持久介质，
// 全部由盘位负责。它不认识盘上的文件系统，也不知道哪块盘是系统盘、哪块被挂载——
// 那是操作系统（os/kernel.ts）的挂载表说了算。
//
// 落盘策略：块写入只置脏标记，真正的写回发生在
//   - 操作系统发 sync 块命令（块控制器命令 3）
//   - 宿主每秒一次的自动回写
//   - 停机（destroy）与 panic
// 每次只写变化过的 16 KiB 分块（见 store.ts）。

import type { BootMedium } from './boot'
import { BlockDev, diskSpec, nextDiskName, SPECS } from './disk'
import type { DevSpec } from './disk'
import { dropDev, downloadDev, listStoredDisks, loadDev, persistAvailable, saveDev } from './store'
import type { StoredMedia } from './store'

/** 脏数据自动回写间隔，按真实时间计 */
const AUTOSYNC_MS = 1000

export class DiskBay {
  private readonly devs = new Map<string, BlockDev>()
  /** 这台机器是从哪种介质上电的（固件在启动菜单里问出来的那个选择） */
  private booted: BootMedium | null = null
  private storageOk = persistAvailable()
  private dirty = false
  private lastSyncMs = 0
  /** 在飞的落盘事务：停机时要等它们写完 */
  private readonly writes = new Set<Promise<boolean>>()

  names(): string[] {
    return [...this.devs.keys()]
  }

  get(name: string): BlockDev | undefined {
    return this.devs.get(name)
  }

  has(name: string): boolean {
    return this.devs.has(name)
  }

  /** 这块浏览器的持久介质能不能用（无头环境没有 IndexedDB） */
  get storageReady(): boolean {
    return this.storageOk
  }

  /** 有没有还没写回持久介质的字节 */
  get pendingWriteback(): boolean {
    return this.dirty
  }

  markDirty() {
    this.dirty = true
  }

  autosyncDue(): boolean {
    return this.dirty && Date.now() - this.lastSyncMs >= AUTOSYNC_MS
  }

  /** 这台浏览器存过哪些盘：开机菜单据此列出"上次的盘" */
  storedMedia(): Promise<StoredMedia[]> {
    return listStoredDisks()
  }

  /** 这台机器是从哪种介质上电的；还没上电就是 null */
  get bootMedium(): BootMedium | null {
    return this.booted
  }

  /** 系统盘位（sda）上的那块盘；空着的盘位是 null，操作系统自己判断盘上的内容 */
  get system(): BlockDev | null {
    return this.devs.get(SPECS.sda.name) ?? null
  }

  /**
   * 按选定的启动介质把盘装上系统盘位（上电第一步，只有 sda 能当系统盘）。
   * 介质层面的问题在这里就说清楚：存档里没有盘中、镜像比盘还长。
   * 短镜像按零补齐（与真机一样），盘上的字节合不合法由操作系统自己检查。
   */
  async insertBootMedium(medium: BootMedium): Promise<BlockDev | string> {
    this.devs.delete(SPECS.sda.name)
    const dev = this.insert(SPECS.sda)
    if (medium.kind === 'stored') {
      if (!(await this.restore(dev))) {
        this.devs.delete(dev.spec.name)
        return '浏览器里没有保存过系统盘：请改用 .img 文件，或新建空盘'
      }
    } else if (medium.kind === 'image') {
      if (medium.bytes.length > dev.size) {
        this.devs.delete(dev.spec.name)
        return `${medium.filename}: 整盘镜像 ${medium.bytes.length} 字节，超过系统盘容量 ${dev.size} 字节`
      }
      dev.load(medium.bytes)
    }
    this.booted = medium
    return dev
  }

  /** 再插一块空的移动盘，名字按 sdb、sdc… 递增；盘位用满返回 null */
  insertBlank(): BlockDev | null {
    const name = nextDiskName(this.devs.keys())
    return name ? this.insert(diskSpec(name)) : null
  }

  /** 装一份整盘镜像：容量超了返回 null（短了按零补齐，与真机一样） */
  insertImage(raw: Uint8Array): BlockDev | null {
    const dev = this.insertBlank()
    if (!dev) return null
    if (raw.length > dev.size) {
      this.devs.delete(dev.spec.name)
      return null
    }
    dev.load(raw)
    return dev
  }

  /** 按存档里的名字插回一块移动盘（开机时把浏览器里存过的盘装回来） */
  insertStored(name: string): BlockDev {
    return this.insert(diskSpec(name))
  }

  private insert(spec: DevSpec): BlockDev {
    const dev = new BlockDev(spec)
    this.devs.set(spec.name, dev)
    return dev
  }

  /** 拔盘：设备表与浏览器存档一起撤。挂载检查是操作系统的事。 */
  remove(name: string): void {
    if (!this.devs.delete(name)) return
    void dropDev(name)
  }

  /** 从 IndexedDB 恢复一块盘的字节 */
  restore(dev: BlockDev): Promise<boolean> {
    return loadDev(dev)
  }

  /** 整盘字节的副本：导出镜像、交给宿主文件 */
  image(name: string): Uint8Array | null {
    const dev = this.devs.get(name)
    return dev ? dev.bytes.slice() : null
  }

  /** 导出整盘字节，交给宿主的下载通道 */
  exportImage(name: string): boolean {
    const dev = this.devs.get(name)
    if (!dev) return false
    downloadDev(dev, `${name}.img`)
    return true
  }

  /** 把一台设备排进落盘队列。返回的 promise 在写成功后兑现 true。 */
  save(name: string): Promise<boolean> {
    const dev = this.devs.get(name)
    if (!dev) return Promise.resolve(false)
    const pending = saveDev(dev)
    this.writes.add(pending)
    void pending.then(
      (ok) => {
        this.writes.delete(pending)
        if (this.devs.has(name)) this.storageOk = ok
      },
      () => {
        this.writes.delete(pending)
        this.storageOk = false
      },
    )
    return pending
  }

  /** 把每台盘都排进落盘队列（不等待写完）。返回持久介质是否可用。 */
  flush(): boolean {
    const ok = persistAvailable()
    if (ok) for (const name of this.devs.keys()) void this.save(name)
    this.storageOk = ok
    this.dirty = false
    this.lastSyncMs = Date.now()
    return ok
  }

  /** 停机：等在飞的写事务全部落地 */
  drain(): Promise<void> {
    return Promise.all([...this.writes]).then(() => {})
  }
}
