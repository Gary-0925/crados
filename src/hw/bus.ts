// 虚拟硬件：总线、MMU 与块控制器。
//
// 访存的两条路径：
//   用户态 —— 经页表翻译（VPN → PFN），页表字节住在进程控制块里，由操作系统填写；
//   内核态 —— 物理直映，只有每进程的 supervisor 栈页例外（VPN 15 仍走页表）。
// 页表缓存只在页表字节被改写时才失效（写路径调用 isPageTableByte）。
//
// MMIO 窗口：
//   0xFF00..0xFF01  TTY 输出     → console
//   0xFF10..0xFF12  TTY 状态/数据/回显
//   0xFE00..0xFE09  块控制器寄存器（大端 u16：command, device, block, buffer, status）
//
// 块控制器只做 DMA（整块搬运），命令 1/2 的用户态原始块读写要过操作系统的授权
// 检查，命令 4/5 只服务内核自己的暂存区。盘上格式与权限语义都不是硬件的事。

import { Fault } from './cpu'
import { deviceName } from './disk'
import { PAGE_SIZE, RAM_SIZE } from './ram'
import type { Machine } from './machine'

/**
 * 操作系统交给 MMU 的地址空间视图。页表布局是操作系统的决定，
 * MMU 只负责按它取指、访存、按页翻译。
 */
export interface AddressSpace {
  /** 用户地址空间有几页（页表项条数） */
  readonly pteCount: number
  /** 用户地址空间上界（字节） */
  readonly limit: number
  /** 页表项：vpn → (pfn | supervisor<<15)，未映射返回 -1 */
  pteBits(vpn: number): number
  /** CPU 当前特权级：true = 内核态，访存走物理直映 */
  kernelMode(): boolean
  /** 这次写是否落在页表字节上：MMU 的翻译缓存必须作废 */
  isPageTableByte(pa: number): boolean
}

/** 16 位虚存空间 = 256 个 256 字节的页 */
const VPN_SLOTS = 0x10000 / PAGE_SIZE

export class Bus {
  // 每进程页表缓存：vpn → (pfn | supervisor<<15)，未映射为 -1。
  private readonly xlate = new Int32Array(VPN_SLOTS)
  private epoch = -1

  constructor(
    private readonly machine: Machine,
    private readonly space: AddressSpace,
  ) {}

  get limit(): number {
    return this.space.kernelMode() ? RAM_SIZE : this.space.limit
  }

  private syncXlate() {
    for (let vpn = 0; vpn < VPN_SLOTS; vpn++) {
      this.xlate[vpn] = vpn < this.space.pteCount ? this.space.pteBits(vpn) : -1
    }
    this.epoch = this.machine.mmuEpoch
  }

  /** 用户态访存：必须经过页表，supervisor 页不可触碰 */
  private userAddr(va: number): number {
    if (this.epoch !== this.machine.mmuEpoch) this.syncXlate()
    const raw = this.xlate[va >>> 8]
    if (raw < 0) throw new Fault(va, 'page fault')
    if (raw & 0x8000) throw new Fault(va, 'supervisor page fault')
    return ((raw & 0x7fff) << 8) + (va & 0xff)
  }

  /** 内核态访存：物理直映，只有已映射的 supervisor 页优先走页表 */
  private kernelAddr(va: number): number {
    if (this.epoch !== this.machine.mmuEpoch) this.syncXlate()
    const raw = this.xlate[va >>> 8]
    if (raw >= 0 && raw & 0x8000) return ((raw & 0x7fff) << 8) + (va & 0xff)
    if (va < RAM_SIZE) return va
    throw new Fault(va, 'kernel address fault')
  }

  private addr(va: number, forceUser: boolean): number {
    return forceUser || !this.space.kernelMode() ? this.userAddr(va) : this.kernelAddr(va)
  }

  private readMem(va: number, forceUser = false): number {
    return this.machine.ram.bytes[this.addr(va, forceUser)]
  }

