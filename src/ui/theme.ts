import type { PState } from '@/os/types'

// GitHub dark 配色
export const C = {
  bg: '#0d1117',
  panel: '#010409',
  border: '#30363d',
  soft: '#21262d',
  text: '#e6edf3',
  muted: '#8b949e',
  dim: '#6e7681',
  blue: '#58a6ff',
  green: '#3fb950',
  amber: '#d29922',
  red: '#f85149',
  purple: '#bc8cff',
}

export const STATE_STYLE: Record<PState, { text: string; dot: string; label: string }> = {
  new: { text: 'text-[#58a6ff]', dot: 'bg-[#58a6ff]', label: 'NEW' },
  ready: { text: 'text-[#8b949e]', dot: 'bg-[#6e7681]', label: 'READY' },
  running: { text: 'text-[#3fb950]', dot: 'bg-[#3fb950]', label: 'RUN' },
  blocked: { text: 'text-[#d29922]', dot: 'bg-[#d29922]', label: 'BLOCK' },
  zombie: { text: 'text-[#f85149]', dot: 'bg-[#f85149]', label: 'ZOMBIE' },
}

const PID_COLORS = ['#3fb950', '#58a6ff', '#bc8cff', '#d29922', '#f85149', '#39c5cf', '#db6d28', '#a5d6ff']

export const pidColor = (pid: number): string => PID_COLORS[pid % PID_COLORS.length]

export const hex = (n: number, w = 4): string => '0x' + n.toString(16).padStart(w, '0')
