// 虚拟硬件：启动介质。
//
// 这台机器只有一个系统盘位。上电时盘上的字节从哪来，是硬件（固件）的事：
// 浏览器持久介质里存过的那份、用户当场插进来的 .img、或者一块空盘。
//
// 三种介质装载完都得到同样的东西——一块装着字节的盘。盘上是不是操作系统、
// 是不是 ext2、是哪个版本，硬件看不懂也不该看：那是操作系统自己对盘上内容的
// 检查（os/ext2.ts 的 superblock 校验）。固件只认介质，不认文件系统。
//
// 上电菜单要的东西同样只是介质信息：这台浏览器存过哪些盘、里面有没有系统盘。

import { listStoredDisks, persistAvailable } from './store'
import type { StoredMedia } from './store'

/** 系统盘位上的字节从哪来 */
export type BootMedium =
  | { kind: 'stored' } // 浏览器持久介质里保存过的系统盘
  | { kind: 'image'; bytes: Uint8Array; filename: string } // 用户插进来的整盘镜像
  | { kind: 'blank' } // 一块空盘（等操作系统自己把出厂系统写进去）

export interface BootProbe {
  /** 这台浏览器能不能落盘（无头环境、隐私模式里不能） */
  storageOk: boolean
  /** 存过的所有盘，按名字排序 */
  media: StoredMedia[]
  /** 其中的系统盘 sda */
  system: StoredMedia | null
  /** 除系统盘外、会被一并装回的移动盘 */
  removable: StoredMedia[]
}

/** 只问介质：持久介质能不能用、存过哪些盘。盘上是什么内容不归固件管。 */
export async function probeBootMedia(): Promise<BootProbe> {
  const storageOk = persistAvailable()
  const media = storageOk ? await listStoredDisks() : []
  return {
    storageOk,
    media,
    system: media.find((m) => m.name === 'sda') ?? null,
    removable: media.filter((m) => m.name !== 'sda'),
  }
}