  private writeMem(va: number, byte: number, forceUser = false) {
    const pa = this.addr(va, forceUser)
    this.machine.ram.bytes[pa] = byte & 0xff
    if (this.space.isPageTableByte(pa)) this.machine.invalidateMmu()
  }

  read(va: number): number {
    if (!this.space.kernelMode()) return this.machine.ram.bytes[this.userAddr(va)]
    if (va >= 0xff00) return this.machine.consolePortRead(va)
    const regs = this.machine.blockRegs
    if (va >= 0xfe00 && va < 0xfe00 + regs.length) return regs[va - 0xfe00]
    return this.machine.ram.bytes[this.kernelAddr(va)]
  }

  readUser(va: number): number {
    return this.machine.ram.bytes[this.userAddr(va)]
  }

  writeUser(va: number, byte: number) {
    const pa = this.userAddr(va)
    this.machine.ram.bytes[pa] = byte & 0xff
    if (this.space.isPageTableByte(pa)) this.machine.invalidateMmu()
  }

  write(va: number, byte: number) {
    if (!this.space.kernelMode()) {
      const pa = this.userAddr(va)
      this.machine.ram.bytes[pa] = byte & 0xff
      if (this.space.isPageTableByte(pa)) this.machine.invalidateMmu()
      return
    }
    const regs = this.machine.blockRegs
    if (va >= 0xfe00 && va < 0xfe00 + regs.length) {
      const off = va - 0xfe00
      regs[off] = byte & 0xff
      if (off === 1) this.runBlockCommand()
      return
    }
    if (va >= 0xff00) {
      this.machine.consolePortWrite(va, byte)
      return
    }
    this.writeMem(va, byte)
  }

  // ---------- 块控制器 ----------

  private reg16(off: number): number {
    const regs = this.machine.blockRegs
    return (regs[off] << 8) | regs[off + 1]
  }

  private setReg16(off: number, value: number) {
    const regs = this.machine.blockRegs
    regs[off] = (value >> 8) & 0xff
    regs[off + 1] = value & 0xff
  }

  private runBlockCommand() {
    const command = this.reg16(0)
    if (command === 3) {
      // sync：把每台设备的脏分块排进写队列。IndexedDB 的写入是异步的，
      // 这里返回的是"已经接管"，落盘结果由 storageOk 反映。
      const ok = this.machine.disks.flush()
      this.setReg16(8, ok ? 1 : 0xffff)
      return
    }
    const name = deviceName(this.reg16(2))
    const dev = name ? this.machine.disks.get(name) : undefined
    const block = this.reg16(4)
    const buffer = this.reg16(6)
    // 命令 1/2 是用户态 block_read/block_write。授权检查由操作系统给出，
    // 硬件自己不认识 uid——没有装载操作系统时一律拒绝，不能当成 root。
    if ((command === 1 || command === 2) && !this.machine.rawBlockIOAllowed()) {
      this.setReg16(8, 0xffff)
      return
    }
    // 命令 4/5 只服务内核自己的暂存区。用户可控的缓冲区不能从这里写进物理内存。
    if ((command === 4 || command === 5) && buffer !== this.machine.scratchBase) {
      this.setReg16(8, 0xffff)
      return
    }
    if (!dev || block >= dev.blockCount) {
      this.setReg16(8, 0xffff)
      return
    }
    try {
      const bytes = dev.block(block)
      if (bytes.length > this.machine.scratchSize) {
        this.setReg16(8, 0xffff)
        return
      }
      if (command === 1 || command === 4) {
        const forceUser = command === 1
        for (let i = 0; i < bytes.length; i++) this.writeMem(buffer + i, bytes[i], forceUser)
      } else if (command === 2 || command === 5) {
        const forceUser = command === 2
        for (let i = 0; i < bytes.length; i++) bytes[i] = this.readMem(buffer + i, forceUser)
        this.machine.disks.markDirty()
      } else {
        this.setReg16(8, 0xffff)
        return
      }
      this.setReg16(8, 1)
    } catch {
      this.setReg16(8, 0xffff)
    }
  }
}
