import { useState } from 'react'
import { FRAME_COUNT, KERNEL_FRAMES, PAGE_SIZE } from '@/os/memory'
import type { Kernel, Snapshot } from '@/os/kernel'
import { HexDump } from '@/ui/HexDump'
import { hex, pidColor } from '@/ui/theme'
import { cn } from '@/utils/cn'

// 物理帧位图 + MMU 地址翻译 + 帧内字节，三者联动：
// 翻译得到的物理地址会选中对应帧，并在十六进制视图里高亮那一字节。
export function MemoryPanel({
  kernel,
  snap,
  sel,
}: {
  kernel: Kernel
  snap: Snapshot
  sel: number
}) {
  const [vaInput, setVaInput] = useState('0x0000')
  const [frame, setFrame] = useState(0)

  const proc = snap.procs.find((p) => p.pid === sel)
  const pids = [...new Set(snap.frames.filter((f) => typeof f.owner === 'number').map((f) => f.owner as number))]

  const raw = vaInput.trim()
  const va = raw.toLowerCase().startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10)
  const valid = !Number.isNaN(va) && va >= 0
  const vpn = va >>> 8
  const off = va & 0xff
  const pte = valid ? proc?.pts.find((t) => t.vpn === vpn) : undefined
  const pa = pte ? pte.pfn * PAGE_SIZE + off : null
  const maxVa = proc ? proc.pts.length * PAGE_SIZE - 1 : 0

  const pfn = Math.min(frame, FRAME_COUNT - 1)
  const bytes = kernel.ramBytes().subarray(pfn * PAGE_SIZE, (pfn + 1) * PAGE_SIZE)
  const nonZero = bytes.reduce((n, b) => n + (b !== 0 ? 1 : 0), 0)
  const mark = pa !== null && (pa >>> 8) === pfn ? pa : undefined

  return (
    <div className="p-2.5">
      <div className="flex items-baseline justify-between text-[10px] text-[#8b949e]">
        <span>
          物理内存 · {FRAME_COUNT} 帧 × {PAGE_SIZE} B · 前 {KERNEL_FRAMES} 帧内核保留
        </span>
        <span className="tabular">
          {(snap.mem.used / 1024).toFixed(1)} / {(snap.mem.total / 1024).toFixed(0)} KiB
        </span>
      </div>

      <div className="mt-2 grid grid-cols-8 gap-1">
        {snap.frames.map((f) => (
          <button
            key={f.no}
            onClick={() => setFrame(f.no)}
            title={
              f.owner === null
                ? `frame ${f.no} free`
                : f.owner === 'kernel'
                  ? `frame ${f.no} kernel`
                  : `frame ${f.no} pid ${f.owner} ${f.seg}`
            }
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
            {f.no}
          </button>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9.5px] text-[#6e7681]">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-[#21262d]" /> kernel
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm border border-[#21262d]" /> free
        </span>
        {pids.map((pid) => (
          <span key={pid} className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ background: pidColor(pid) }} /> pid {pid}
          </span>
        ))}
      </div>

      <div className="mt-3 rounded-md border border-[#30363d] bg-[#0d1117] p-2.5">
        <div className="text-[9px] uppercase tracking-wide text-[#6e7681]">
          MMU 地址翻译 {proc ? `· pid ${proc.pid} ${proc.name}` : '· 先在进程页选中一个进程'}
        </div>
        {proc && proc.pts.length > 0 ? (
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[#8b949e]">virtual address</span>
              <input
                value={vaInput}
                onChange={(e) => setVaInput(e.target.value)}
                spellCheck={false}
                className="w-24 rounded-md border border-[#30363d] bg-[#010409] px-1.5 py-0.5 text-[11px] tabular text-[#e6edf3] outline-none focus:border-[#58a6ff]"
              />
              <span className="text-[9px] text-[#6e7681]">0x0000 – {hex(maxVa)}</span>
            </div>
            {valid && (
              <div className="text-[10.5px] leading-relaxed tabular">
                <div className="text-[#8b949e]">
                  {hex(va)} = vpn <span className="text-[#58a6ff]">{vpn}</span> + offset{' '}
                  <span className="text-[#58a6ff]">{hex(off, 2)}</span>
                </div>
                {pte ? (
                  <>
                    <div className="text-[#8b949e]">
                      pte[{vpn}] → frame <span style={{ color: pidColor(proc.pid) }}>{pte.pfn}</span>{' '}
                      <span className="text-[#6e7681]">({pte.seg})</span>
                    </div>
                    <div className="flex items-center gap-2 text-[#c9d1d9]">
                      <span>
                        physical = {pte.pfn}×256 + {off} ={' '}
                        <span className="text-[#3fb950]">{hex(pa ?? 0)}</span>
                      </span>
                      <button
                        onClick={() => setFrame(pte.pfn)}
                        className="rounded border border-[#30363d] px-1.5 py-px text-[9.5px] text-[#8b949e] hover:border-[#8b949e] hover:text-[#e6edf3]"
                      >
                        查看该帧
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="text-[#f85149]">page fault: vpn {vpn} not mapped → SIGSEGV</div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-2 text-[10.5px] text-[#6e7681]">该进程没有页（内核线程或已回收）</div>
        )}
      </div>

      <div className="mt-2.5 flex items-baseline justify-between text-[10px]">
        <span className="text-[#c9d1d9]">
          frame {pfn} · 物理地址 {hex(pfn * PAGE_SIZE)}
        </span>
        <span className="truncate pl-2 text-[#8b949e]">{kernel.frameOwnerLabel(pfn)}</span>
      </div>
      <div className="mt-1.5 overflow-x-auto rounded-md border border-[#30363d] bg-[#0d1117] p-2">
        <HexDump bytes={bytes} base={pfn * PAGE_SIZE} highlight={mark} />
      </div>
      <div className="mt-1.5 text-[9.5px] text-[#6e7681]">
        {nonZero} / {PAGE_SIZE} 字节非零 · 代码页存放 CRX 映像，栈页存放 argv，空闲帧在分配时清零
      </div>
    </div>
  )
}
