// persist-check 的运行器：scripts/persist-check.ts 依赖 `?raw` 手册导入与 `@/`
// 路径别名，Node 不能直接跑，所以先用 esbuild 打成单文件，再在当前进程里 import 它。
//
//   npm run persist
//
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// 把 `./man/asm.zh?raw` 这类导入变成纯文本模块
const rawText = {
  name: 'raw-text',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => {
      const target = args.path.replace(/\?raw$/, '')
      const abs = target.startsWith('/') ? target : path.resolve(args.resolveDir, target)
      return { path: abs, namespace: 'raw' }
    })
    b.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({
      contents: fs.readFileSync(args.path, 'utf8'),
      loader: 'text',
    }))
  },
}

const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crados-persist-')), 'persist-check.mjs')
await build({
  entryPoints: [path.join(root, 'scripts/persist-check.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'warning',
  plugins: [rawText],
  alias: { '@': path.join(root, 'src') },
})

try {
  await import(pathToFileURL(outfile).href)
} finally {
  fs.rmSync(path.dirname(outfile), { recursive: true, force: true })
}
