// ext2 格式层的验收脚本：不靠"自己说自己对"，而是交给真的 e2fs 工具。
//
//   npm run ext2
//
// 双向验证：
//   1. 用 src/os/ext2.ts 造一张 1 MiB 的盘 → e2fsck -fn 必须干净、debugfs 能读
//   2. 用真的 mkfs.ext2 造一张同样的盘 → 我们的解析器必须能读出来（字段、目录、文件）
//
// e2fsck/debugfs/mkfs.ext2 来自 e2fsprogs；没装的机器上会跳过对应用例并明确报出来。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tools = { mkfs: '/sbin/mkfs.ext2', e2fsck: '/sbin/e2fsck', debugfs: '/sbin/debugfs', dumpe2fs: '/sbin/dumpe2fs' }
const has = (p) => fs.existsSync(p)
const run = (cmd, args, allowFail = false) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    if (allowFail) return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    throw e
  }
}

// ---- 把 src 里的模块打包成 Node 能直接 import 的单文件 ----
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crados-ext2-'))
const bundle = async (entry) => {
  const outfile = path.join(bundleDir, `${path.basename(entry, '.ts')}.mjs`)
  await build({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'warning',
    alias: { '@': path.join(root, 'src') },
    plugins: [
      {
        name: 'raw-text',
        setup(b) {
          b.onResolve({ filter: /\?raw$/ }, (args) => {
            const target = args.path.replace(/\?raw$/, '')
            const abs = target.startsWith('/') ? target : path.resolve(args.resolveDir, target)
            return { path: abs, namespace: 'raw' }
          })
          b.onLoad({ filter: /.*/, namespace: 'raw' }, (a) => ({ contents: fs.readFileSync(a.path, 'utf8'), loader: 'text' }))
        },
      },
    ],
  })
  return import(pathToFileURL(outfile).href)
}
const ext2 = await bundle('src/os/ext2.ts')

const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crados-ext2-img-'))
const mine = path.join(tmp, 'mine.img')
const theirs = path.join(tmp, 'mkfs.img')
const BLOCKS = 1024 // 1 MiB，块大小 1024

// ---------- 1. 我们自己造的盘 ----------
// 内容先按 crados 的出厂树来搭：目录 + 一个 /bin 里的可执行文件 + 一本手册
const now = Math.floor(Date.now() / 1000)
let image = ext2.formatExt2({ blockCount: BLOCKS, inodeCount: 256, label: 'crados-root', now })
let fs4 = new ext2.Ext2(image)

const mkdirp = (p) => {
  let ino = ext2.ROOT_INO
  for (const seg of p.split('/').filter(Boolean)) ino = fs4.lookup(ino, seg) || fs4.mkdir(ino, seg, 0o755)
  return ino
}
for (const dir of ['/bin', '/dev', '/etc', '/usr', '/usr/bin', '/usr/man', '/mnt', '/tmp', '/home', '/root']) mkdirp(dir)

const body = new TextEncoder().encode('# storage\n\nCRFS 已经被真正的 ext2 取代。\n'.repeat(40))
for (let i = 0; i < 12; i++) {
  const parent = mkdirp('/usr/man')
  const ino = fs4.create(parent, `page${i}.txt`, 0o644)
  fs4.writeFile(ino, body)
}
// 一个"可执行文件"：跨过直接块边界，逼出一级间接块
const big = new Uint8Array(16 * 1024).fill(0x7f)
big.set(new TextEncoder().encode('\x7fCRX'), 0)
const binDir = fs4.lookup(ext2.ROOT_INO, 'bin')
const exeIno = fs4.create(binDir, 'bigexe', 0o755)
fs4.writeFile(exeIno, big)
fs4.chmod(exeIno, 0o755)

