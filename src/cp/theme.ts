const PID_COLORS = ['#3fb950', '#58a6ff', '#bc8cff', '#d29922', '#f85149', '#39c5cf', '#db6d28', '#a5d6ff']

export const pidColor = (pid: number): string => PID_COLORS[pid % PID_COLORS.length]

export const hex = (n: number, w = 4): string => '0x' + n.toString(16).padStart(w, '0')
