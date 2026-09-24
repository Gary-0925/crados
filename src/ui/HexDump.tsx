// 共用的十六进制视图：偏移 + 字节 + ASCII 三栏
// highlight 用于标出该区域内被关注的字节（例如 MMU 翻译命中的那一字节）

export function HexDump({
  bytes,
  base,
  highlight,
}: {
  bytes: Uint8Array
  base: number
  highlight?: number
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
            return (
              <span
                key={i}
                className={
                  hit
                    ? 'rounded-[2px] bg-[#f78166] text-[#010409]'
                    : b === 0
                      ? 'text-[#30363d]'
                      : 'text-[#58a6ff]'
                }
              >
                {b.toString(16).padStart(2, '0')}
                {hit ? '' : i === 7 ? '  ' : ' '}
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
