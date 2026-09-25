// 偏移 + 字节 + ASCII 三栏。highlight 标出该区域内被关注的那一字节。

export function HexDump({
  bytes,
  base,
  highlight,
  onByteChange,
}: {
  bytes: Uint8Array
  base: number
  highlight?: number
  onByteChange?: (address: number, value: number) => void
}) {
  const rows: React.ReactNode[] = []
  for (let off = 0; off < bytes.length; off += 16) {
    const row = Array.from(bytes.subarray(off, off + 16))
    rows.push(
      <div key={off} className="flex gap-2.5 whitespace-pre">
        <span className="text-[#484f58]">{(base + off).toString(16).padStart(8, '0')}</span>
        <span>
          {row.map((b, i) => {
            const hit = highlight !== undefined && base + off + i === highlight
            const address = base + off + i
            const tone = hit ? 'bg-[#f78166] text-[#010409]' : b === 0 ? 'text-[#30363d]' : 'text-[#58a6ff]'
            if (!onByteChange) {
              return (
                <span key={i} className={tone}>
                  {b.toString(16).padStart(2, '0')}
                  {i === 7 ? '  ' : ' '}
                </span>
              )
            }
            return (
              <span key={`${address}:${b}`}>
                <input
                  defaultValue={b.toString(16).padStart(2, '0')}
                  aria-label={`byte ${address.toString(16)}`}
                  className={`w-[2.2ch] bg-transparent p-0 text-center font-mono outline-none focus:bg-[#21262d] ${tone}`}
                  maxLength={2}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                  onBlur={(e) => {
                    const text = e.currentTarget.value.trim()
                    if (!/^[0-9a-f]{1,2}$/i.test(text)) {
                      e.currentTarget.value = b.toString(16).padStart(2, '0')
                      return
                    }
                    onByteChange(address, parseInt(text, 16))
                  }}
                />
                {i === 7 ? '  ' : ' '}
              </span>
            )
          })}
          {row.length < 16 && ' '.repeat((16 - row.length) * 3)}
        </span>
        <span className="text-[#8b949e]">
          |
          {row.map((b, i) => (
            <span
              key={i}
              className={
                highlight !== undefined && base + off + i === highlight
                  ? 'bg-[#f78166] text-[#010409]'
                  : b >= 32 && b < 127
                    ? 'text-[#e6edf3]'
                    : 'text-[#30363d]'
              }
            >
              {b >= 32 && b < 127 ? String.fromCharCode(b) : '.'}
            </span>
          ))}
          |
        </span>
      </div>,
    )
  }
  return <div className="text-[10.5px] leading-[1.55] tabular">{rows}</div>
}
