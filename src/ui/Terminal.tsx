import { useEffect, useRef } from 'react'
import type { Kernel, SegClass } from '@/os/kernel'
import { showCtl } from '@/ui/theme'

const SEG_CLS: Record<SegClass, string> = {
  out: 'text-[#c9d1d9]',
  err: 'text-[#f85149]',
  sys: 'text-[#6e7681]',
  echo: 'text-[#e6edf3]',
}

// 控制台只依赖内核的 tty 设备，与 /cp 无关。
export function Terminal({ kernel }: { kernel: Kernel }) {
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
    } else if (e.key.length === 1 || e.code === 'Minus' || e.code === 'NumpadSubtract') {
      // 某些输入法会把 Minus 的 e.key 报成 C0 控制字节，按物理键规范化
      const ch =
        e.code === 'Minus' ? (e.shiftKey ? '_' : '-') : e.code === 'NumpadSubtract' ? '-' : e.key
      kernel.typeChar(ch)
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

  const lines = kernel.consoleLines()

  return (
    <div
      ref={boxRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onClick={() => boxRef.current?.focus()}
      className="flex h-full min-h-0 cursor-text flex-col bg-[#010409] outline-none"
    >
      <div className="shrink-0 border-b border-[#21262d] px-3 py-1 text-[10px] text-[#6e7681]">
        Ctrl-C interrupt · Ctrl-D EOF · Ctrl-L clear
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {lines.map((line, i) => (
          <div key={i} className="whitespace-pre-wrap break-all text-[12.5px] leading-[1.5]">
            {line.segs.map((s, j) => (
              <span key={j} className={SEG_CLS[s.c]}>
                {showCtl(s.t)}
              </span>
            ))}
            {i === lines.length - 1 && (
              <span className="ml-px inline-block h-[13px] w-[7px] translate-y-[2px] bg-[#c9d1d9]" />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
