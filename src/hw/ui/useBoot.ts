// 固件：上电、选启动介质、把操作系统装载到机器上。
//
// 磁盘可能在浏览器的持久介质里，也可能是用户选的 .img，所以启动是异步的；
// 操作系统就绪之前，启动菜单（固件界面）接管整个屏幕。纯净版与透明版共用。

import { useCallback, useEffect, useRef, useState } from 'react'
import { Kernel } from '@/os/kernel'
import type { BootSource } from '@/os/kernel'

export interface Boot {
  /** 启动完成后才有；为 null 时应当渲染启动菜单 */
  kernel: Kernel | null
  /** 启动失败的原因（例如镜像不是合法的 ext2 盘） */
  error: string | null
  busy: boolean
  /**
   * 按指定来源开机。onReady 在机器就绪、界面切换之前同步调用，
   * 让调用方有机会把只属于这一机的附属状态（如控制面板）一次备好。
   */
  boot: (source: BootSource, onReady?: (kernel: Kernel) => void) => void
  /** 回到启动菜单：当前机器停机并落盘 */
  reboot: () => void
}

export function useBoot(): Boot {
  const [kernel, setKernel] = useState<Kernel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const live = useRef<Kernel | null>(null)
  // 连点两次只会起一台机器：第二台会带着自己的硬件时钟一起泄漏
  const starting = useRef(false)

  const boot = useCallback((source: BootSource, onReady?: (kernel: Kernel) => void) => {
    if (starting.current) return
    starting.current = true
    setBusy(true)
    setError(null)
    void (async () => {
      const machine = new Kernel()
      try {
        const failure = await machine.boot(source)
        if (failure) {
          setError(failure)
          void machine.destroy()
          return
        }
        onReady?.(machine)
        live.current = machine
        setKernel(machine)
      } catch (e) {
        setError(`boot failed: ${(e as Error).message}`)
        void machine.destroy()
      } finally {
        starting.current = false
        setBusy(false)
      }
    })()
  }, [])

  const reboot = useCallback(() => {
    const machine = live.current
    live.current = null
    setKernel(null)
    setError(null)
    if (machine) void machine.destroy()
  }, [])

  // 卸载页面：停机并把脏数据写进 IndexedDB
  useEffect(() => () => void live.current?.destroy(), [])

  return { kernel, error, busy, boot, reboot }
}
