// 虚拟硬件：控制台（tty0）= 显示器 + 键盘 + 串口寄存器。
//
// 这里是"屏幕上的字"和"键盘敲进来的字节"，不掺任何策略：谁可以发信号、Ctrl-C
// 该杀谁、登录会话归哪个进程，全是操作系统（os/kernel.ts 的行规）的事。
//
// MMIO 寄存器（内核态用普通读写指令访问）：
//   0xFF00  TTY_OUT    控制台输出，逐字节写
//   0xFF01  TTY_ERR    控制台错误输出
//   0xFF10  TTY_STATUS 读：0 无数据 / 1 有数据 / 2 EOF / 3 行尾 / 4 本行最后一字节
//   0xFF11  TTY_DATA   读：取一个字节
//   0xFF12  TTY_MODE   写 0 关闭回显（密码输入），非 0 恢复
//
// 写进来的字节按 UTF-8 流解码（半个字符可以跨多次写），并且
// ESC [ 2 J 这种控制序列也可能跨多次写，所以驱动保留未完成的序列前缀。

export type SegClass = 'out' | 'err' | 'sys' | 'echo'
export interface Seg {
  t: string
  c: SegClass
}
export interface Line {
  segs: Seg[]
}

export const TTY_OUT = 0xff00
export const TTY_ERR = 0xff01
export const TTY_STATUS = 0xff10
export const TTY_DATA = 0xff11
export const TTY_MODE = 0xff12
const CLEAR = '\x1b[2J'
/** 键盘一行最多这么多个字符 */
const LINE_CAP = 256

const UTF8_ENCODER = new TextEncoder()

export class Console {
  private lines: Line[] = []
  private lineBuf = ''
  /** 待读的整行（null = EOF）。内核的读端按行取走。 */
  private lineQueue: (string | null)[] = []
  private inputPacket: Uint8Array | null | undefined
  private inputOffset = 0
  /** 键盘中断线：有整行可读 */
  private irqLine = false
  /** 规范模式回显开关：密码输入时 CRX 内核通过 MMIO 0xFF12 关掉它 */
  private echoOn = true
  /** 跨多次写、还没凑齐的转义序列前缀 */
  private escape = ''
  // TTY 是字节设备，UTF-8 只在驱动边界解码；stream 模式能跨 write 调用保留半个字符。
  private readonly decoders = {
    out: new TextDecoder('utf-8', { fatal: false }),
    err: new TextDecoder('utf-8', { fatal: false }),
  }

  // ---------- 显示器 ----------

  screen(): Line[] {
    return this.lines
  }

  clear() {
    this.lines = []
  }

  /** 往屏幕写一段文本（内核的日志、程序的输出） */
  write(text: string, cls: SegClass) {
    if (!text) return
    let rest = text
    while (rest.includes(CLEAR)) {
      const i = rest.indexOf(CLEAR)
      if (i > 0) this.raw(rest.slice(0, i), cls)
      this.lines = []
      rest = rest.slice(i + 4)
    }
    if (rest) this.raw(rest, cls)
  }

  private raw(text: string, cls: SegClass) {
    const parts = text.split('\n')
    this.append(parts[0], cls)
    for (let i = 1; i < parts.length; i++) {
      this.lines.push({ segs: parts[i] ? [{ t: parts[i], c: cls }] : [] })
      if (this.lines.length > 600) this.lines.shift()
    }
  }

  private append(s: string, cls: SegClass) {
    if (!s) {
      if (!this.lines.length) this.lines.push({ segs: [] })
      return
    }
    if (!this.lines.length) this.lines.push({ segs: [] })
    const line = this.lines[this.lines.length - 1]
    const last = line.segs[line.segs.length - 1]
    if (last && last.c === cls) last.t += s
    else line.segs.push({ t: s, c: cls })
  }

  // ---------- 串口（MMIO） ----------

  /** 串口输出寄存器：写进来的字节按 UTF-8 流拼回文本 */
  writePort(port: number, byte: number): boolean {
    const raw = Uint8Array.of(byte & 0xff)
    if (port === TTY_OUT) {
      this.screenTty(this.decoders.out.decode(raw, { stream: true }), 'out')
      return true
    }
    if (port === TTY_ERR) {
      this.screenTty(this.decoders.err.decode(raw, { stream: true }), 'err')
      return true
    }
    if (port === TTY_MODE) {
      this.echoOn = (byte & 0xff) !== 0
      return true
    }
    return false
  }

