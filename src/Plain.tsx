// 纯净版：机器（/hw）+ 操作系统（/os）。整个 /cp 目录不参与打包。
//
// 重绘直接挂在内核的 observer 上：内核只发一个“状态已变”的信号，不构造任何
// 观测数据结构。开机之前渲染启动菜单，机器就绪后才挂 observer。

import { useEffect, useReducer } from 'react'
import { Header } from '@/hw/ui/Header'
import { PanicOverlay } from '@/hw/ui/PanicOverlay'
import { Terminal } from '@/hw/ui/Terminal'
import { BootMenu } from '@/hw/ui/BootMenu'
import { useBoot } from '@/hw/ui/useBoot'

export default function Plain() {
  const { kernel, error, busy, boot, reboot } = useBoot()
  const [, redraw] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (!kernel) return
    let frame = 0
    kernel.observer = {
      changed: () => {
        if (frame) return
        frame = requestAnimationFrame(() => {
          frame = 0
          redraw()
        })
      },
    }
    return () => {
      if (frame) cancelAnimationFrame(frame)
      kernel.observer = null
    }
  }, [kernel])

  if (!kernel) return <BootMenu busy={busy} error={error} onBoot={boot} />

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0d1117] font-mono text-[#c9d1d9]">
      <Header kernel={kernel} onReboot={reboot} />
      <main className="min-h-0 flex-1">
        <Terminal kernel={kernel} />
      </main>
      {kernel.panic && <PanicOverlay panic={kernel.panic} log={kernel.kmsg()} onReboot={reboot} />}
    </div>
  )
}
