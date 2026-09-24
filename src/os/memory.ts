// 物理内存：一块真实的 16 KiB 字节数组，外加帧分配表
// 页表里的 pfn 就是这块数组的下标段，进程代码/参数是真的被写进去的

export const PAGE_SIZE = 256
export const FRAME_COUNT = 64
// frame 0: boot record; frame 1..16: 32 PCBs x 128 B; frame 17: tty/kmsg scratch
export const KERNEL_FRAMES = 18
export const RAM_SIZE = PAGE_SIZE * FRAME_COUNT

export type FrameOwner = number | 'kernel' | null

export interface Frame {
  no: number
  owner: FrameOwner
  seg: string
}

const enc = new TextEncoder()

export class Memory {
  readonly frames: Frame[] = []
  readonly bytes = new Uint8Array(RAM_SIZE)

  constructor() {
    for (let i = 0; i < FRAME_COUNT; i++) {
      const kernel = i < KERNEL_FRAMES
      this.frames.push({ no: i, owner: kernel ? 'kernel' : null, seg: kernel ? 'ktext' : '' })
    }
  }

  alloc(pid: number, segs: string[]): number[] | null {
    const got: number[] = []
    for (const seg of segs) {
      const f = this.frames.find((x) => x.owner === null)
      if (!f) {
        this.freeFrames(got)
        return null
      }
      f.owner = pid
      f.seg = seg
      this.zero(f.no) // 分配即清零，避免上一个进程的残留数据泄漏
      got.push(f.no)
    }
    return got
  }

  freeFrames(pfns: number[]) {
    for (const n of pfns) {
      this.frames[n].owner = null
      this.frames[n].seg = ''
    }
  }

  freePid(pid: number) {
    for (const f of this.frames) {
      if (f.owner === pid) {
        f.owner = null
        f.seg = ''
      }
    }
  }

  zero(pfn: number) {
    this.bytes.fill(0, pfn * PAGE_SIZE, (pfn + 1) * PAGE_SIZE)
  }

  // 把文本按字节写入若干连续页（超出部分截断，与真实加载器一致）
  writePages(pfns: number[], text: string) {
    const data = enc.encode(text)
    for (let i = 0; i < pfns.length; i++) {
      const chunk = data.subarray(i * PAGE_SIZE, (i + 1) * PAGE_SIZE)
      if (!chunk.length) break
      this.bytes.set(chunk, pfns[i] * PAGE_SIZE)
    }
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

  frameBytes(pfn: number): Uint8Array {
    return this.bytes.subarray(pfn * PAGE_SIZE, (pfn + 1) * PAGE_SIZE)
  }

  peek(pa: number, len: number): Uint8Array | null {
    if (pa < 0 || pa >= RAM_SIZE) return null
    return this.bytes.subarray(pa, Math.min(RAM_SIZE, pa + len))
  }

  stats() {
    let used = 0
    let byProc = 0
    for (const f of this.frames) {
      if (f.owner !== null) used++
      if (typeof f.owner === 'number') byProc++
    }
    return {
      total: RAM_SIZE,
      used: used * PAGE_SIZE,
      free: (FRAME_COUNT - used) * PAGE_SIZE,
      framesUsed: used,
      framesByProc: byProc,
    }
  }
}