  /** 清屏序列可能被拆成好几次 MMIO 写，这里把没写完的前缀留在 escape 里 */
  private screenTty(text: string, cls: SegClass) {
    if (!text) return
    const combined = this.escape + text
    this.escape = ''
    let from = 0
    while (from < combined.length) {
      const hit = combined.indexOf(CLEAR, from)
      if (hit >= 0) {
        if (hit > from) this.write(combined.slice(from, hit), cls)
        this.lines = []
        from = hit + CLEAR.length
        continue
      }
      const tail = combined.slice(from)
      let keep = 0
      for (let n = 1; n < CLEAR.length; n++) {
        if (tail.endsWith(CLEAR.slice(0, n))) keep = n
      }
      if (keep) {
        const visible = tail.slice(0, -keep)
        if (visible) this.write(visible, cls)
        this.escape = tail.slice(-keep)
      } else {
        this.write(tail, cls)
      }
      return
    }
  }

  /** 串口读寄存器：状态与数据 */
  readPort(port: number): number {
    if (port === TTY_STATUS) return this.status()
    if (port === TTY_DATA) return this.data()
    return 0
  }

  /** 串口状态寄存器 */
  status(): number {
    this.loadPacket()
    if (this.inputPacket === undefined) return 0
    if (this.inputPacket === null) return 2
    if (this.inputPacket.length === 0) return 3
    // 4 = 本行只剩最后一个字节。读端凭它在行边界停住，一次 read 只拿一行，
    // 否则排队里的多行会被拼成一条超长命令。
    return this.inputOffset === this.inputPacket.length - 1 ? 4 : 1
  }

  /** 串口数据寄存器 */
  data(): number {
    this.loadPacket()
    if (this.inputPacket === undefined) return 0
    if (this.inputPacket === null || this.inputPacket.length === 0) {
      this.inputPacket = undefined
      this.inputOffset = 0
      return 0
    }
    const value = this.inputPacket[this.inputOffset++]
    if (this.inputOffset >= this.inputPacket.length) {
      this.inputPacket = undefined
      this.inputOffset = 0
    }
    return value
  }

  private loadPacket() {
    if (this.inputPacket !== undefined || !this.lineQueue.length) return
    const line = this.lineQueue.shift()
    this.inputPacket = line === null || line === undefined ? null : UTF8_ENCODER.encode(line)
    this.inputOffset = 0
  }

  // ---------- 键盘 ----------

  /** 还排着输入吗（没被读端取走） */
  get hasInput(): boolean {
    return this.lineQueue.length > 0 || this.inputPacket !== undefined
  }

  get irqPending(): boolean {
    return this.irqLine
  }

  takeIrq(): boolean {
    const raised = this.irqLine
    this.irqLine = false
    return raised
  }

  /** 输入还没被读走、读端却睡着了：把中断线重新拉起来（丢失唤醒补偿） */
  raiseIrq() {
    this.irqLine = true
  }

  /** 敲进一个可见字符 */
  key(ch: string) {
    // canonical tty 只接收可打印字符；Ctrl-C/D/L 走各自的入口。
    // 这样宿主浏览器产生的 DC1..DC4 等控制字节不会污染 argv 或文件。
    if (!ch || (ch.charCodeAt(0) < 0x20 && ch !== '\t')) return
    if (this.lineBuf.length < LINE_CAP) this.lineBuf += ch
    if (this.echoOn) this.write(ch, 'echo')
  }

  enter() {
    this.lineQueue.push(this.lineBuf)
    this.lineBuf = ''
    if (this.echoOn) this.write('\n', 'echo')
    this.irqLine = true
  }

  backspace() {
    if (!this.lineBuf) return
    this.lineBuf = this.lineBuf.slice(0, -1)
    if (this.echoOn) {
      const line = this.lines[this.lines.length - 1]
      const seg = line?.segs[line.segs.length - 1]
      if (seg) {
        seg.t = seg.t.slice(0, -1)
        if (!seg.t) line.segs.pop()
      }
    }
  }

  /** Ctrl-D：把没提交的一行交出去，再给一个 EOF */
  eof() {
    if (this.lineBuf) {
      this.lineQueue.push(this.lineBuf)
      this.lineBuf = ''
    }
    this.lineQueue.push(null)
    if (this.echoOn) this.write('\n', 'echo')
    this.irqLine = true
  }

  /** Ctrl-C 打断的是当前行，之后要不要发信号由操作系统决定 */
  discardLine() {
    this.lineBuf = ''
  }

  /** 空行：读端从 read 返回，shell 得以重画提示符 */
  pushEmptyLine() {
    this.lineQueue.push('')
    this.irqLine = true
  }
}
