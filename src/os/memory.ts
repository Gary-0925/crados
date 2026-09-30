// 物理内存：一块真实的 64 KiB 字节数组，外加帧分配表
// 页表里的 pfn 就是这块数组的下标段，进程代码/参数是真的被写进去的
// 16 位地址刚好覆盖 256 帧。帧位图放在第 0 帧末尾，躲开 0x0050 起的驱动暂存。

export const PAGE_SIZE = 256
export const FRAME_COUNT = 256
export const FRAME_BITMAP = 0x00e0
// 0xFF00..0xFFFF 是 MMIO，内核文本不能伸进这扇窗口。
export const MMIO_BASE = 0xff00
export const KERNEL_TEXT_PAGES = 93   // ext2 层把内核撑大了：21 KiB 正文 + 数据
// Low physical memory stores KCB/PCBs/device scratch. The CRX kernel lives at
// the top of RAM, outside every 16-page user virtual address space.
//   frame 0     : KCB and the 32-byte frame bitmap
//   frame 1..12 : 16 PCBs
//   frame 13..15: spare
//   frame 16..19: device scratch = one ext2 block (1 KiB)   -> 0x1000..0x13FF
//   frame 20..23: host kmsg (u16 length, then text)         -> 0x1400..0x17FF
//   frame 24..25: host device catalog (8 x 64 B)            -> 0x1800..0x19FF
//   frame 26..161: user pages          frame 162..253: CRX kernel text
//   frame 254..255: MMIO gap
// 暂存区必须落在 VPN 16 以上：VPN 15 是每个进程的 supervisor 栈页，1 KiB 的块缓冲
// 一旦压上去，栈上的返回地址就会被块数据冲掉。
export const SCRATCH_FRAME = 16
export const SCRATCH_SIZE = 1024
export const KMSG_FRAME = SCRATCH_FRAME + SCRATCH_SIZE / PAGE_SIZE
export const KMSG_BASE = KMSG_FRAME * PAGE_SIZE
export const KMSG_SIZE = 4 * PAGE_SIZE
export const DEVINFO_FRAME = KMSG_FRAME + KMSG_SIZE / PAGE_SIZE
export const DEVINFO_BASE = DEVINFO_FRAME * PAGE_SIZE
export const DEVINFO_SLOTS = 8
export const DEVINFO_STRIDE = 64
export const RESERVED_FRAME = SCRATCH_FRAME
export const RESERVED_FRAMES = DEVINFO_FRAME + (DEVINFO_SLOTS * DEVINFO_STRIDE) / PAGE_SIZE - SCRATCH_FRAME
export const USER_FRAME_START = RESERVED_FRAME + RESERVED_FRAMES
export const KERNEL_TEXT_FRAME = MMIO_BASE / PAGE_SIZE - KERNEL_TEXT_PAGES - 1
export const RAM_SIZE = PAGE_SIZE * FRAME_COUNT
/** 块控制器每次搬运一个设备块，落在这个物理地址上 */
export const SCRATCH_BASE = SCRATCH_FRAME * PAGE_SIZE

const enc = new TextEncoder()

export class Memory {
  readonly bytes = new Uint8Array(RAM_SIZE)

  constructor() {
    for (let i = 0; i < FRAME_COUNT; i++) {
      const reserved = i >= RESERVED_FRAME && i < RESERVED_FRAME + RESERVED_FRAMES
      const kernel = i < USER_FRAME_START || i >= KERNEL_TEXT_FRAME || reserved
      this.setBitmapBit(i, kernel)
    }
  }

  private setBitmapBit(pfn: number, used: boolean) {
    if (pfn < 0 || pfn >= FRAME_COUNT) return
    const at = FRAME_BITMAP + (pfn >> 3)
    const mask = 1 << (pfn & 7)
    if (used) {
      this.bytes[at] |= mask
    } else {
      this.bytes[at] &= ~mask
    }
  }

  isAllocated(pfn: number): boolean {
    if (pfn < 0 || pfn >= FRAME_COUNT) return true
    const at = FRAME_BITMAP + (pfn >> 3)
    return (this.bytes[at] & (1 << (pfn & 7))) !== 0
  }

  alloc(count: number): number[] | null {
    const got: number[] = []
    for (let page = 0; page < count; page++) {
      let pfn = -1
      for (let candidate = USER_FRAME_START; candidate < KERNEL_TEXT_FRAME; candidate++) {
        if (!this.isAllocated(candidate)) {
          pfn = candidate
          break
        }
      }
      if (pfn < 0) {
        this.freeFrames(got)
        return null
      }
      this.setBitmapBit(pfn, true)
      this.zero(pfn)
      got.push(pfn)
    }
    return got
  }

  freeFrames(pfns: number[]) {
    for (const n of pfns) {
      this.setBitmapBit(n, false)
    }
  }

  hold(pfn: number) {
    this.setBitmapBit(pfn, true)
  }

  zero(pfn: number) {
    this.bytes.fill(0, pfn * PAGE_SIZE, (pfn + 1) * PAGE_SIZE)
  }

  writeBytesPages(pfns: number[], data: Uint8Array) {
    for (let i = 0; i < pfns.length; i++) {
      const chunk = data.subarray(i * PAGE_SIZE, (i + 1) * PAGE_SIZE)
      if (!chunk.length) break
      this.bytes.set(chunk, pfns[i] * PAGE_SIZE)
    }
  }

  writeAt(pa: number, text: string) {
    const data = enc.encode(text)
    this.bytes.set(data.subarray(0, Math.max(0, RAM_SIZE - pa)), pa)
  }

  u16(at: number): number {
    return (this.bytes[at] << 8) | this.bytes[at + 1]
  }
  setU16(at: number, v: number) {
    this.bytes[at] = (v >> 8) & 0xff
    this.bytes[at + 1] = v & 0xff
  }
  stats() {
    let used = 0
    for (let pfn = 0; pfn < FRAME_COUNT; pfn++) if (this.isAllocated(pfn)) used++
    return {
      total: RAM_SIZE,
      used: used * PAGE_SIZE,
      free: (FRAME_COUNT - used) * PAGE_SIZE,
      framesUsed: used,
    }
  }
}
