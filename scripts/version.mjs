#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const versionFile = join(root, 'src/utils/config.ts')
const packageFile = join(root, 'package.json')
const lockFile = join(root, 'package-lock.json')
const readmeFile = join(root, 'README.md')

const readVersion = () => {
  const src = readFileSync(versionFile, 'utf8')
  const m = /^export const OS_VERSION = '([^']+)'$/m.exec(src)
  if (!m) {
    console.error(`setversion: cannot find OS_VERSION in ${versionFile}`)
    process.exit(1)
  }
  return m[1]
}

const writeVersion = (v) => {
  const src = readFileSync(versionFile, 'utf8')
  writeFileSync(versionFile, src.replace(/^(export const OS_VERSION = ')[^']+(')$/m, `$1${v}$2`))
}

const updatePackage = (v) => {
  for (const file of [packageFile, lockFile]) {
    const json = JSON.parse(readFileSync(file, 'utf8'))
    let changed = false
    if (json.version !== undefined && json.version !== v) {
      json.version = v
      changed = true
    }
    if (json.packages?.['']?.version !== undefined && json.packages[''].version !== v) {
      json.packages[''].version = v
      changed = true
    }
    if (changed) writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
  }
}

const updateReadme = (v) => {
  const src = readFileSync(readmeFile, 'utf8')
  if (!/^## crados [\w.]+ \(Cradle OS\)/m.test(src)) {
    console.error(`setversion: cannot find "## crados x.y (Cradle OS)" heading in README.md`)
    process.exit(1)
  }
  writeFileSync(readmeFile, src.replace(/^(## crados )[\w.]+( \(Cradle OS\))/m, `$1${v}$2`))
}

const scanStrayLiterals = (v) => {
  const stray = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(ts|tsx)$/.test(name)) continue
      const text = readFileSync(p, 'utf8')
      const re = new RegExp(`crados (?!${v.replace('.', '\\.')})\\d[\\w.]*`, 'g')
      for (const line of text.split('\n')) {
        const m = re.exec(line)
        if (m && !/config\.ts$/.test(p)) stray.push(`${p}: ${line.trim()}`)
        re.lastIndex = 0
      }
    }
  }
  walk(join(root, 'src'))
  return stray
}

const arg = process.argv[2]
if (arg) {
  if (!/^[\w.]+$/.test(arg)) {
    console.error(`setversion: "${arg}" does not look like a version number`)
    process.exit(1)
  }
  writeVersion(arg)
  updatePackage(arg)
  updateReadme(arg)
  console.log(`setversion: now at ${arg}`)
}

const current = readVersion()
const pkg = JSON.parse(readFileSync(packageFile, 'utf8'))
const problems = []
if (pkg.version !== current) problems.push(`package.json version ${pkg.version} != ${current}`)
const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
if (lock.version !== current) problems.push(`package-lock.json version ${lock.version} != ${current}`)
if (lock.packages?.['']?.version !== current)
  problems.push(`package-lock.json packages[""].version ${lock.packages?.['']?.version} != ${current}`)
const readme = readFileSync(readmeFile, 'utf8')
if (!readme.startsWith(`## crados ${current} (Cradle OS)`))
  problems.push(`README.md heading does not say crados ${current}`)
for (const s of scanStrayLiterals(current)) problems.push(`stale version literal in ${s}`)

if (problems.length) {
  for (const p of problems) console.error(`setversion: ${p}`)
  process.exit(1)
}
console.log(`setversion: all consistent at ${current}`)
