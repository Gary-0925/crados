#!/usr/bin/env node
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = join(root, 'node_modules/.crados-smoke.mjs')

await build({
  entryPoints: [join(root, 'scripts/smoke-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  loader: { '.md': 'text' },
})

await import(outfile)
