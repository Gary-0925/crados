// 透明版：在纯净系统之上挂载 /cp 观测层。
//
// ControlPanel 是唯一接触内核 observer 的对象；它把内核的只读接口聚合成
// Snapshot 供面板渲染。

import { useEffect, useState, useSyncExternalStore } from 'react'
import { Kernel } from '@/os/kernel'
import { Header } from '@/ui/Header'
import { PanicOverlay } from '@/ui/PanicOverlay'
import { Terminal } from '@/ui/Terminal'
import { ControlPanel } from '@/cp/snapshot'
import { ProcessesPanel } from '@/cp/ProcessesPanel'
import { MemoryPanel } from '@/cp/MemoryPanel'
import { StoragePanel } from '@/cp/StoragePanel'
import { KmsgPanel, TracePanel } from '@/cp/StreamsPanel'
import { cn } from '@/utils/cn'

type Tab = 'proc' | 'mem' | 'disk' | 'trace' | 'kmsg'

const TABS: { id: Tab; label: string }[] = [
  { id: 'proc', label: '进程' },
  { id: 'mem', label: '内存' },
  { id: 'disk', label: '存储' },
  { id: 'trace', label: '调用' },
  { id: 'kmsg', label: '日志' },
]

export default function Transparent() {
  const [kernel, setKernel] = useState(() => new Kernel())
  const [cp, setCp] = useState(() => new ControlPanel(kernel))
  const [tab, setTab] = useState<Tab>('proc')
  const [selPid, setSelPid] = useState(2)

  useEffect(() => {
    return () => {
      cp.detach()
      kernel.destroy()
    }
  }, [kernel, cp])
  const snap = useSyncExternalStore(cp.subscribe, cp.getSnapshot)

  const reboot = () => {
    kernel.destroy()
    const next = new Kernel()
    setSelPid(2)
    setKernel(next)
    setCp(new ControlPanel(next))
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0d1117] font-mono text-[#c9d1d9]">
      <Header kernel={kernel} onReboot={reboot} />

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="min-h-[40vh] flex-1 lg:min-h-0">
          <Terminal kernel={kernel} />
        </section>

        <aside className="flex min-h-[44vh] flex-col border-t border-[#30363d] bg-[#010409] lg:min-h-0 lg:w-[452px] lg:border-l lg:border-t-0 xl:w-[520px]">
          <div className="flex h-9 shrink-0 items-stretch gap-1 border-b border-[#30363d] px-1.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'relative px-2.5 text-[11.5px]',
                  tab === t.id ? 'text-[#e6edf3]' : 'text-[#8b949e] hover:text-[#c9d1d9]',
                )}
              >
                {t.label}
                {tab === t.id && <span className="absolute inset-x-1.5 -bottom-px h-0.5 rounded-full bg-[#f78166]" />}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'proc' && <ProcessesPanel snap={snap} sel={selPid} onSelect={setSelPid} />}
            {tab === 'mem' && <MemoryPanel kernel={kernel} snap={snap} sel={selPid} onMutate={() => cp.invalidate()} />}
            {tab === 'disk' && <StoragePanel kernel={kernel} snap={snap} onMutate={() => cp.invalidate()} />}
            {tab === 'trace' && <TracePanel snap={snap} />}
            {tab === 'kmsg' && <KmsgPanel snap={snap} />}
          </div>
        </aside>
      </main>

      {snap.panic && <PanicOverlay panic={snap.panic} log={snap.kmsgText} onReboot={reboot} />}
    </div>
  )
}
