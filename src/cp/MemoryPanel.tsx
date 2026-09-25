import { useState } from 'react'
import { FRAME_COUNT, PAGE_SIZE } from '@/os/memory'
import type { Kernel } from '@/os/kernel'
import type { Snapshot } from '@/cp/snapshot'
import { HexDump } from '@/cp/HexDump'
import { hex, pidColor } from '@/cp/theme'
import { cn } from '@/utils/cn'

export function MemoryPanel({
  kernel,
  snap,
  sel,
  onMutate,
}: {
  kernel: Kernel
  snap: Snapshot
  sel: number
  onMutate: () => void
}) {
  const [vaInput, setVaInput] = useState('0x0000')
  const [frame, setFrame] = useState(0)

  const proc = snap.procs.find((p) => p.pid === sel)

  const raw = vaInput.trim()
  const va = raw.toLowerCase().startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10)
  const valid = !Number.isNaN(va) && va >= 0
  const vpn = va >>> 8
  const off = va & 0xff
  const pte = valid ? proc?.pts.find((t) => t.vpn === vpn) : undefined
  const pa = pte ? pte.pfn * PAGE_SIZE + off : null
  const maxVa = proc ? proc.pts.length * PAGE_SIZE - 1 : 0

  const pfn = Math.min(frame, FRAME_COUNT - 1)
  const bytes = kernel.mem.bytes.subarray(pfn * PAGE_SIZE, (pfn + 1) * PAGE_SIZE)
  const nonZero = bytes.reduce((n, b) => n + (b !== 0 ? 1 : 0), 0)
  const mark = pa !== null && (pa >>> 8) === pfn ? pa : undefined
  const selectedFrame = snap.frames[pfn]
  const frameLabel =
    selectedFrame.owner === null
      ? 'free'
      : selectedFrame.owner === 'kernel'
        ? 'kernel'
        : `pid ${selectedFrame.owner}`

  return (
    <div className="p-2.5">
      <div className="flex items-baseline justify-between text-[10px] text-[#8b949e]">
        <span>
          物理内存 · {FRAME_COUNT} × {PAGE_SIZE} B
        </span>
        <span className="tabular">
          {(snap.mem.used / 1024).toFixed(1)} / {(snap.mem.total / 1024).toFixed(0)} KiB
        </span>
      </div>

      <div
        className="mt-2 grid gap-px"
        style={{ gridTemplateColumns: `repeat(${FRAME_COUNT > 64 ? 16 : 8}, minmax(0, 1fr))` }}
      >
        {snap.frames.map((f) => (
          <button
            key={f.no}
            onClick={() => setFrame(f.no)}
            title={`frame ${f.no}`}
            className={cn(
              'flex aspect-square items-center justify-center rounded-sm border text-[8px] tabular',
              f.no === pfn && 'ring-1 ring-[#f78166]',
            )}
            style={{
              background: f.owner === null ? 'transparent' : f.owner === 'kernel' ? '#21262d' : pidColor(f.owner),
              borderColor: f.owner === null ? '#21262d' : 'transparent',
              color: f.owner === null ? '#30363d' : f.owner === 'kernel' ? '#8b949e' : '#010409',
            }}
          >
            {FRAME_COUNT > 64 ? '' : f.no}
          </button>
        ))}
      </div>

      {proc && proc.pts.length > 0 && (
        <div className="mt-3 border-t border-[#30363d] pt-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[#8b949e]">虚拟地址</span>
            <input
              value={vaInput}
              onChange={(e) => setVaInput(e.target.value)}
              spellCheck={false}
              className="w-24 rounded-md border border-[#30363d] bg-[#010409] px-1.5 py-0.5 text-[11px] tabular text-[#e6edf3] outline-none focus:border-[#58a6ff]"
            />
            <span className="text-[9px] text-[#6e7681]">0x0000 – {hex(maxVa)}</span>
          </div>
          {valid && (
            <div className="mt-1.5 text-[10.5px] leading-relaxed tabular">
              <div className="text-[#8b949e]">
                {hex(va)} = vpn <span className="text-[#58a6ff]">{vpn}</span> + offset{' '}
                <span className="text-[#58a6ff]">{hex(off, 2)}</span>
              </div>
              {pte ? (
                <>
                  <div className="text-[#8b949e]">
                    pte[{vpn}] → frame {pte.pfn}
                  </div>
                  <div className="flex items-center gap-2 text-[#c9d1d9]">
                    <span>physical = {hex(pa ?? 0)}</span>
                    <button
                      onClick={() => setFrame(pte.pfn)}
                      className="rounded border border-[#30363d] px-1.5 py-px text-[9.5px] text-[#8b949e] hover:border-[#8b949e] hover:text-[#e6edf3]"
                    >
                      查看该帧
                    </button>
                  </div>
                </>
              ) : (
                <div className="text-[#f85149]">page fault: vpn {vpn} not mapped</div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-2 overflow-x-auto border-t border-[#30363d] pt-2">
        <HexDump
          bytes={bytes}
          base={pfn * PAGE_SIZE}
          highlight={mark}
          onByteChange={(address, value) => {
            kernel.mem.bytes[address] = value
            onMutate()
          }}
        />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between text-[9.5px] text-[#6e7681]">
        <span>
          frame {pfn} · {hex(pfn * PAGE_SIZE)} · {frameLabel}
        </span>
        <span className="tabular">
          {nonZero} / {PAGE_SIZE}
        </span>
      </div>
    </div>
  )
}
