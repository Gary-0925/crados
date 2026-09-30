// 固件的启动菜单：上电前先决定系统盘位上的字节从哪来。
//
// 它问的全是介质的事（probeBootMedia：持久介质能不能用、存过哪些盘），
// 不解析盘上的文件系统，也不碰操作系统：开机前还没有操作系统。
// 用户在这里做的选择就是 BootMedium，交给 machine.powerOn() 装上盘位。

import { useEffect, useRef, useState } from 'react'
import { CircleAlert, Database, FileUp, HardDrive, LoaderCircle } from 'lucide-react'
import { probeBootMedia } from '@/hw/boot'
import type { BootMedium, BootProbe } from '@/hw/boot'
import { OS_VERSION } from '@/os/version'
import { cn } from '@/hw/ui/cn'

const MiB = 1024 * 1024

const sizeText = (bytes: number): string =>
  bytes >= MiB ? `${(bytes / MiB).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`

const timeText = (ms: number): string => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function BootMenu({
  busy,
  error,
  onBoot,
}: {
  busy: boolean
  error: string | null
  onBoot: (medium: BootMedium) => void
}) {
  const [probe, setProbe] = useState<BootProbe | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    void probeBootMedia().then((p) => {
      if (alive) setProbe(p)
    })
    return () => {
      alive = false
    }
  }, [])

  const sda = probe?.system ?? null
  const others = probe?.removable ?? []
  const idbOk = probe?.storageOk ?? true

  const pickImage = async (file: File) => {
    if (busy) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    onBoot({ kind: 'image', bytes, filename: file.name })
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-[#0d1117] p-6 font-mono text-[#c9d1d9]">
      <div className="w-full max-w-xl">
        <div className="flex items-baseline gap-2">
          <span className="text-[17px] font-semibold text-[#e6edf3]">crados {OS_VERSION}</span>
          <span className="text-[11px] text-[#6e7681]">a transparent OS · 系统盘从哪来</span>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-[#8b949e]">
          这台机器的文件系统就是一块盘上的字节。上电前固件先问系统盘位上的字节从哪来：
          接着用这个浏览器里保存的盘、插一份导出的 .img，或者现做一张空盘再往上面装系统。
        </p>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-[#f85149]/40 bg-[#f85149]/10 px-3 py-2 text-[11.5px] leading-relaxed text-[#ff7b72]">
            <CircleAlert size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-4 space-y-2">
          <Option
            icon={<Database size={16} />}
            title="从 IndexedDB 加载"
            desc="恢复这个浏览器里保存的系统盘，之前的文件与改动都还在"
            meta={
              idbOk ? (
                sda ? (
                  <>
                    <span className="text-[#3fb950]">sda · {sizeText(sda.bytes)}</span>
                    <span className="text-[#6e7681]">保存于 {timeText(sda.savedAt)}</span>
                    {others.length > 0 && (
                      <span className="text-[#6e7681]">
                        另有 {others.map((m) => m.name).join('、')} 会一并装回
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-[#6e7681]">
                    {probe === null ? '正在读取…' : '没有已保存的系统盘'}
                  </span>
                )
              ) : (
                <span className="text-[#d29922]">此环境没有 IndexedDB，无法落盘</span>
              )
            }
            disabled={busy || !idbOk || !sda}
            onClick={() => onBoot({ kind: 'stored' })}
          />

          <Option
            icon={<FileUp size={16} />}
            title="从 .img 文件加载"
            desc="把导出的整盘镜像当作系统盘；格式必须是 ext2 且几何与本机一致"
            meta={<span className="text-[#6e7681]">整盘镜像 · 1 MiB · ext2</span>}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          />

          <Option
            icon={<HardDrive size={16} />}
            title="创建空盘并装载系统"
            desc="格式化一张新盘，写入出厂目录树与 /bin，IndexedDB 里的旧存档被替换"
            meta={<span className="text-[#6e7681]">factory image · 1 MiB</span>}
            disabled={busy}
            onClick={() => onBoot({ kind: 'blank' })}
          />
        </div>

        {busy && (
          <div className="mt-4 flex items-center gap-2 text-[11.5px] text-[#8b949e]">
            <LoaderCircle size={13} className="animate-spin" />
            正在启动…
          </div>
        )}

        <p className="mt-5 text-[10.5px] leading-relaxed text-[#6e7681]">
          三种方式都会在开机时重烧 /bin，保证程序与当前固件一致。开机之后磁盘改动按脏标记
          回写 IndexedDB，只写变化过的 16 KiB 分块。
        </p>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".img,.bin,application/octet-stream"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void pickImage(file)
        }}
      />
    </div>
  )
}

function Option({
  icon,
  title,
  desc,
  meta,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  desc: string
  meta: React.ReactNode
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border border-[#30363d] bg-[#010409] px-3.5 py-3 text-left transition-colors',
        disabled ? 'cursor-not-allowed opacity-45' : 'hover:border-[#8b949e] hover:bg-[#0d1117]',
      )}
    >
      <span className="mt-0.5 shrink-0 text-[#f78166]">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-[#e6edf3]">{title}</span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-[#8b949e]">{desc}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] tabular">{meta}</span>
      </span>
    </button>
  )
}
