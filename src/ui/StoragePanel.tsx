import { useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Download,
  Eraser,
  File,
  Folder,
  SquareTerminal,
  Trash2,
  Upload,
  Usb,
} from 'lucide-react'
import type { FSNode, Kernel, Snapshot } from '@/os/kernel'
import { isErr, strerror } from '@/os/types'
import { HexDump } from '@/ui/HexDump'
import { cn } from '@/utils/cn'

const BLOCK_TONE: Record<string, string> = {
  super: '#d29922',
  bitmap: '#db6d28',
  itable: '#bc8cff',
  dir: '#58a6ff',
  file: '#3fb950',
  data: '#39c5cf',
  free: 'transparent',
}

const DISK_TONE: Record<string, string> = {
  sda: 'text-[#58a6ff]',
  sdb: 'text-[#bc8cff]',
  rom: 'text-[#d29922]',
}

function IconBtn({
  children,
  label,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={cn(
        'rounded-md border border-[#30363d] p-1',
        disabled
          ? 'cursor-not-allowed opacity-30'
          : danger
            ? 'text-[#f85149] hover:border-[#f85149]/50 hover:bg-[#f85149]/10'
            : 'text-[#8b949e] hover:border-[#8b949e] hover:text-[#e6edf3]',
      )}
    >
      {children}
    </button>
  )
}

function Node({
  node,
  depth,
  open,
  toggle,
  sel,
  onSelect,
}: {
  node: FSNode
  depth: number
  open: Set<string>
  toggle: (path: string) => void
  sel: string
  onSelect: (n: FSNode) => void
}) {
  const isDir = node.type === 'dir'
  const expanded = open.has(node.path)
  return (
    <div>
      <button
        onClick={() => (isDir ? toggle(node.path) : onSelect(node))}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-sm py-[2px] pr-1.5 text-left text-[11px] hover:bg-[#0d1117]',
          sel === node.path && 'bg-[#21262d]',
        )}
        style={{ paddingLeft: depth * 12 + 5 }}
      >
        {isDir ? (
          <>
            {expanded ? (
              <ChevronDown size={11} className="shrink-0 text-[#6e7681]" />
            ) : (
              <ChevronRight size={11} className="shrink-0 text-[#6e7681]" />
            )}
            <Folder size={12} className="shrink-0 text-[#8b949e]" />
          </>
        ) : (
          <>
            <span className="w-[11px] shrink-0" />
            {node.type === 'dev' ? (
              <SquareTerminal size={12} className="shrink-0 text-[#58a6ff]" />
            ) : (
              <File size={12} className={cn('shrink-0', node.exec ? 'text-[#3fb950]' : 'text-[#8b949e]')} />
            )}
          </>
        )}
        <span className={cn('truncate', isDir ? 'text-[#e6edf3]' : 'text-[#8b949e]')}>{node.name}</span>
        {node.exec && node.type === 'file' && <span className="text-[9px] text-[#3fb950]">x</span>}
        <span className={cn('ml-auto pl-2 text-[9px] tabular', DISK_TONE[node.disk] ?? 'text-[#6e7681]')}>
          {node.type === 'dev' ? 'dev' : node.disk}
        </span>
      </button>
      {isDir &&
        expanded &&
        node.kids.map((k) => (
          <Node key={k.path} node={k} depth={depth + 1} open={open} toggle={toggle} sel={sel} onSelect={onSelect} />
        ))}
    </div>
  )
}

function find(node: FSNode, path: string): FSNode | null {
  if (node.path === path) return node
  for (const k of node.kids) {
    const r = find(k, path)
    if (r) return r
  }
  return null
}

