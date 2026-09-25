import { OctagonX, RotateCcw } from 'lucide-react'

// 直接读内核的日志缓冲，不依赖 /cp
export function PanicOverlay({
  panic,
  log,
  onReboot,
}: {
  panic: string
  log: string[]
  onReboot: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#010409]/96 px-6">
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-2.5">
          <OctagonX size={22} className="shrink-0 text-[#f85149]" />
          <span className="text-[15px] font-semibold text-[#f85149]">Kernel panic</span>
        </div>
        <div className="mt-3 rounded-md border border-[#f85149]/40 bg-[#f85149]/10 px-3 py-2 text-[12px] text-[#ff7b72]">
          {panic}
        </div>
        <div className="mt-3 max-h-100 overflow-hidden rounded-md border border-[#30363d] bg-[#0d1117] p-2 text-[10.5px] leading-relaxed text-[#8b949e]">
          {log.slice(-12).map((l, i) => (
            <div key={i}>{l}</div>
          ))}
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
