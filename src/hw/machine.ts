// 虚拟硬件：这台机器本身。
//
// 机器 = 主存 + 盘位 + 控制台 + 硬件时钟 + 块控制器 + 总线。它单独就能存在：
// 上电、插盘、敲键盘、接时钟，全都不需要上面跑着什么操作系统。操作系统是后来
// 装载进来的软件（MachineSoftware），机器只在两件事上找它：
//   - 每个时钟周期该推进什么（clockEdge）
//   - 用户态原始块读写要不要放行（rawBlockIOAllowed）
//
// 机器不认识文件、进程、权限，也不认识 syscall 号段——那些都在 os/ 里。

import { DiskBay } from './bay'
import { Bus } from './bus'
import type { AddressSpace } from './bus'
import { Console } from './console'
import { Memory, SCRATCH_BASE, SCRATCH_SIZE } from './ram'

/** 装载在这台机器上的操作系统：机器只通过这几个口子找它 */
export interface MachineSoftware {
  /**
   * 一个时钟周期：取指、陷入、调度由操作系统推进。
   * 不限速模式（turbo）下机器会把相邻的几个时钟周期合并成一次 burst 调用，
   * 是否合并、怎么合并由操作系统决定。
   */
  clockEdge(burst: boolean): void
  /** 时钟周期里抛出的异常：交给操作系统处置（通常是 panic） */
  clockFailed(error: unknown): void
  /** 用户态原始块读写（块控制器命令 1/2）是否放行 */
  rawBlockIOAllowed(): boolean
}

export class Machine {
  readonly ram = new Memory()
  readonly disks = new DiskBay()
  readonly console = new Console()
  /** 块控制器寄存器（大端 u16：command, device, block, buffer, status） */
  readonly blockRegs = new Uint8Array(10)
  /** 内核暂存区：块控制器命令 4/5 唯一的合法缓冲区 */
  readonly scratchBase = SCRATCH_BASE
  readonly scratchSize = SCRATCH_SIZE

  /** 硬件时钟频率与运行方式 */
  hz = 20
  turbo = false
  paused = false

  private software: MachineSoftware | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private nextTimerIrq = 0
  /** MMU 翻译缓存的纪元：页表字节被改写就递增 */
  private mmuGeneration = 0

  // ---------- 装载操作系统 ----------

  attachSoftware(software: MachineSoftware) {
    this.software = software
  }

  /** 接上时钟：机器开始产生定时器中断 */
  startClock() {
    if (this.timer) clearInterval(this.timer)
    this.nextTimerIrq = performance.now() + 1000 / this.hz
    this.timer = setInterval(
      () => {
        const os = this.software
        if (!os || this.paused) return
        try {
          os.clockEdge(this.turbo)
        } catch (e) {
          os.clockFailed(e)
        }
      },
      this.turbo ? 0 : 1000 / this.hz,
    )
  }

  stopClock() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * 硬件定时器中断：按真实单调时间产生，与 CPU 快慢无关。
   * 返回自上次询问以来是否发生过一次（可能被 Turbo 模式跳过若干次）。
   */
  pollTimerInterrupt(): boolean {
    if (this.turbo) return true
    const now = performance.now()
    if (now < this.nextTimerIrq) return false
    const period = 1000 / this.hz
    do this.nextTimerIrq += period
    while (this.nextTimerIrq <= now)
    return true
  }

  /** 前端面板上的频率旋钮：改的是硬件时钟 */
  setSpeed(v: number | 'max') {
    this.turbo = v === 'max'
    if (typeof v === 'number') this.hz = v
    this.nextTimerIrq = performance.now() + 1000 / this.hz
    this.startClock()
  }

  setPaused(paused: boolean) {
    this.paused = paused
  }

  // ---------- 总线 ----------

  /** 给一个地址空间装一条总线：CPU 取指访存走它，MMIO 也在它上面译码 */
  busFor(space: AddressSpace): Bus {
    return new Bus(this, space)
  }

  get mmuEpoch(): number {
    return this.mmuGeneration
  }

  invalidateMmu() {
    this.mmuGeneration++
  }

  rawBlockIOAllowed(): boolean {
    return this.software?.rawBlockIOAllowed() ?? false
  }

  // ---------- 控制台 MMIO ----------

  consolePortRead(port: number): number {
    return this.console.readPort(port)
  }

  consolePortWrite(port: number, byte: number) {
    this.console.writePort(port, byte)
  }
}
