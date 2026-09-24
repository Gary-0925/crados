import { Pause, Play, RotateCcw, StepForward, Terminal as TermIcon } from 'lucide-react'
import type { Kernel, Snapshot } from '@/os/kernel'
import { cn } from '@/utils/cn'

const SPEEDS: (number | 'max')[] = [1, 5, 20, 60, 'max']

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="hidden items-baseline gap-1 md:inline-flex">
      <span className="text-[10px] text-[#6e7681]">{label}</span>
      <span className="text-[11px] tabular text-[#c9d1d9]">{value}</span>
    </span>
  )
}

export function Header({ kernel, snap, onReboot }: { kernel: Kernel; snap: Snapshot; onReboot: () => void }) {
  const cur = snap.procs.find((p) => p.pid === snap.currentPid)
  const kernelMode = snap.mode === 'kernel'
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[#30363d] bg-[#010409] px-3">
      <TermIcon size={15} className="text-[#e6edf3]" />
      <span className="text-[13px] font-semibold text-[#e6edf3]">crados</span>
      <span className="hidden text-[10px] text-[#6e7681] sm:inline">0.1 minnow</span>

      <span
        title="CPU 模式位：中断与系统调用期间处于内核态"
        className={cn(
          'ml-1 inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-[10px]',
          kernelMode ? 'border-[#d29922]/40 text-[#d29922]' : 'border-[#3fb950]/40 text-[#3fb950]',
        )}
      >
        <span className={cn('h-1.5 w-1.5 rounded-full', kernelMode ? 'bg-[#d29922]' : 'bg-[#3fb950]')} />
        {kernelMode ? 'kernel' : 'user'}
      </span>

      <Stat label="proc" value={cur ? `${cur.pid}:${cur.name}` : '—'} />
      <Stat label="tick" value={String(snap.ticks)} />
      <Stat label={snap.turbo ? 'tick/s' : 'switches'} value={String(snap.turbo ? snap.tps : snap.switches)} />

      <div className="ml-auto flex items-center gap-1.5">
        <div className="flex overflow-hidden rounded-md border border-[#30363d]">
          {SPEEDS.map((s) => {
            const on = s === 'max' ? snap.turbo : !snap.turbo && snap.hz === s
            return (
              <button
                key={s}
                onClick={() => kernel.setSpeed(s)}
                title={s === 'max' ? '不限速：每帧在时间预算内连续执行' : `时钟中断 ${s} Hz`}
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
          title="单步执行一个时钟中断"
          className="rounded-md border border-[#30363d] p-1.5 text-[#8b949e] hover:border-[#8b949e] hover:text-[#e6edf3]"
        >
          <StepForward size={13} />
        </button>
        <button
          onClick={() => kernel.setPaused(!snap.paused)}
          title={snap.paused ? 'resume' : 'pause'}
          className={cn(
            'rounded-md border p-1.5',
            snap.paused
              ? 'border-[#d29922]/50 text-[#d29922]'
              : 'border-[#30363d] text-[#8b949e] hover:border-[#8b949e] hover:text-[#e6edf3]',
          )}
        >
          {snap.paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
        <button
          onClick={onReboot}
          title="reboot"
          className="rounded-md border border-[#30363d] p-1.5 text-[#8b949e] hover:border-[#8b949e] hover:text-[#e6edf3]"
        >
          <RotateCcw size={13} />
        </button>
      </div>
    </header>
  )
}