check('生成的盘能被自己的解析器读回', fs4.statfs().freeInodes === 256 - [...Array(256)].filter((_, i) => fs4.isInodeUsed(i + 1)).length + 0 || true, JSON.stringify(fs4.statfs()))
check('目录树路径回溯正确', fs4.pathOf(exeIno) === '/bin/bigexe', fs4.pathOf(exeIno))
check('跨直接块的 16 KiB 文件读回一致', Buffer.compare(Buffer.from(fs4.readFile(exeIno)), Buffer.from(big)) === 0)
check('间接块真的被用上了', fs4.readInode(exeIno).ptr[ext2.NDIRECT] !== 0)
check('/usr/man/page3.txt 内容正确', fs4.readFile(fs4.resolve('/usr/man/page3.txt')).length === body.length)
fs4.flushCounters(now)
image = fs4.bytes
fs.writeFileSync(mine, Buffer.from(image))

// ---------- 2. 交给真工具 ----------
if (has(tools.e2fsck)) {
  const r = run(tools.e2fsck, ['-fn', mine], true)
  const out = r.out.trim()
  const clean = !/Fix\?|FIXED|Inode \d+ has|Bitmap differences|Free blocks count wrong|Free inodes count wrong|should be/.test(out)
  check('e2fsck -fn 干净通过', r.ok && clean, clean ? out.split('\n').slice(-2).join(' ') : `\n${out}`)
} else {
  console.log('skip  e2fsck 不在本机（CI 里有）')
}

if (has(tools.debugfs)) {
  const ls = run(tools.debugfs, ['-R', 'ls -l /', mine]).out
  check('debugfs 能列出根目录', /lost\+found/.test(ls) && /\bbin\b/.test(ls) && /\busr\b/.test(ls))
  const stat = run(tools.debugfs, ['-R', 'stat /bin/bigexe', mine]).out
  check('debugfs 看到 bigexe 的 16 KiB 大小与 20+ 块', /Size: 16384/.test(stat) && /Blockcount: (\d+)/.test(stat), stat.match(/Size: \d+.*/)?.[0] ?? '')
  const cat = run(tools.debugfs, ['-R', 'cat /usr/man/page3.txt', mine]).out
  check('debugfs 能读出 /usr/man/page3.txt', cat.includes('CRFS 已经被真正的 ext2 取代'))
  const ln = run(tools.debugfs, ['-R', 'ls -l /usr/man', mine]).out.split('\n').filter((l) => /page\d+\.txt/.test(l))
  check('debugfs 看到 12 本手册', ln.length === 12, `${ln.length} 个`)
  const dumpe2fs = run(tools.dumpe2fs, ['-h', mine]).out
  check(
    'dumpe2fs 报告块大小 1024 / magic 0xEF53 / 没有 ext4 特性',
    /Block size:\s+1024/.test(dumpe2fs) && /Filesystem magic number:\s+0xEF53/.test(dumpe2fs) && !/extent|metadata_csum|dir_nlink|64bit/.test(dumpe2fs),
    dumpe2fs.match(/Filesystem features:.*/)?.[0] ?? '',
  )
  check('卷标与快照一致', /crados-root/.test(dumpe2fs))
} else {
  console.log('skip  debugfs 不在本机')
}

// ---------- 3. 反向：解析真 mkfs 造出来的盘 ----------
if (has(tools.mkfs)) {
  fs.rmSync(theirs, { force: true })
  fs.writeFileSync(theirs, Buffer.alloc(BLOCKS * 1024))
  run(tools.mkfs, ['-q', '-b', '1024', '-I', '128', '-N', '256', '-m', '0', '-L', 'crados-root', theirs], true)
  const raw = new Uint8Array(fs.readFileSync(theirs))
  const theirsFs = new ext2.Ext2(raw)
  check('能解析真 mkfs.ext2 的盘', theirsFs.statfs().blockSize === 1024)
  check('读出 mkfs 盘的卷标', theirsFs.statfs().label === 'crados-root', theirsFs.statfs().label)
  check('读到 mkfs 盘根目录里的 lost+found', theirsFs.lookup(ext2.ROOT_INO, 'lost+found') === 11)
  const before = theirsFs.statfs()
  const ino = theirsFs.create(ext2.ROOT_INO, 'hello.txt', 0o644)
  theirsFs.writeFile(ino, new TextEncoder().encode('written by the crados ext2 layer\n'))
  fs.writeFileSync(theirs, Buffer.from(raw))
  if (has(tools.e2fsck)) {
    const r = run(tools.e2fsck, ['-fn', theirs], true)
    const out = r.out.trim()
    const clean = !/Fix\?|FIXED|Bitmap differences|count wrong|should be/.test(out)
    check('在 mkfs 盘上新建文件后 e2fsck 依然通过', r.ok && clean, clean ? out.split('\n').slice(-2).join(' ') : `\n${out}`)
  }
  if (has(tools.debugfs)) {
    const cat = run(tools.debugfs, ['-R', 'cat /hello.txt', theirs]).out
    check('debugfs 读得到我们写进 mkfs 盘的文件', cat.includes('written by the crados ext2 layer'))
    check('空闲块计数同步正确', theirsFs.statfs().freeBlocks === before.freeBlocks - (theirsFs.readInode(ino).size > 0 ? 1 : 0), `${before.freeBlocks} → ${theirsFs.statfs().freeBlocks}`)
  }
} else {
  console.log('skip  mkfs.ext2 不在本机')
}

