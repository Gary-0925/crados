// 虚拟硬件：用户态 CPU。取指 → 译码 → 执行，取指经页表翻译访问真实物理内存。
//
// CPU 只产生三种陷出（HwCall），不认识任何调用号的含义——号段是这台机器与操作
// 系统之间的约定，由 os/kernel.ts 解释：
//   yield  时间片让出（sched 指令，或一段指令执行完）
//   halt   hlt 指令：CPU 停机，r1 是退出码
//   svc    svc 指令：r0 = 调用号，r1..r3 = 参数
// 恢复执行时宿主把返回值交给生成器的 next()：数字写回 r0，错误对象写 0xFFFF。

import { OP, REGS, WORD } from '@/hw/isa'

// 一个宿主调度周期内执行足够多的 Guest 指令，使中断处理程序可以在下一次
// 20Hz timer 到达前完成。原来的 8 条会让数百条指令的 timer handler 永远
// 追不上硬件时钟，形成 interrupt storm，用户态完全饥饿。
export const INSTR_PER_SLICE = 2048

/** CPU 陷出：交给这台机器上跑着的软件（操作系统）处理 */
export type HwCall =
  | { call: 'yield' }
  | { call: 'halt'; code: number }
  | { call: 'svc'; num: number; a1: number; a2: number; a3: number }

/** 一个进程的执行载体：不断陷出、被操作系统唤醒的生成器 */
export type CpuProgram = Generator<HwCall, unknown, unknown>

/** CPU 眼中的总线：按用户地址空间读写内存，并给出能取指的上界 */
export interface MemoryBus {
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

// 中断向量是硬连线：syscall 走 0，定时器走 1，键盘/串口走 3，
// 这样 CRX 内核的中断向量表能装进一页。0xFFFF 表示"没有待处理中断"。
export const VECTOR_SYSCALL = 0
export const VECTOR_TIMER = 1
export const VECTOR_TTY = 3
export const NO_IRQ = 0xffff

// 实现可以是 Uint16Array，也可以是 PCB 物理内存上的数字属性访问器。
export interface RegisterFile {
  [index: number]: number
}

const isErrVal = (v: unknown): boolean => typeof v === 'object' && v !== null && 'err' in v

export function* runExe(cpu: CpuState, bus: MemoryBus, onRetire?: (count: number) => void): CpuProgram {
  let retired = 0
  const report = () => {
    if (!retired) return
    onRetire?.(retired)
    retired = 0
  }
  // 4 字节定长取指。原来每条指令都要分配一个 4 元素数组，改为复用外层变量：
  // 定长指令集里没有任何指令会重入 fetch，复用是安全的。
  let curOp = 0
  let curRr = 0
  let curHi = 0
  let curLo = 0
  const fetch = (at: number) => {
    curOp = bus.read(at)
    curRr = bus.read(at + 1)
    curHi = bus.read(at + 2)
    curLo = bus.read(at + 3)
  }
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
  // 16 位回绕。加减乘和左移的结果按位与 0xffff 与取模等价，但省掉两次除法
  const wrap = (v: number) => v & 0xffff

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

  // svc 的返回值由操作系统给出：数字进 r0，错误对象写 0xFFFF。
  const finishService = (ret: unknown) => {
    if (isErrVal(ret)) cpu.regs[0] = 0xffff
    else if (typeof ret === 'number') cpu.regs[0] = wrap(ret)
  }

  while (!cpu.halted) {
    for (let n = 0; n < INSTR_PER_SLICE && !cpu.halted; n++) {
      if (cpu.mode === 'user' && cpu.irqEnabled && cpu.pendingIrq !== NO_IRQ) {
        const vector = cpu.pendingIrq
        cpu.pendingIrq = NO_IRQ
        enterInterrupt(vector)
      }
      if (cpu.pc < 0 || cpu.pc + WORD > bus.limit) throw new Fault(cpu.pc, 'instruction fetch fault')
      fetch(cpu.pc)
      const op = curOp
      const d = (curRr >> 4) & 0xf
      const s = curRr & 0xf
      const imm = (curHi << 8) | curLo
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
        case OP.STB: {
          const st = wrap(cpu.regs[d] + imm)
          bus.write(st, cpu.regs[s] & 0xff)
          break
        }
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
        case OP.ULDB: {
          requireKernel('uldb')
          cpu.regs[d] = bus.readUser(wrap(cpu.regs[s] + imm))
          break
        }
        case OP.USTB: {
          requireKernel('ustb')
          bus.writeUser(wrap(cpu.regs[d] + imm), cpu.regs[s] & 0xff)
          break
        }
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
          yield { call: 'halt', code: cpu.regs[1] ?? 0 }
          return
        case OP.SYS:
          if (cpu.mode !== 'user') throw new Fault(cpu.pc - WORD, 'sys from kernel mode')
          enterInterrupt(VECTOR_SYSCALL)
          break
        case OP.SVC: {
          requireKernel('svc')
          report()
          // 号段与参数原样交给操作系统，CPU 不解释它们的含义
          const ret = yield { call: 'svc', num: cpu.regs[0], a1: cpu.regs[1], a2: cpu.regs[2], a3: cpu.regs[3] }
          finishService(ret)
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
          yield { call: 'yield' }
          break
        default:
          throw new Fault(cpu.pc - WORD, `illegal opcode 0x${op.toString(16)}`)
      }
    }
    report()
    yield { call: 'yield' }
  }
}