export function StoragePanel({ kernel, snap }: { kernel: Kernel; snap: Snapshot }) {
  const [dev, setDev] = useState('sda')
  const [view, setView] = useState<'files' | 'blocks'>('files')
  const [block, setBlock] = useState(0)
  const [open, setOpen] = useState<Set<string>>(() => new Set(['/']))
  const [selPath, setSelPath] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const sdb = snap.disks.find((d) => d.name === 'sdb')!
  const active = snap.disks.find((d) => d.name === dev)?.present ? dev : 'sda'
  const info = snap.disks.find((d) => d.name === active)!

  const sel = selPath ? find(snap.tree, selPath) : null
  const owned = sel && sel.disk === active && sel.blockList ? new Set(sel.blockList) : new Set<number>()

  const layout = kernel.diskLayout(active)
  const bs = layout?.blockSize ?? 256
  const cur = layout ? Math.min(block, layout.map.length - 1) : 0

  const run = (r: unknown, ok: string) => setMsg(isErr(r) ? `error: ${strerror(r)}` : ok)

  const gotoBlock = (b: number) => {
    setBlock(b)
    setView('blocks')
  }

  const pickFile = (n: FSNode) => {
    setSelPath(n.path)
    if (n.disk !== active && snap.disks.some((d) => d.name === n.disk && d.present)) setDev(n.disk)
    if (n.blockList?.length) setBlock(n.blockList[0])
  }

  const onImport = async (f: File) => {
    const raw = new Uint8Array(await f.arrayBuffer())
    run(kernel.importUsb(raw, f.name), `loaded ${raw.length} bytes from ${f.name}`)
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-[#21262d] p-2.5">
        <div className="flex items-center gap-1.5">
          <div className="flex flex-1 overflow-hidden rounded-md border border-[#30363d]">
            {snap.disks.map((d) => (
              <button
                key={d.name}
                disabled={!d.present}
                onClick={() => {
                  setDev(d.name)
                  setBlock(0)
                }}
                className={cn(
                  'flex-1 px-2 py-1 text-[10.5px]',
                  !d.present && 'cursor-not-allowed opacity-30',
                  active === d.name ? 'bg-[#21262d] text-[#e6edf3]' : 'text-[#6e7681] hover:text-[#c9d1d9]',
                )}
              >
                {d.name}
              </button>
            ))}
          </div>
          {sdb.present ? (
            <>
              <IconBtn label="导出 sdb 镜像" onClick={() => run(kernel.exportUsb(), 'image saved')}>
                <Download size={12} />
              </IconBtn>
              <IconBtn label="导入镜像" onClick={() => fileRef.current?.click()} disabled={!!sdb.mountpoint}>
                <Upload size={12} />
              </IconBtn>
              <IconBtn
                label="格式化 sdb"
                onClick={() => run(kernel.formatUsb(), 'mkfs complete')}
                disabled={!!sdb.mountpoint}
              >
                <Eraser size={12} />
              </IconBtn>
              <IconBtn
                label="拔出 sdb"
                onClick={() => run(kernel.detachUsb(), 'device detached')}
                disabled={!!sdb.mountpoint}
                danger
              >
                <Usb size={12} />
              </IconBtn>
            </>
          ) : (
            <>
              <IconBtn label="插入空白 U 盘" onClick={() => run(kernel.attachUsb('usb'), 'medium attached')}>
                <Usb size={12} />
              </IconBtn>
              <IconBtn label="从电脑导入镜像" onClick={() => fileRef.current?.click()}>
                <Upload size={12} />
              </IconBtn>
            </>
          )}
          <IconBtn
            label="清除浏览器持久化数据"
            onClick={() => {
              kernel.wipeRoot()
              setMsg('persistent store cleared - 重启后恢复出厂状态')
            }}
            danger
          >
            <Trash2 size={12} />
          </IconBtn>
        </div>

        <div className="flex items-baseline gap-2 text-[9.5px] text-[#6e7681]">
          <span className="text-[#8b949e]">{info.model}</span>
          <span className="tabular">
            {info.usedBlocks}/{info.blocks} blk × {info.blockSize} B
          </span>
          <span>{info.mountpoint ?? 'not mounted'}</span>
          <span className={cn('ml-auto', snap.dirty ? 'text-[#d29922]' : 'text-[#3fb950]')}>
            {!snap.storageOk ? '存储不可用' : snap.dirty ? '写回中…' : '已自动保存'}
          </span>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".img,.bin,application/octet-stream"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onImport(f)
        }}
      />

      <div className="flex shrink-0 gap-1 px-2.5 pt-2">
        {(['files', 'blocks'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={cn(
              'rounded-md px-2 py-0.5 text-[10.5px]',
              view === v ? 'bg-[#21262d] text-[#e6edf3]' : 'text-[#6e7681] hover:text-[#c9d1d9]',
            )}
          >
            {v === 'files' ? `文件 · ${snap.fs.used}/${snap.fs.max} inode` : `块 · ${info.blocks}`}
          </button>
        ))}
      </div>

      {msg && (
        <div className="mx-2.5 mt-2 shrink-0 truncate rounded-md border border-[#30363d] bg-[#0d1117] px-2 py-1 text-[10px] text-[#8b949e]">
          {msg}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {view === 'files' ? (
          <>
            <div className="rounded-md border border-[#30363d] bg-[#0d1117] p-1">
              <Node
                node={snap.tree}
                depth={0}
                open={open}
                toggle={(p) =>
                  setOpen((prev) => {
                    const next = new Set(prev)
                    if (next.has(p)) next.delete(p)
                    else next.add(p)
                    return next
                  })
                }
                sel={selPath}
                onSelect={pickFile}
              />
            </div>

            {sel && (
              <div className="mt-2 rounded-md border border-[#30363d] bg-[#010409] p-2">
                <div className="flex items-baseline justify-between">
                  <span className="truncate text-[11px] text-[#e6edf3]">{sel.path}</span>
                  <span className="shrink-0 pl-2 text-[9px] text-[#6e7681]">
                    {sel.disk} inode {sel.ino} · {sel.size} B · {sel.blocks} blk
                  </span>
                </div>
                {sel.blockList && sel.blockList.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[9.5px] text-[#6e7681]">
                    <span>块指针</span>
                    {sel.blockList.map((b) => (
                      <button
                        key={b}
                        onClick={() => gotoBlock(b)}
                        className="rounded border border-[#30363d] px-1 tabular hover:border-[#8b949e] hover:text-[#e6edf3]"
                      >
                        #{b}
                      </button>
                    ))}
                    <span>· 末块用到第 {sel.size % bs || bs} 字节</span>
                  </div>
                )}
                {sel.disasm && (
                  <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre rounded-md border border-[#30363d] bg-[#0d1117] p-1.5 text-[10px] leading-relaxed text-[#8b949e]">
                    {sel.disasm.join('\n')}
                  </pre>
                )}
                {sel.data !== undefined && (
                  <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[#30363d] bg-[#0d1117] p-1.5 text-[10px] leading-relaxed text-[#8b949e]">
                    {sel.data || '(empty file)'}
                  </pre>
                )}
              </div>
            )}
          </>
        ) : (
          layout && (
            <>
              <div className="grid grid-cols-16 gap-[3px]">
                {layout.map.map((b) => (
                  <button
                    key={b.no}
                    onClick={() => setBlock(b.no)}
                    title={`block ${b.no}: ${b.label}`}
                    className={cn(
                      'aspect-square rounded-[2px] border',
                      b.no === cur && 'ring-1 ring-[#f78166]',
                      owned.has(b.no) && b.no !== cur && 'ring-1 ring-[#e6edf3]',
                    )}
                    style={{
                      background: BLOCK_TONE[b.kind],
                      borderColor: b.kind === 'free' ? '#21262d' : 'transparent',
                    }}
                  />
                ))}
              </div>
              <div className="mt-2 flex items-baseline justify-between text-[10px]">
                <span className="text-[#c9d1d9] tabular">
                  block {cur} · 0x{(cur * bs).toString(16).padStart(5, '0')}
                </span>
                <span className="truncate pl-2 text-[#8b949e]">{layout.map[cur].label}</span>
              </div>
              <div className="mt-1.5 overflow-x-auto rounded-md border border-[#30363d] bg-[#0d1117] p-2">
                <HexDump bytes={layout.bytes.subarray(cur * bs, (cur + 1) * bs)} base={cur * bs} />
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-2.5 text-[9px] text-[#6e7681]">
                {[
                  ['super', 'superblock'],
                  ['bitmap', 'bitmap'],
                  ['itable', 'inodes'],
                  ['dir', 'dirents'],
                  ['file', 'data'],
                ].map(([k, label]) => (
                  <span key={k} className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-sm" style={{ background: BLOCK_TONE[k] }} /> {label}
                  </span>
                ))}
              </div>
            </>
          )
        )}
      </div>
    </div>
  )
}