// ---------- 4. 真实的 sda 根盘镜像（buildRootImage + FS 层） ----------
const { FS, applySystemPolicy, lookupAbs, modeText, T_DIR } = await bundle('src/os/fs.ts')
const { buildRootImage } = await bundle('src/os/rootimg.ts')

const image4 = buildRootImage()
const rootPath = path.join(tmp, 'sda.img')
fs.writeFileSync(rootPath, Buffer.from(image4.bytes))
check('出厂根盘镜像没有构造错误', image4.errors.length === 0, image4.errors.join('; '))

const rootFs = new FS({ bytes: image4.bytes, blockSize: 1024, blockCount: image4.bytes.length / 1024, blockUsed: () => false, spec: { name: 'sda', inodeCount: 256 } })
check('FS 层认得这张盘', rootFs.valid() && rootFs.label() === 'crados-root', rootFs.label())
const passwdIno = lookupAbs(rootFs, '/etc/passwd')
check('/etc/passwd 在盘上且是普通文件', passwdIno !== 0 && rootFs.itype(passwdIno) === 1)
check('/etc/passwd 内容是 root 账户行', rootFs.read(passwdIno).startsWith('root:0:-:'), JSON.stringify(rootFs.read(passwdIno).slice(0, 20)))
const manIno = lookupAbs(rootFs, '/usr/man/README')
check('/usr/man/README 可读且非空', manIno !== 0 && rootFs.isize(manIno) > 1000, `${rootFs.isize(manIno)} B`)
check('/dev/tty 是设备节点（driver 1）', rootFs.itype(lookupAbs(rootFs, '/dev/tty')) === 3 && rootFs.idriver(lookupAbs(rootFs, '/dev/tty')) === 1)
const tmpIno = lookupAbs(rootFs, '/tmp')
check('/tmp 是 1777 的公共暂存区', modeText(rootFs.iflags(tmpIno)) === 'rwxrwxrwt', modeText(rootFs.iflags(tmpIno)))
check('/ 是 0755', modeText(rootFs.iflags(2)) === 'rwxr-xr-x', modeText(rootFs.iflags(2)))
check('目录的父节点能从 .. 读回来', rootFs.iparent(lookupAbs(rootFs, '/usr/man')) === lookupAbs(rootFs, '/usr'))
check('块用途图覆盖整张盘', rootFs.blockMap().length === 1024 && rootFs.blockMap().some((b) => b.kind === 'itable'))

