import { useEffect, useRef } from 'react'
import type { Snapshot } from '@/cp/snapshot'
import { cn } from '@/utils/cn'

function useStick() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  })
  return ref
}

export function TracePanel({ snap }: { snap: Snapshot }) {
  const ref = useStick()
  return (
    <div className="flex h-full flex-col p-2.5">
      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto text-[10.5px] leading-[1.6] tabular">
        {snap.trace.map((t, i) => (
          <div key={i} className="flex gap-2 whitespace-nowrap">
            <span className="w-11 shrink-0 text-right text-[#484f58]">{t.tick}</span>
            <span className="w-14 shrink-0 truncate text-[#6e7681]">
              {t.pid}:{t.pname}
            </span>
            <span className="text-[#c9d1d9]">{t.text}</span>
            <span
              className={cn(
                'ml-auto pl-3',
                t.err ? 'text-[#f85149]' : t.ret === 'blocked' ? 'text-[#d29922]' : 'text-[#6e7681]',
              )}
            >
              {t.ret === 'blocked' || t.ret === '-' ? t.ret : `= ${t.ret}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function KmsgPanel({ snap }: { snap: Snapshot }) {
  const ref = useStick()
  return (
    <div className="flex h-full flex-col p-2.5">
      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto text-[10.5px] leading-[1.6] tabular">
        {snap.kmsgText.map((l, i) => {
          const sep = l.indexOf(']')
          return (
            <div key={i} className="whitespace-pre-wrap text-[#8b949e]">
              <span className="text-[#484f58]">{sep >= 0 ? l.slice(0, sep + 1) : ''}</span>
              {sep >= 0 ? l.slice(sep + 1) : l}
            </div>
          )
        })}
      </div>
    </div>
  )
}
