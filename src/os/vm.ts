// 用户态 CPU：取指 → 译码 → 执行，取指经页表翻译访问真实物理内存
// 每次被内核唤醒执行若干条指令，遇到 sys 指令即陷入内核（与原生程序同一 ABI）

import { OP, REGS, WORD } from './isa'
import { sys } from './types'
import type { Gen, Syscall } from './types'

// 一个宿主调度周期内执行足够多的 Guest 指令，使中断处理程序可以在下一次
// 20Hz timer 到达前完成。原来的 8 条会让数百条指令的 timer handler 永远
// 追不上硬件时钟，形成 interrupt storm，用户态完全饥饿。
export const INSTR_PER_SLICE = 2048

export interface Bus {
  read(va: number): number
  write(va: number, byte: number): void
  readUser(va: number): number
  writeUser(va: number, byte: number): void
  limit: number
}

export class Fault extends Error {
  constructor(va: number, kind: string) {
    super(`${kind} at virtual address 0x${(va & 0xffff).toString(16).padStart(4, '0')}`)
  }
}

export interface CpuState {
  regs: RegisterFile
  pc: number
  sp: number
  flag: number
  halted: boolean
  mode: CpuMode
  irqEnabled: boolean
  pendingIrq: number
  cause: number
  ivtBase: number
  ksp: number
  usp: number
}

export type CpuMode = 'user' | 'kernel'

// The guest kernel uses compact vector numbers so its IVT fits in one page.
export const VECTOR_SYSCALL = 0
export const VECTOR_TIMER = 1
export const VECTOR_FAULT = 2
export const VECTOR_TTY = 3
export const NO_IRQ = 0xffff
const UTF8_ENCODER = new TextEncoder()

// 实现可以是 Uint16Array，也可以是 PCB 物理内存上的数字属性访问器。
export interface RegisterFile {
  [index: number]: number
}

const isErrVal = (v: unknown): boolean => typeof v === 'object' && v !== null && 'err' in v

const putBytes = (bus: Bus, va: number, bytes: Uint8Array, max: number): number => {
  const n = Math.min(bytes.length, max > 0 ? max : bytes.length)
  for (let i = 0; i < n; i++) bus.writeUser(va + i, bytes[i])
  if (va + n < bus.limit) bus.writeUser(va + n, 0)
  return n
}

const putStr = (bus: Bus, va: number, text: string, max: number): number =>
  putBytes(bus, va, UTF8_ENCODER.encode(text), max)

// Host services only. User syscalls are handled by the CRX kernel; svc from
// supervisor mode is how that kernel asks for a CPU, a reap, or a toolchain.
function trap(cpu: CpuState, bus: Bus): Syscall | null {
  const num = cpu.regs[0]
  const a1 = cpu.regs[1]
  const a2 = cpu.regs[2]
  switch (num) {
    case 3:
      return sys.exit(a1)
    case 22:
      return sys.kill(a1, a2 || 15)
    case 40:
      return { call: 'hwexec', at: a1 }
    case 41:
      return { call: 'hwreap', pid: a1 }
    case 42:
      return { call: 'hwmount' }
    case 44:
      return {
        call: 'hwassemble',
        srcDev: bus.read(a1),
        srcIno: bus.read(a1 + 1),
        dstDev: bus.read(a1 + 2),
        dstIno: bus.read(a1 + 3),
      }
    case 45:
      return { call: 'hwdisasm', at: a1 }
    default:
      return null
  }
}

