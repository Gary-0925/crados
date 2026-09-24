import { useEffect, useState, useSyncExternalStore } from 'react'
import { OctagonX, RotateCcw } from 'lucide-react'
import { Kernel } from '@/os/kernel'
import type { Snapshot } from '@/os/kernel'
import { Header } from '@/ui/Header'
import { Terminal } from '@/ui/Terminal'
import { ProcessesPanel } from '@/ui/ProcessesPanel'
import { MemoryPanel } from '@/ui/MemoryPanel'
import { StoragePanel } from '@/ui/StoragePanel'
import { KmsgPanel, TracePanel } from '@/ui/StreamsPanel'
import { cn } from '@/utils/cn'

type Tab = 'proc' | 'mem' | 'disk' | 'trace' | 'kmsg'

const TABS: { id: Tab; label: string }[] = [
  { id: 'proc', label: '进程' },
  { id: 'mem', label: '内存' },
  { id: 'disk', label: '存储' },
  { id: 'trace', label: '调用' },
  { id: 'kmsg', label: '日志' },
]

function PanicOverlay({ panic, snap, onReboot }: { panic: string; snap: Snapshot; onReboot: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#010409]/96 px-6">
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-2.5">
          <OctagonX size={22} className="shrink-0 text-[#f85149]" />
          <span className="text-[15px] font-semibold text-[#f85149]">Kernel panic — not syncing</span>
        </div>
        <div className="mt-3 rounded-md border border-[#f85149]/40 bg-[#f85149]/10 px-3 py-2 text-[12px] text-[#ff7b72]">
          {panic}
        </div>
        <div className="mt-3 max-h-52 overflow-hidden rounded-md border border-[#30363d] bg-[#0d1117] p-2 text-[10.5px] leading-relaxed text-[#8b949e]">
          {snap.kmsgText.slice(-12).map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
        <div className="mt-2 text-[10.5px] text-[#6e7681]">
          CPU halted at tick {snap.ticks} after {snap.switches} context switches. Disks were flushed before the halt.
        </div>
        <button
          onClick={onReboot}
          className="mt-4 flex items-center gap-2 rounded-md border border-[#f85149]/50 px-3 py-1.5 text-[12px] text-[#ff7b72] hover:bg-[#f85149]/10"
        >
          <RotateCcw size={13} /> reboot
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const [kernel, setKernel] = useState(() => new Kernel())
  const [tab, setTab] = useState<Tab>('proc')
  const [selPid, setSelPid] = useState(2)

  useEffect(() => () => kernel.destroy(), [kernel])
  const snap = useSyncExternalStore(kernel.subscribe, kernel.getSnapshot)

  const reboot = () => {
    kernel.destroy()
    setSelPid(2)
    setKernel(new Kernel())
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0d1117] font-mono text-[#c9d1d9]">
      <Header kernel={kernel} snap={snap} onReboot={reboot} />

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="min-h-[40vh] flex-1 lg:min-h-0">
          <Terminal kernel={kernel} snap={snap} />
        </section>

        <section className="flex min-h-[44vh] flex-col border-t border-[#30363d] bg-[#010409] lg:min-h-0 lg:w-[452px] lg:border-l lg:border-t-0 xl:w-[520px]">
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
            {tab === 'mem' && <MemoryPanel kernel={kernel} snap={snap} sel={selPid} />}
            {tab === 'disk' && <StoragePanel kernel={kernel} snap={snap} />}
            {tab === 'trace' && <TracePanel snap={snap} />}
            {tab === 'kmsg' && <KmsgPanel snap={snap} />}
          </div>
        </section>
      </main>

      {snap.panic && <PanicOverlay panic={snap.panic} snap={snap} onReboot={reboot} />}
    </div>
  )
}
