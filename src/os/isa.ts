// crados 指令集：定长 4 字节指令，8 个 16 位通用寄存器
// 编码 [opcode][dst<<4|src][imm_hi][imm_lo]
// 用户二进制与系统程序共享同一套系统调用 ABI

export const MAGIC = [0x7f, 0x43, 0x52, 0x58] // \x7fCRX
export const HEADER_SIZE = 16
export const WORD = 4
export const REGS = 8

export const OP = {
  NOP: 0x00,
  MOVI: 0x01,
  MOVR: 0x02,
  ADDI: 0x03,
  ADDR: 0x04,
  SUBI: 0x05,
  SUBR: 0x06,
  MULI: 0x07,
  MULR: 0x08,
  DIVI: 0x09,
  DIVR: 0x0a,
  MODI: 0x0b,
  MODR: 0x0c,
  CMPI: 0x0d,
  CMPR: 0x0e,
  JMP: 0x0f,
  JE: 0x10,
  JNE: 0x11,
  JLT: 0x12,
  JGT: 0x13,
  LDB: 0x14,
  STB: 0x15,
  PUSH: 0x16,
  POP: 0x17,
  CALL: 0x18,
  RET: 0x19,
  SYS: 0x1a,
  HLT: 0x1b,
  PUSHI: 0x1c,
  LDW: 0x1d,
  STW: 0x1e,
  // Privileged instructions. SYS is callable from user mode; it enters the
  // vector table. SVC performs the compatibility service only in kernel mode.
  IRET: 0x1f,
  SVC: 0x20,
  CLI: 0x21,
  STI: 0x22,
  // Bitwise arithmetic
  ANDI: 0x23,
  ANDR: 0x24,
  ORI: 0x25,
  ORR: 0x26,
  XORI: 0x27,
  XORR: 0x28,
  SHLI: 0x29,
  SHLR: 0x2a,
  SHRI: 0x2b,
  SHRR: 0x2c,
  SCHED: 0x2d,
  ULDB: 0x2e,
  USTB: 0x2f,
} as const

const MNEMONIC: Record<number, string> = Object.fromEntries(
  Object.entries(OP).map(([k, v]) => [v, k.toLowerCase()]),
)

// 助记符 → [立即数变体, 寄存器变体]
const ARITH: Record<string, [number, number]> = {
  mov: [OP.MOVI, OP.MOVR],
  add: [OP.ADDI, OP.ADDR],
  sub: [OP.SUBI, OP.SUBR],
  mul: [OP.MULI, OP.MULR],
  div: [OP.DIVI, OP.DIVR],
  mod: [OP.MODI, OP.MODR],
  cmp: [OP.CMPI, OP.CMPR],
  and: [OP.ANDI, OP.ANDR],
  or: [OP.ORI, OP.ORR],
  xor: [OP.XORI, OP.XORR],
  shl: [OP.SHLI, OP.SHLR],
  shr: [OP.SHRI, OP.SHRR],
}
const JUMPS: Record<string, number> = {
  jmp: OP.JMP,
  je: OP.JE,
  jne: OP.JNE,
  jlt: OP.JLT,
  jgt: OP.JGT,
  call: OP.CALL,
}

export interface AsmResult {
  bytes: Uint8Array
  textLen: number
  dataLen: number
  entry: number
  symbols: Record<string, number>
  // 需要随映像装载基址调整的 16 位字，偏移相对于去掉 CRX header 后的 image。
  relocations: number[]
  errors: string[]
}

const align4 = (n: number) => (n + 3) & ~3

interface Pending {
  line: number
  op: number
  d: number
  s: number
  imm: number | string
}

const isReg = (t: string) => /^r[0-7]$/.test(t)
const regNo = (t: string) => Number(t.slice(1))