export function* runExe(cpu: CpuState, bus: Bus, onRetire?: (count: number) => void): Gen {
  let retired = 0
  const report = () => {
    if (!retired) return
    onRetire?.(retired)
    retired = 0
  }
  const fetch = (at: number) => [bus.read(at), bus.read(at + 1), bus.read(at + 2), bus.read(at + 3)]
  const push = (v: number) => {
    cpu.sp -= 2
    bus.write(cpu.sp, (v >> 8) & 0xff)
    bus.write(cpu.sp + 1, v & 0xff)
  }
  const pop = (): number => {
    const v = (bus.read(cpu.sp) << 8) | bus.read(cpu.sp + 1)
    cpu.sp += 2
    return v
  }
  const wrap = (v: number) => ((v % 0x10000) + 0x10000) % 0x10000

  const requireKernel = (op: string) => {
    if (cpu.mode !== 'kernel') throw new Fault(cpu.pc - WORD, `${op} privilege fault`)
  }

  const packFlags = () => ((cpu.flag + 1) & 0x3) | (cpu.irqEnabled ? 0x4 : 0)
  const restoreFlags = (bits: number) => {
    cpu.flag = (bits & 0x3) - 1
    cpu.irqEnabled = (bits & 0x4) !== 0
  }

  // Hardware interrupt entry: save user SP/PC/FLAGS and all general registers
  // on the supervisor stack, then fetch the handler address from the IVT.
  const enterInterrupt = (vector: number) => {
    if (cpu.mode !== 'user') return
    const userSp = cpu.sp
    const returnPc = cpu.pc
    const flags = packFlags()
    cpu.usp = userSp
    cpu.mode = 'kernel'
    cpu.irqEnabled = false
    cpu.cause = vector
    cpu.sp = cpu.ksp
    push(userSp)
    push(returnPc)
    push(flags)
    for (let i = 0; i < REGS; i++) push(cpu.regs[i])
    cpu.ksp = cpu.sp
    const at = cpu.ivtBase + vector * 2
    // The loader patches IVT entries to absolute supervisor virtual addresses.
    cpu.pc = (bus.read(at) << 8) | bus.read(at + 1)
  }

  const finishService = (call: Syscall, ret: unknown) => {
    if (call.call === 'read') {
      cpu.regs[0] =
        ret === null
          ? 0xffff
          : ret && typeof ret === 'object' && 'bytes' in ret
            ? putBytes(bus, cpu.regs[2], (ret as any).bytes, cpu.regs[3])
            : putStr(bus, cpu.regs[2], String(ret), cpu.regs[3])
    } else if (call.call === 'getcwd' || call.call === 'getenv') {
      const buf = call.call === 'getcwd' ? cpu.regs[1] : cpu.regs[2]
      cpu.regs[0] = isErrVal(ret) ? 0xffff : putStr(bus, buf, String(ret), 0)
    } else if (call.call === 'time') {
      cpu.regs[0] = ret && typeof ret === 'object' ? wrap((ret as any).hz) : 20
    } else if (call.call === 'view') {
      cpu.regs[0] = isErrVal(ret) ? 0xffff : putStr(bus, cpu.regs[3], String(ret), 1200)
    } else if (isErrVal(ret)) cpu.regs[0] = 0xffff
    else if (typeof ret === 'number') cpu.regs[0] = wrap(ret)
    else if (ret && typeof ret === 'object' && 'pid' in ret) {
      cpu.regs[0] = wrap((ret as any).pid)
      cpu.regs[1] = wrap((ret as any).code)
    }
  }

  while (!cpu.halted) {
    for (let n = 0; n < INSTR_PER_SLICE && !cpu.halted; n++) {
      if (cpu.mode === 'user' && cpu.irqEnabled && cpu.pendingIrq !== NO_IRQ) {
        const vector = cpu.pendingIrq
        cpu.pendingIrq = NO_IRQ
        enterInterrupt(vector)
      }
      if (cpu.pc < 0 || cpu.pc + WORD > bus.limit) throw new Fault(cpu.pc, 'instruction fetch fault')
      const [op, rr, hi, lo] = fetch(cpu.pc)
      const d = (rr >> 4) & 0xf
      const s = rr & 0xf
      const imm = (hi << 8) | lo
      if (d >= REGS || s >= REGS) throw new Fault(cpu.pc, 'invalid register operand')
      cpu.pc += WORD
      retired++

      switch (op) {
        case OP.NOP:
          break
        case OP.MOVI:
          cpu.regs[d] = imm
          break
        case OP.MOVR:
          cpu.regs[d] = cpu.regs[s]
          break
        case OP.ADDI:
          cpu.regs[d] = wrap(cpu.regs[d] + imm)
          break
        case OP.ADDR:
          cpu.regs[d] = wrap(cpu.regs[d] + cpu.regs[s])
          break
        case OP.SUBI:
          cpu.regs[d] = wrap(cpu.regs[d] - imm)
          break
        case OP.SUBR:
          cpu.regs[d] = wrap(cpu.regs[d] - cpu.regs[s])
          break
        case OP.MULI:
          cpu.regs[d] = wrap(cpu.regs[d] * imm)
          break
        case OP.MULR:
          cpu.regs[d] = wrap(cpu.regs[d] * cpu.regs[s])
          break
        case OP.DIVI:
        case OP.DIVR: {
          const div = op === OP.DIVI ? imm : cpu.regs[s]
          if (div === 0) throw new Fault(cpu.pc - WORD, 'divide by zero')
          cpu.regs[d] = Math.floor(cpu.regs[d] / div)
          break
        }
        case OP.MODI:
        case OP.MODR: {
          const div = op === OP.MODI ? imm : cpu.regs[s]
          if (div === 0) throw new Fault(cpu.pc - WORD, 'divide by zero')
          cpu.regs[d] = cpu.regs[d] % div
          break
        }
        case OP.CMPI:
          cpu.flag = Math.sign(cpu.regs[d] - imm)
          break
        case OP.CMPR:
          cpu.flag = Math.sign(cpu.regs[d] - cpu.regs[s])
          break
        case OP.ANDI:
          cpu.regs[d] = cpu.regs[d] & imm
          break
        case OP.ANDR:
          cpu.regs[d] = cpu.regs[d] & cpu.regs[s]
          break
        case OP.ORI:
          cpu.regs[d] = cpu.regs[d] | imm
          break
        case OP.ORR:
          cpu.regs[d] = cpu.regs[d] | cpu.regs[s]
          break
        case OP.XORI:
          cpu.regs[d] = cpu.regs[d] ^ imm
          break
        case OP.XORR:
          cpu.regs[d] = cpu.regs[d] ^ cpu.regs[s]
          break
        case OP.SHLI:
          cpu.regs[d] = wrap(cpu.regs[d] << (imm & 0xf))
          break
        case OP.SHLR:
          cpu.regs[d] = wrap(cpu.regs[d] << (cpu.regs[s] & 0xf))
          break
        case OP.SHRI:
          cpu.regs[d] = cpu.regs[d] >>> (imm & 0xf)
          break
        case OP.SHRR:
          cpu.regs[d] = cpu.regs[d] >>> (cpu.regs[s] & 0xf)
          break
        case OP.JMP:
          cpu.pc = imm
          break
        case OP.JE:
          if (cpu.flag === 0) cpu.pc = imm
          break
        case OP.JNE:
          if (cpu.flag !== 0) cpu.pc = imm
          break
        case OP.JLT:
          if (cpu.flag < 0) cpu.pc = imm
          break
        case OP.JGT:
          if (cpu.flag > 0) cpu.pc = imm
          break
        case OP.LDB:
          cpu.regs[d] = bus.read(wrap(cpu.regs[s] + imm))
          break
        case OP.STB:
          bus.write(wrap(cpu.regs[d] + imm), cpu.regs[s] & 0xff)
          break
        case OP.LDW: {
          const at = wrap(cpu.regs[s] + imm)
          cpu.regs[d] = (bus.read(at) << 8) | bus.read(at + 1)
          break
        }
        case OP.STW: {
          const at = wrap(cpu.regs[d] + imm)
          bus.write(at, (cpu.regs[s] >> 8) & 0xff)
          bus.write(at + 1, cpu.regs[s] & 0xff)
          break
        }
        case OP.ULDB:
          requireKernel('uldb')
          cpu.regs[d] = bus.readUser(wrap(cpu.regs[s] + imm))
          break
        case OP.USTB:
          requireKernel('ustb')
          bus.writeUser(wrap(cpu.regs[d] + imm), cpu.regs[s] & 0xff)
          break
        case OP.PUSH:
          push(cpu.regs[d])
          break
        case OP.PUSHI:
          push(imm)
          break
        case OP.POP:
          cpu.regs[d] = pop()
          break
        case OP.CALL:
          push(cpu.pc)
          cpu.pc = imm
          break
        case OP.RET:
          cpu.pc = pop()
          break
        case OP.HLT:
          cpu.halted = true
          report()
          yield sys.exit(cpu.regs[1] ?? 0)
          return
        case OP.SYS:
          if (cpu.mode !== 'user') throw new Fault(cpu.pc - WORD, 'sys from kernel mode')
          enterInterrupt(VECTOR_SYSCALL)
          break
        case OP.SVC: {
          requireKernel('svc')
          const call = trap(cpu, bus)
          if (!call) throw new Fault(cpu.pc - WORD, `unknown system call ${cpu.regs[0]}`)
          report()
          const ret = yield call
          finishService(call, ret)
          break
        }
        case OP.IRET: {
          requireKernel('iret')
          // Syscalls return through r0/r1. Patch those two slots in the saved
          // user register frame before restoring it; IRQs restore all registers
          // unchanged.
          if (cpu.cause === VECTOR_SYSCALL) {
            bus.write(cpu.sp + 14, (cpu.regs[0] >> 8) & 0xff)
            bus.write(cpu.sp + 15, cpu.regs[0] & 0xff)
            bus.write(cpu.sp + 12, (cpu.regs[1] >> 8) & 0xff)
            bus.write(cpu.sp + 13, cpu.regs[1] & 0xff)
          }
          for (let i = REGS - 1; i >= 0; i--) cpu.regs[i] = pop()
          const flags = pop()
          const returnPc = pop()
          const userSp = pop()
          cpu.ksp = cpu.sp
          cpu.sp = userSp
          cpu.usp = userSp
          cpu.pc = returnPc
          restoreFlags(flags)
          cpu.mode = 'user'
          cpu.cause = 0
          break
        }
        case OP.CLI:
          requireKernel('cli')
          cpu.irqEnabled = false
          break
        case OP.STI:
          requireKernel('sti')
          cpu.irqEnabled = true
          break
        case OP.SCHED:
          requireKernel('sched')
          report()
          yield sys.yield()
          break
        default:
          throw new Fault(cpu.pc - WORD, `illegal opcode 0x${op.toString(16)}`)
      }
    }
    report()
    yield sys.yield()
  }
}