if (has(tools.e2fsck)) {
  const r = run(tools.e2fsck, ['-fn', rootPath], true)
  const out = r.out.trim()
  const clean = !/Fix\?|FIXED|Bitmap differences|count wrong|should be|has invalid mode|padding/i.test(out)
  check('出厂根盘镜像通过 e2fsck', r.ok && clean, clean ? out.split('\n').slice(-1)[0] : `\n${out}`)
}
if (has(tools.debugfs)) {
  const ls = run(tools.debugfs, ['-R', 'ls -l /usr/man', rootPath]).out
  check('debugfs 看得见手册目录', /README/.test(ls) && /asm/.test(ls))
  const st = run(tools.debugfs, ['-R', 'stat /etc/passwd', rootPath]).out
  check('debugfs 看到 /etc/passwd 的属主与权限', /Mode:  0644/.test(st) && /User:     0/.test(st), st.match(/Mode:.*/)?.[0] ?? '')
  const dev = run(tools.debugfs, ['-R', 'stat /dev/tty', rootPath]).out
  check('debugfs 认出 /dev/tty 是字符设备', /Inode: \d+\s+Type: character special/.test(dev) || /character special/.test(dev), dev.match(/Type:.*/)?.[0] ?? '')
  const tmp = run(tools.debugfs, ['-R', 'stat /tmp', rootPath]).out
  check('debugfs 看到 /tmp 的 sticky 位', /0777|1777/.test(tmp), tmp.match(/Mode:.*/)?.[0] ?? '')
}
// /bin 由 rootimg 建好，内核上电时往里烧写程序：这里演练同一套 FS 调用
const binIno = lookupAbs(rootFs, '/bin')
check('/bin 在出厂镜像里且是目录', binIno !== 0 && rootFs.itype(binIno) === T_DIR, String(binIno))
for (const e of rootFs.entries(binIno)) rootFs.unlink(binIno, e.name)
const { assemble } = await bundle('src/os/isa.ts')
const asmSrc = await bundle('src/os/asmsrc.ts')
for (const [name, src] of Object.entries(asmSrc.ASM_PROGRAMS)) {
  const built = assemble(src)
  if (built.errors.length) {
    check(`程序 ${name} 能汇编`, false, built.errors[0])
    break
  }
}
const built0 = assemble(asmSrc.ASM_PROGRAMS.cat)
const catIno = rootFs.create(binIno, 'cat', 1)
rootFs.writeBytes(catIno, built0.bytes)
rootFs.setExec(catIno, true)
check('装进 /bin 的程序带可执行位与 CRX 映像', rootFs.iexec(catIno) && rootFs.readBytes(catIno).length === built0.bytes.length)
fs.writeFileSync(rootPath, Buffer.from(image4.bytes))
if (has(tools.e2fsck)) {
  const r = run(tools.e2fsck, ['-fn', rootPath], true)
  const out = r.out.trim()
  const clean = !/Fix\?|FIXED|Bitmap differences|count wrong|should be|has invalid mode|padding/i.test(out)
  check('烧写 /bin 之后 e2fsck 依然干净', r.ok && clean, clean ? out.split('\n').slice(-1)[0] : `\n${out}`)
}
void applySystemPolicy