function parseLiteral(tok: string): number | string {
  if (/^-?\d+$/.test(tok)) return Number(tok) & 0xffff
  if (/^0x[0-9a-f]+$/i.test(tok)) return parseInt(tok, 16) & 0xffff
  if (/^'.'$/.test(tok)) return tok.charCodeAt(1)
  return tok // 留作符号，第二趟解析
}

// 剥离行注释：引号内的分号属于字符串，不是注释起点
function stripComment(raw: string): string {
  let quote = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\' && quote) {
      i++
      continue
    }
    if (c === '"') quote = !quote
    else if (c === ';' && !quote) return raw.slice(0, i)
  }
  return raw
}

function splitOperands(rest: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote = false
  for (const c of rest) {
    if (c === '"') quote = !quote
    if (c === ',' && !quote) {
      out.push(cur.trim())
      cur = ''
    } else cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

export function assemble(source: string): AsmResult {
  const errors: string[] = []
  const symbols: Record<string, number> = {}
  const code: Pending[] = []
  const data: number[] = []
  const dataFixups: { at: number; label: string; line: number }[] = []
  const relocations: number[] = []
  let section: 'text' | 'data' = 'text'

  const lines = source.split('\n')
  lines.forEach((raw, idx) => {
    const line = stripComment(raw).trim()
    if (!line) return
    const lineNo = idx + 1

    const labelMatch = /^([A-Za-z_.][\w.]*):\s*(.*)$/.exec(line)
    let body = line
    if (labelMatch) {
      const [, label, rest] = labelMatch
      symbols[label] = section === 'text' ? code.length * WORD : -(data.length + 1) // 数据符号先记负值占位
      body = rest.trim()
      if (!body) return
    }

    const head = body.split(/\s+/)[0]
    const mnemonic = head.toLowerCase()
    // 保留操作数原文：.ascii "  " 里的连续空格不能被折叠
    const rest = body.slice(head.length).trim()
    const ops = splitOperands(rest)

    if (mnemonic === '.text' || mnemonic === '.data') {
      section = mnemonic === '.text' ? 'text' : 'data'
      return
    }
    if (mnemonic === '.asciz' || mnemonic === '.ascii') {
      const m = /"((?:[^"\\]|\\.)*)"/.exec(rest)
      if (!m) {
        errors.push(`${lineNo}: expected quoted string`)
        return
      }
      const text = m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\0/g, '\0').replace(/\\\\/g, '\\')
      for (const ch of text) data.push(ch.charCodeAt(0) & 0xff)
      if (mnemonic === '.asciz') data.push(0)
      return
    }
    if (mnemonic === '.byte') {
      for (const o of ops) {
        const v = parseLiteral(o)
        if (typeof v === 'string') errors.push(`${lineNo}: undefined byte value ${o}`)
        else data.push(v & 0xff)
      }
      return
    }
    if (mnemonic === '.word') {
      for (const o of ops) {
        const v = parseLiteral(o)
        if (typeof v === 'string') {
          dataFixups.push({ at: data.length, label: o, line: lineNo })
          data.push(0, 0)
        } else data.push((v >> 8) & 0xff, v & 0xff)
      }
      return
    }
    if (mnemonic === '.space') {
      const n = Number(ops[0] ?? 0)
      for (let i = 0; i < n; i++) data.push(0)
      return
    }

    const emit = (op: number, d = 0, s = 0, imm: number | string = 0) =>
      code.push({ line: lineNo, op, d, s, imm })

    if (mnemonic in ARITH) {
      const [immOp, regOp] = ARITH[mnemonic]
      const [a, b] = ops
      if (!a || b === undefined || !isReg(a)) {
        errors.push(`${lineNo}: ${mnemonic} expects a register and an operand`)
        return
      }
      if (isReg(b)) emit(regOp, regNo(a), regNo(b))
      else emit(immOp, regNo(a), 0, parseLiteral(b))
      return
    }
    if (mnemonic in JUMPS) {
      if (!ops[0]) {
        errors.push(`${lineNo}: ${mnemonic} expects a target`)
        return
      }
      emit(JUMPS[mnemonic], 0, 0, parseLiteral(ops[0]))
      return
    }
    if (
      mnemonic === 'ldb' || mnemonic === 'stb' || mnemonic === 'ldw' || mnemonic === 'stw' ||
      mnemonic === 'uldb' || mnemonic === 'ustb'
    ) {
      const mem = ops.find((o) => o.includes('['))
      const reg = ops.find((o) => !o.includes('['))
      const m = mem ? /\[\s*(r[0-7])\s*(?:\+\s*([\w'x]+))?\s*\]/.exec(mem) : null
      if (!m || !reg || !isReg(reg)) {
        errors.push(`${lineNo}: ${mnemonic} expects a register and [rB+off]`)
        return
      }
      const off = m[2] ? parseLiteral(m[2]) : 0
      if (mnemonic === 'ldb') emit(OP.LDB, regNo(reg), regNo(m[1]), off)
      else if (mnemonic === 'uldb') emit(OP.ULDB, regNo(reg), regNo(m[1]), off)
      else if (mnemonic === 'ustb') emit(OP.USTB, regNo(m[1]), regNo(reg), off)
      else if (mnemonic === 'ldw') emit(OP.LDW, regNo(reg), regNo(m[1]), off)
      else if (mnemonic === 'stw') emit(OP.STW, regNo(m[1]), regNo(reg), off)
      else emit(OP.STB, regNo(m[1]), regNo(reg), off)
      return
    }
    if (mnemonic === 'push') {
      const a = ops[0] ?? ''
      if (isReg(a)) emit(OP.PUSH, regNo(a))
      else emit(OP.PUSHI, 0, 0, parseLiteral(a))
      return
    }
    if (mnemonic === 'pop') {
      if (!isReg(ops[0] ?? '')) {
        errors.push(`${lineNo}: pop expects a register`)
        return
      }
      emit(OP.POP, regNo(ops[0]))
      return
    }
    if (mnemonic === 'ret') return void emit(OP.RET)
    if (mnemonic === 'sys') return void emit(OP.SYS)
    if (mnemonic === 'iret') return void emit(OP.IRET)
    if (mnemonic === 'svc') return void emit(OP.SVC)
    if (mnemonic === 'cli') return void emit(OP.CLI)
    if (mnemonic === 'sti') return void emit(OP.STI)
    if (mnemonic === 'sched') return void emit(OP.SCHED)
    if (mnemonic === 'hlt') return void emit(OP.HLT)
    if (mnemonic === 'nop') return void emit(OP.NOP)

    errors.push(`${lineNo}: unknown mnemonic '${mnemonic}'`)
  })

  // 第二趟：确定数据段基址并回填符号
  const textLen = code.length * WORD
  const dataBase = align4(textLen)
  for (const [name, value] of Object.entries(symbols))
    if (value < 0) symbols[name] = dataBase + (-value - 1)

  for (const f of dataFixups) {
    const target = symbols[f.label]
    if (target === undefined) {
      errors.push(`${f.line}: undefined symbol '${f.label}'`)
      continue
    }
    data[f.at] = (target >> 8) & 0xff
    data[f.at + 1] = target & 0xff
    relocations.push(dataBase + f.at)
  }

  const text = new Uint8Array(dataBase)
  code.forEach((c, i) => {
    const at = i * WORD
    let imm = c.imm
    if (typeof imm === 'string') {
      const target = symbols[imm]
      if (target === undefined) {
        errors.push(`${c.line}: undefined symbol '${imm}'`)
        imm = 0
      } else imm = target
      relocations.push(at + 2)
    }
    text[at] = c.op
    text[at + 1] = ((c.d & 0xf) << 4) | (c.s & 0xf)
    text[at + 2] = (imm >> 8) & 0xff
    text[at + 3] = imm & 0xff
  })

  const entry = symbols['_start'] ?? 0
  const bytes = new Uint8Array(HEADER_SIZE + text.length + data.length)
  bytes.set(MAGIC, 0)
  bytes[4] = 1
  bytes[6] = (textLen >> 8) & 0xff
  bytes[7] = textLen & 0xff
  bytes[8] = (data.length >> 8) & 0xff
  bytes[9] = data.length & 0xff
  bytes[10] = (entry >> 8) & 0xff
  bytes[11] = entry & 0xff
  bytes.set(text, HEADER_SIZE)
  bytes.set(Uint8Array.from(data), HEADER_SIZE + text.length)

  return { bytes, textLen, dataLen: data.length, entry, symbols, relocations, errors }
}

export function isExecutable(data: string): boolean {
  return MAGIC.every((b, i) => data.charCodeAt(i) === b)
}

export interface ExeHeader {
  textLen: number
  dataLen: number
  entry: number
  image: Uint8Array
}

export function loadExe(data: string): ExeHeader | null {
  if (!isExecutable(data)) return null
  const raw = Uint8Array.from([...data].map((c) => c.charCodeAt(0) & 0xff))
  const textLen = (raw[6] << 8) | raw[7]
  const dataLen = (raw[8] << 8) | raw[9]
  const entry = (raw[10] << 8) | raw[11]
  return { textLen, dataLen, entry, image: raw.subarray(HEADER_SIZE) }
}

export function disassemble(image: Uint8Array, textLen: number, limit = 64): string[] {
  const out: string[] = []
  const reg = (n: number) => `r${n}`
  for (let at = 0; at < Math.min(textLen, limit * WORD); at += WORD) {
    const op = image[at]
    const d = (image[at + 1] >> 4) & 0xf
    const s = image[at + 1] & 0xf
    const imm = (image[at + 2] << 8) | image[at + 3]
    const name = MNEMONIC[op] ?? '.byte'
    let text: string
    switch (op) {
      case OP.MOVI: case OP.ADDI: case OP.SUBI: case OP.MULI: case OP.DIVI: case OP.MODI: case OP.CMPI:
      case OP.ANDI: case OP.ORI: case OP.XORI: case OP.SHLI: case OP.SHRI:
        text = `${name.replace(/i$/, '')} ${reg(d)}, ${imm}`
        break
      case OP.MOVR: case OP.ADDR: case OP.SUBR: case OP.MULR: case OP.DIVR: case OP.MODR: case OP.CMPR:
      case OP.ANDR: case OP.ORR: case OP.XORR: case OP.SHLR: case OP.SHRR:
        text = `${name.replace(/r$/, '')} ${reg(d)}, ${reg(s)}`
        break
      case OP.JMP: case OP.JE: case OP.JNE: case OP.JLT: case OP.JGT: case OP.CALL:
        text = `${name} 0x${imm.toString(16).padStart(4, '0')}`
        break
      case OP.LDB:
        text = `ldb ${reg(d)}, [${reg(s)}+${imm}]`
        break
      case OP.STB:
        text = `stb [${reg(d)}+${imm}], ${reg(s)}`
        break
      case OP.LDW:
        text = `ldw ${reg(d)}, [${reg(s)}+${imm}]`
        break
      case OP.STW:
        text = `stw [${reg(d)}+${imm}], ${reg(s)}`
        break
      case OP.ULDB:
        text = `uldb ${reg(d)}, [${reg(s)}+${imm}]`
        break
      case OP.USTB:
        text = `ustb [${reg(d)}+${imm}], ${reg(s)}`
        break
      case OP.PUSH:
        text = `push ${reg(d)}`
        break
      case OP.PUSHI:
        text = `push ${imm}`
        break
      case OP.POP:
        text = `pop ${reg(d)}`
        break
      default:
        text = name
    }
    out.push(`${at.toString(16).padStart(4, '0')}  ${[...image.subarray(at, at + WORD)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')}  ${text}`)
  }
  return out
}
