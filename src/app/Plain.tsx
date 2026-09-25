// 纯净版：只有 /os 与 /ui。整个 /cp 目录不参与打包。
//
// 重绘直接挂在内核的 observer 上：内核只发一个“状态已变”的信号，不构造任何
// 观测数据结构。

import { useEffect, useReducer, useState } from 'react'
import { Kernel } from '@/os/kernel'
import { Header } from '@/ui/Header'
import { PanicOverlay } from '@/ui/PanicOverlay'
import { Terminal } from '@/ui/Terminal'

export default function Plain() {
  const [kernel, setKernel] = useState(() => new Kernel())
  const [, redraw] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
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
      kernel.destroy()
    }
  }, [kernel])

  const reboot = () => {
    kernel.destroy()
    setKernel(new Kernel())
  }

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