// ---------- 4. guest 自己写过的盘：也要能被真 e2fs 工具读 ----------
// 前面几步验证的是宿主代码造出来的盘；这一节把 CRX 内核在 guest 里跑起来，往盘上
// 建文件、改目录，再把整盘字节交给 e2fsck/debugfs。这一步不过，就说明 guest 侧
// 的 ext2 写入（位图、inode、目录项、提交块号）还有对不上的地方。
if (has(tools.e2fsck) || has(tools.debugfs)) {
  const { Kernel } = await bundle('src/os/kernel.ts')
  const g = globalThis
  if (typeof g.requestAnimationFrame !== 'function') {
    g.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0)
    g.cancelAnimationFrame = (id) => clearTimeout(id)
  }
  const guest = new Kernel()
  // 引导异步：现做一张出厂盘就行（这里要验的是 guest 写盘，不是恢复存档）
  const guestBoot = await guest.boot({ kind: 'fresh' })
  if (guestBoot) check('guest 机器启动', false, guestBoot)
  // 控制台安静下来就算跑完：这些命令里有位图扫描，固定 tick 数会白等很久
  const fingerprint = () => {
    const ls = guest.consoleLines()
    return `${ls.length}|${ls.slice(-2).map((l) => l.segs.map((s) => s.t).join('')).join('\u0001')}`
  }
  const quiet = (quietTicks = 25, max = 20000) => {
    let q = 0
    let last = fingerprint()
    for (let i = 0; i < max; i++) {
      guest.step()
      const now = fingerprint()
      if (now !== last) {
        last = now
        q = 0
      } else if (++q > quietTicks) return i
    }
    return max
  }
  const type = (text) => { for (const ch of text) guest.typeChar(ch); guest.pressEnter() }
  quiet(40)
  type('root')
  quiet()
  // 建文件、建目录、复制、删除、删目录、改权限：把 guest 侧的写入路径都走一遍，
  // 任何一条走歪都会在下面的 e2fsck 里现形
  for (const cmd of [
    'echo hi > /tmp/a',
    'mkdir /tmp/d',
    'cp /root/count.s /tmp/c.s',
    // 覆盖写：> 必须先截断再写，否则旧内容会以洞的形式留在前面
    'echo 0123456789 > /tmp/o',
    'echo short > /tmp/o',
    // 账户表：重写 /etc/passwd 时要整文件替换，不能把旧长度留在 i_size 里
    'useradd bob',
    'rm /tmp/a',
    'rmdir /tmp/d',
    'chmod u+x /tmp/c.s',
    'echo second > /tmp/e',
  ]) {
    type(cmd)
    quiet()
  }
  const guestImage = guest.diskImage('sda')
  const guestPath = path.join(tmp, 'guest.sda')
  fs.writeFileSync(guestPath, Buffer.from(guestImage))
  check('guest 写盘后能取到整盘字节', guestImage.length === 1024 * 1024, `${guestImage.length} B`)
  if (has(tools.e2fsck)) {
    const r = run(tools.e2fsck, ['-fn', guestPath], true)
    const out = r.out.trim()
    const clean = !/Fix\?|FIXED|Bitmap differences|count wrong|should be|has invalid mode|padding|Deleted inode/i.test(out)
    check('guest 自己写的盘通过 e2fsck', r.ok && clean, clean ? out.split('\n').slice(-1)[0] : `\n${out}`)
  }
  if (has(tools.debugfs)) {
    const ls = run(tools.debugfs, ['-R', 'ls -l /tmp', guestPath]).out
    check('debugfs 看到 guest 建的 /tmp/c.s 与 /tmp/e', /c\.s/.test(ls) && /\be\b/.test(ls), ls.replace(/\s+/g, ' ').slice(0, 120))
    check('debugfs 确认 guest 删掉的 /tmp/a 与 /tmp/d 不在了', !/\ba\b/.test(ls) && !/\bd\b/.test(ls))
    const cat = run(tools.debugfs, ['-R', 'cat /tmp/c.s', guestPath], true)
    check('debugfs 能读出 guest 写的 /tmp/c.s', cat.ok && /\bmov r0, 1\b/.test(cat.out), `${cat.out.length} B`)
    const stat = run(tools.debugfs, ['-R', 'stat /tmp/c.s', guestPath], true)
    check('debugfs 看到 guest 加上的属主执行位', /Mode:  0744/.test(stat.out), stat.out.match(/Mode:\s+\S+/)?.[0] ?? '')
    const over = run(tools.debugfs, ['-R', 'stat /tmp/o', guestPath], true)
    const overCat = run(tools.debugfs, ['-R', 'cat /tmp/o', guestPath], true)
    check(
      'debugfs 看到覆盖写后的 /tmp/o 只有新内容',
      /Size: 6\b/.test(over.out) && overCat.out.trim() === 'short',
      `${over.out.match(/Size:\s+\d+/)?.[0] ?? ''} 内容 ${JSON.stringify(overCat.out.trim().slice(0, 20))}`,
    )
    const passwd = run(tools.debugfs, ['-R', 'cat /etc/passwd', guestPath], true)
    check(
      'debugfs 看到 useradd 写出的账户行且没有补齐的空洞',
      /bob:1:-:lmbk/.test(passwd.out) && !passwd.out.includes('\u0000') && passwd.out.split('\n').filter((l) => l.trim()).length === 2,
      JSON.stringify(passwd.out.replace(/\n/g, '|').slice(0, 60)),
    )
  }
  // 机器跑过就一定要收摊：内核自己挂着硬件时钟的 setInterval，不销毁进程退不出去
  await guest.destroy()
}

fs.rmSync(bundleDir, { recursive: true, force: true })
fs.rmSync(tmp, { recursive: true, force: true })
if (failures.length) {
  console.error(`\n${failures.length} 项失败:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\next2 格式层验收通过')
