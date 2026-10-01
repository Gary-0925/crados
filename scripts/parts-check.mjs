// 三部分边界的验收脚本：操作系统 / 虚拟硬件 / 透明化面板。
//
//   npm run parts
//
// 划分规则（读 import 图就能查）：
//   1. 虚拟硬件核心（hw/*，不含 hw/ui）不认识操作系统，也不认识面板：
//      操作系统是后来装载上去的软件，机器自己就能转。
//   2. 操作系统（os/*）不引用面板，也不引用机器的前端（hw/ui）：观测是外面的东西。
//   3. 面板（cp/*）只被透明版入口引用：纯净版把整个面板排除在打包之外。
//   4. 机器的前端与固件（hw/ui/*）不引用面板。
//
// 谁可以依赖谁：
//   hw/ui（显示器、键盘、上电菜单） → os 的启动入口与只读接口
//   os（操作系统）                  → hw 核心（装载在这台机器上）
//   cp（面板）                      → hw + os，只读观测
//   入口（src/Plain.tsx、src/Transparent.tsx）→ 装配以上部分
//
// 任何一条不满足都退出非零码，CI 用 npm run check 拦住。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'src')

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/** 把 import 的说明符解析成 src 下的相对路径 */
function resolve(fromFile, spec) {
  if (spec.startsWith('@/')) return path.posix.join('src', spec.slice(2))
  if (spec.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec))
  return null // 包依赖
}

function collect() {
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) files.push(full)
    }
  }
  walk(src)
  return files.map((full) => {
    const rel = path.posix.join('src', path.relative(src, full).split(path.sep).join('/'))
    const text = fs.readFileSync(full, 'utf8')
    const imports = []
    for (const m of text.matchAll(/(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*from\s*['"]([^'"]+)['"]/g)) {
      const target = resolve(rel, m[1])
      if (target) imports.push(target)
    }
    for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const target = resolve(rel, m[1])
      if (target) imports.push(target)
    }
    return { rel, imports }
  })
}

const files = collect()
const importsOf = (file) => files.find((f) => f.rel === file)?.imports ?? []
const hits = (file, pattern) => importsOf(file).filter((t) => pattern.test(t))

// ---------- 1. 虚拟硬件核心不认识操作系统与面板 ----------
for (const { rel, imports } of files) {
  if (!rel.startsWith('src/hw/') || rel.startsWith('src/hw/ui/')) continue
  const bad = imports.filter((t) => t.startsWith('src/os/') || t.startsWith('src/cp/'))
  check(`${rel} 不依赖 os 与 cp`, bad.length === 0, bad.join(', '))
}

// ---------- 2. 操作系统不引用面板与机器前端 ----------
for (const { rel, imports } of files) {
  if (!rel.startsWith('src/os/')) continue
  const bad = imports.filter((t) => t.startsWith('src/cp/') || t.startsWith('src/hw/ui/'))
  check(`${rel} 不依赖 cp 与 hw/ui`, bad.length === 0, bad.join(', '))
}

// ---------- 3. 面板只被透明版入口引用 ----------
// 装配层自己也成不了一部分：它只有两个入口文件，不属于 hw / os / cp 任何一支。
for (const { rel, imports } of files) {
  if (rel.startsWith('src/cp/')) continue
  const bad = imports.filter((t) => t.startsWith('src/cp/'))
  const allowed = rel === 'src/Transparent.tsx'
  check(`${rel} 不引用 cp${allowed ? '（入口除外）' : ''}`, bad.length === 0 || allowed, bad.join(', '))
}

// ---------- 4. 机器前端与固件不引用面板 ----------
for (const { rel, imports } of files) {
  if (!rel.startsWith('src/hw/ui/')) continue
  const bad = imports.filter((t) => t.startsWith('src/cp/'))
  check(`${rel} 不依赖 cp`, bad.length === 0, bad.join(', '))
}

// ---------- 5. 上电菜单是固件：操作系统还不存在就要能跑 ----------
check(
  '上电菜单不引用操作系统的装载入口',
  hits('src/hw/ui/BootMenu.tsx', /^src\/os\/kernel$/).length === 0,
  '菜单只问介质（@/hw/boot），不调 Kernel',
)

// ---------- 6. 纯净版入口不碰面板，透明版入口才装面板 ----------
check('纯净版入口不引用面板', hits('src/Plain.tsx', /^src\/cp\//).length === 0)
check('透明版入口装载面板', hits('src/Transparent.tsx', /^src\/cp\//).length > 0)

// ---------- 7. 三部分各有一个文件夹，且各有自己的入口语义 ----------
for (const part of ['src/hw', 'src/os', 'src/cp']) {
  check(`${part}/ 存在且有源码`, files.some((f) => f.rel.startsWith(part + '/') && f.rel !== part + '/index.ts'))
}

if (failures.length) {
  console.error(`\n三部分边界检查失败：${failures.length} 项`)
  process.exit(1)
}
console.log('\n三部分边界检查通过')
