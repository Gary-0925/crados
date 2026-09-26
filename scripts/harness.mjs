// Node harness: load the kernel through vite (TS + ?raw transforms) and drive
// the console like a user would. Used by scripts/smoke.mjs.
import { createServer } from 'vite'
import { mkdirSync } from 'node:fs'

// localStorage stub for blockdev persistence
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => void store.clear(),
}

export async function loadKernelModule() {
  const server = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { middlewareMode: true },
    appType: 'custom',
  })
  const mod = await server.ssrLoadModule('/src/os/kernel.ts')
  return { server, mod }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function makeDriver(Kernel) {
  const kernel = new Kernel()
  const text = () => kernel.consoleLines().map((l) => l.segs.map((s) => s.t).join('')).join('\n')
  const type = (s) => {
    for (const ch of s) kernel.typeChar(ch)
  }
  const enter = (s) => {
    if (s !== undefined) type(s)
    kernel.pressEnter()
  }
  // Wait until `want` appears in the console or timeout.
  const waitFor = async (want, timeoutMs = 8000) => {
    const t0 = Date.now()
    for (;;) {
      const t = text()
      const ok = typeof want === 'function' ? want(t) : t.includes(want)
      if (ok) return t
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${JSON.stringify(want)}\n--- console ---\n${t.slice(-3000)}`)
      await sleep(25)
    }
  }
  return { kernel, text, type, enter, waitFor }
}

export function snapshotDir() {
  mkdirSync('tmp-test', { recursive: true })
}
