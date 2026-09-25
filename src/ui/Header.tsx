import { Github, Pause, Play, RotateCcw, StepForward } from 'lucide-react'
import type { Kernel } from '@/os/kernel'
import { cn } from '@/utils/cn'

const SPEEDS: (number | 'max')[] = [1, 5, 20, 60, 'max']

// 机器控制条：只用内核公开的控制与只读接口，不依赖 /cp
export function Header({ kernel, ips, onReboot }: { kernel: Kernel; ips?: number; onReboot: () => void }) {
  const cur = kernel.processes().find((p) => p.pid === kernel.runningPid)
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[#30363d] bg-[#010409] px-3">
      <span className="text-[13px] font-semibold text-[#e6edf3]">crados</span>
      <a
        href="https://github.com/Gary-0925/crados/blob/main/README.md"
        target="_blank"
        rel="noreferrer"
        aria-label="View Gary-0925/crados on GitHub"
        className="inline-flex items-center gap-1.5 rounded-md border border-[#30363d] bg-[#0d1117] px-2 py-1 text-[10px] font-medium text-[#c9d1d9] transition-colors hover:border-[#8b949e] hover:text-[#f0f6fc]"
      >
        <Github size={11} />
        <span>Github</span>
      </a>

      <span className="hidden items-baseline gap-1 md:inline-flex">
        <span className="text-[10px] text-[#6e7681]">proc</span>
        <span className="text-[11px] tabular text-[#c9d1d9]">{cur ? `${cur.pid}:${cur.name}` : '—'}</span>
      </span>
      <span className="hidden items-baseline gap-1 md:inline-flex">
        <span className="text-[10px] text-[#6e7681]">tick</span>
        <span className="text-[11px] tabular text-[#c9d1d9]">{kernel.ticks}</span>
      </span>
      {kernel.turbo && ips !== undefined && (
        <span className="hidden items-baseline gap-1 md:inline-flex">
          <span className="text-[10px] text-[#6e7681]">instr/s</span>
          <span className="text-[11px] tabular text-[#c9d1d9]">{ips}</span>
        </span>
      )}

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
