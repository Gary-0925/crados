import type { ProcRow, Snapshot } from '@/cp/snapshot'
import { hex } from '@/cp/theme'
import { cn } from '@/utils/cn'

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-[#21262d] py-1">
      <div className="text-[9px] uppercase tracking-wide text-[#6e7681]">{label}</div>
      <div className="mt-0.5 truncate text-[11px] tabular text-[#c9d1d9]">{value}</div>
    </div>
  )
}

function Detail({ p }: { p: ProcRow }) {
  return (
    <div className="mt-2 space-y-2 border-t border-[#30363d] pt-2.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-[#c9d1d9]">
          pid {p.pid} · uid {p.euid === p.uid ? p.uid : `${p.euid}/${p.uid}`} · {p.cmd}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        <Cell label="pc" value={hex(p.pc)} />
        <Cell label="sp" value={hex(p.sp)} />
        <Cell label="ax" value={hex(p.ax)} />
        <Cell label="cpu ticks" value={String(p.ticksUsed)} />
      </div>
      {p.cpuMode && (
        <div className="grid grid-cols-4 gap-1.5">
          <Cell label="mode" value={p.cpuMode} />
          <Cell label="cause" value={String(p.cause ?? 0)} />
          <Cell label="ivt" value={hex(p.ivtBase ?? 0)} />
          <Cell label="ksp" value={hex(p.ksp ?? 0)} />
        </div>
      )}
      {p.gprs.length > 0 && (
        <div>
          <div className="mb-1 text-[9px] uppercase tracking-wide text-[#6e7681]">
            registers · flags {p.flags} {p.halted ? '· halted' : ''}
          </div>
          <div className="grid grid-cols-8 gap-1">
            {p.gprs.map((v, i) => (
              <div key={i} className="border-b border-[#21262d] py-1 text-center">
                <div className="text-[8px] text-[#6e7681]">r{i}</div>
                <div className="text-[9px] tabular text-[#c9d1d9]">{hex(v, 2)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <Cell label="cwd" value={p.cwd} />
        <Cell
          label={p.state === 'zombie' ? 'exit status' : 'wait channel'}
          value={p.state === 'zombie' ? String(p.exitCode ?? 0) : (p.waitDesc ?? '—')}
        />
      </div>
      {p.children.length > 0 && (
        <div className="text-[10px] text-[#6e7681]">children: {p.children.join(', ')}</div>
      )}
      {p.fds.length > 0 && (
        <div>
          <div className="mb-1 text-[9px] uppercase tracking-wide text-[#6e7681]">open file table</div>
          <div className="space-y-0.5 text-[10.5px] tabular text-[#8b949e]">
            {p.fds.map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
        </div>
      )}
      {p.pts.length > 0 && (
        <div>
          <div className="mb-1 text-[9px] uppercase tracking-wide text-[#6e7681]">page table</div>
          <div className="flex flex-wrap gap-1">
            {p.pts.map((t) => (
              <span
                key={t.vpn}
                className="rounded border border-[#30363d] px-1.5 py-px text-[10px] tabular text-[#8b949e]"
              >
                v{t.vpn}→f{t.pfn}{t.supervisor ? ' S' : ''}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function ProcessesPanel({
  snap,
  sel,
  onSelect,
}: {
  snap: Snapshot
  sel: number
  onSelect: (pid: number) => void
}) {
  const counts = { running: 0, ready: 0, blocked: 0, zombie: 0, new: 0 }
  for (const p of snap.procs) counts[p.state]++
  const selProc = snap.procs.find((p) => p.pid === sel)

  return (
    <div className="p-2.5">
      <div className="flex items-baseline justify-between text-[10px] text-[#8b949e]">
        <span className="tabular">
          {counts.running} run · {counts.ready} ready · {counts.blocked} block · {counts.zombie} zombie
        </span>
      </div>

      <div className="mt-2 overflow-hidden rounded-md border border-[#30363d]">
        <div className="flex items-center gap-2 bg-[#0d1117] px-2 py-1 text-[9px] uppercase tracking-wide text-[#6e7681]">
          <span className="w-2.5" />
          <span className="w-7">pid</span>
          <span className="w-7">ppid</span>
          <span className="w-16">state</span>
          <span className="w-9 text-right">mem</span>
          <span className="w-9 text-right">time</span>
          <span className="flex-1">command</span>
        </div>
        {snap.procs.map((p) => {
          const isCur = p.pid === snap.currentPid
          return (
            <button
              key={p.pid}
              onClick={() => onSelect(p.pid)}
              className={cn(
                'flex w-full items-center gap-2 border-t border-[#21262d] px-2 py-[3px] text-left text-[11px] tabular',
                sel === p.pid ? 'bg-[#21262d]' : 'hover:bg-[#0d1117]',
              )}
            >
              <span className="w-2.5 text-[9px] text-[#6e7681]">{isCur ? '*' : ''}</span>
              <span className="w-7 text-[#c9d1d9]">{p.pid}</span>
              <span className="w-7 text-[#6e7681]">{p.ppid}</span>
              <span className="w-16 text-[10px] text-[#8b949e]">{p.state.toUpperCase()}</span>
              <span className="w-9 text-right text-[#6e7681]">{p.pages}p</span>
              <span className="w-9 text-right text-[#6e7681]">{p.ticksUsed}</span>
              <span className={cn('flex-1 truncate', p.state === 'zombie' ? 'text-[#6e7681] line-through' : 'text-[#c9d1d9]')}>
                {p.cmd}
              </span>
              {p.pid === snap.fgPid && <span className="text-[9px] text-[#58a6ff]">fg</span>}
            </button>
          )
        })}
      </div>

      {selProc && <Detail p={selProc} />}
    </div>
  )
}
