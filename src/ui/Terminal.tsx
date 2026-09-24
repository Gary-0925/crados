import { useEffect, useRef } from 'react'
import type { Kernel, SegClass, Snapshot } from '@/os/kernel'
import { cn } from '@/utils/cn'

const SEG_CLS: Record<SegClass, string> = {
  out: 'text-[#c9d1d9]',
  err: 'text-[#f85149]',
  sys: 'text-[#6e7681]',
  echo: 'text-[#e6edf3]',
}

export function Terminal({ kernel, snap }: { kernel: Kernel; snap: Snapshot }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    boxRef.current?.focus()
  }, [kernel])

  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  const onScroll = () => {
    const el = scrollRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase()
      if (k === 'c' && !e.shiftKey) {
        kernel.pressCtrlC()
        e.preventDefault()
      } else if (k === 'd') {
        kernel.pressCtrlD()
        e.preventDefault()
      } else if (k === 'l') {
        kernel.pressCtrlL()
        e.preventDefault()
      }
      return
    }
    if (e.key === 'Enter') {
      kernel.pressEnter()
      e.preventDefault()
    } else if (e.key === 'Backspace') {
      kernel.pressBackspace()
      e.preventDefault()
    } else if (e.key.length === 1) {
      kernel.typeChar(e.key)
      e.preventDefault()
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    for (const ch of e.clipboardData.getData('text')) {
      if (ch === '\n' || ch === '\r') kernel.pressEnter()
      else kernel.typeChar(ch)
    }
    e.preventDefault()
  }

  return (
    <div
      ref={boxRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onClick={() => boxRef.current?.focus()}
      className="flex h-full min-h-0 cursor-text flex-col bg-[#010409] outline-none"
    >
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-[#21262d] px-3 text-[10px] text-[#6e7681]">
        <span>tty0 — console device, canonical mode</span>
        <span>Ctrl-C interrupt · Ctrl-D EOF · Ctrl-L clear</span>
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {snap.lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all text-[12.5px] leading-[1.5]">
            {line.segs.map((s, j) => (
              <span key={j} className={SEG_CLS[s.c]}>
                {s.t}
              </span>
            ))}
            {i === snap.lines.length - 1 && (
              <span
                className={cn(
                  'cursor-blink ml-px inline-block h-[13px] w-[7px] translate-y-[2px]',
                  snap.panic ? 'bg-[#f85149]' : 'bg-[#58a6ff]',
                )}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
