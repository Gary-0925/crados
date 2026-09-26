import { Pause, Play, RotateCcw, StepForward } from 'lucide-react'
import type { Kernel } from '@/os/kernel'
import { cn } from '@/utils/cn'

const SPEEDS: (number | 'max')[] = [1, 5, 20, 60, 'max']

// 机器控制条：只用内核公开的控制与只读接口，不依赖 /cp
export function Header({ kernel, ips, onReboot }: { kernel: Kernel; ips?: number; onReboot: () => void }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[#30363d] bg-[#010409] px-3">
      <a
        href="https://github.com/Gary-0925/crados/blob/main/README.md"
        target="_blank"
        rel="noreferrer"
        aria-label="view README"
        className="inline-flex items-center gap-1.5 rounded-full border border-[#30363d] bg-[#0d1117] px-2.5 py-1 text-[10px] font-medium text-[#c9d1d9] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition-colors hover:border-[#8b949e] hover:text-[#f0f6fc]"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-current">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
        <span>view README</span>
      </a>
      <span className="text-[13px] font-semibold text-[#e6edf3]">crados</span>

      <div className="ml-auto flex items-center gap-1.5">
        <div className="flex overflow-hidden rounded-md border border-[#30363d]">
          {SPEEDS.map((s) => {
            const on = s === 'max' ? kernel.turbo : !kernel.turbo && kernel.hz === s
            return (
              <button
                key={s}
                onClick={() => kernel.setSpeed(s)}
                className={cn(
                  'px-2 py-1 text-[10px] tabular',
                  on
                    ? s === 'max'
                      ? 'bg-[#f78166] text-[#010409]'
                      : 'bg-[#21262d] text-[#e6edf3]'
                    : 'text-[#6e7681] hover:text-[#c9d1d9]',
                )}
              >
                {s === 'max' ? 'MAX' : `${s}Hz`}
              </button>
            )
          })}
        </div>
        <button
          onClick={() => kernel.step()}
          className="rounded-md border border-[#30363d] p-1.5 text-[#8b949e] hover:border-[#8b949e] hover:text-[#e6edf3]"
        >
          <StepForward size={13} />
        </button>
        <button
          onClick={() => kernel.setPaused(!kernel.paused)}
          className={cn(
            'rounded-md border p-1.5',
            kernel.paused
              ? 'border-[#d29922]/50 text-[#d29922]'
              : 'border-[#30363d] text-[#8b949e] hover:border-[#8b949e] hover:text-[#e6edf3]',
          )}
        >
          {kernel.paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
        <button
          onClick={onReboot}
          className="rounded-md border border-[#30363d] p-1.5 text-[#8b949e] hover:border-[#8b949e] hover:text-[#e6edf3]"
        >
          <RotateCcw size={13} />
        </button>
      </div>
    </header>
  )
}
