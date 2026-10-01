// 无头冒烟测试：在没有浏览器的情况下把整台机器跑起来。
//
// 覆盖范围
//   1. 引导：内核启动、42 个系统程序汇编进 /bin、sda 根盘写盘、init/login 起来
//   2. 启动来源：从 .img 引导、坏镜像被拒、没有 IndexedDB 时明确报错
//   3. 交互：登录 root，跑一遍真实命令（ls / as / count / 重定向 / ps / lsblk / dmesg）
//   4. 观测层：ControlPanel 能构建快照与目录树（打开“存储”面板时走的那条路）
//
// 任何 panic、断言失败或超时都以非零码退出。由 scripts/smoke.mjs 打包后运行。

import { Kernel } from '@/os/kernel'
import { PAGE_SIZE } from '@/hw/ram'
import { parsePasswd, serializePasswd } from '@/os/accounts'
import { OS_VERSION } from '@/os/version'
import { ControlPanel } from '@/cp/snapshot'

// 观测层用 rAF 合并重绘；Node 里没有这个 API
if (typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame !== 'function') {
  const g = globalThis as unknown as Record<string, unknown>
  g.requestAnimationFrame = (fn: (t: number) => void) => setTimeout(() => fn(0), 0)
  g.cancelAnimationFrame = (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)
}

const k = new Kernel()
// 上电：固件把一张空盘装进系统盘位，操作系统再往上面装系统。
// Node 里没有 IndexedDB，落盘整体停用
const bootErr = await k.machine.powerOn({ kind: 'blank' })
const screenText = (kernel: Kernel) =>
  kernel.machine.console
    .screen()
    .map((l) => l.segs.map((s) => s.t).join(''))
    .join('\n')
const consoleText = () => screenText(k)
// 廉价的变化指纹：行数 + 最后两行（提示符会在原行上重绘）
const fingerprint = () => {
  const ls = k.machine.console.screen()
  return `${ls.length}|${ls.slice(-2).map((l) => l.segs.map((s) => s.t).join('')).join('\u0001')}`
}

/**
 * 推进内核直到控制台安静下来，返回用掉的 tick 数。
 *
 * 注意：内核的硬件时钟按真实时间走（20 Hz），tick 与墙钟没有固定比例——
 * 空闲时一个 tick 可能只要 1 ms，跑程序时可能要 10 ms。所以这里既要求
 * “安静 30 个 tick”，也要求“安静 300 ms”，否则会在程序还没跑完时提前收工。
 */
function settle(max = 40000, quietTicks = 30, quietMs = 300): number {
  let quiet = 0
  let last = fingerprint()
  let lastChange = performance.now()
  for (let i = 0; i < max; i++) {
    k.step()
    const now = fingerprint()
    if (now !== last) {
      last = now
      quiet = 0
      lastChange = performance.now()
    } else if (++quiet > quietTicks && performance.now() - lastChange > quietMs) {
      return i
    }
  }
  return max
}

function type(text: string) {
  for (const ch of text) k.typeChar(ch)
  k.pressEnter()
}

const failures: string[] = []
function check(label: string, ok: boolean, detail = '') {
  const line = `${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`
  console.log(line)
  if (!ok) failures.push(label)
}

// ---------- 1. 引导 ----------
const bootTicks = settle(4000, 40)
const boot = consoleText()
check('引导完成且没有 panic', k.panic === null && bootErr === null, bootErr ?? k.panic ?? '')
check('登录提示出现', /crados login:/.test(boot))
check('42 个系统程序装进 /bin', boot.includes('42 programs installed on /dev/sda'))
const binFs = k.filesystem('sda')!
const binIno = binFs.lookup(2, 'bin')
const accountToolSizes = ['login', 'passwd', 'useradd', 'userdel', 'chperm', 'users'].map((name) => {
  const ino = binFs.lookup(binIno, name)
  return [name, binFs.isize(ino)] as const
})
const execLimit = 14 * PAGE_SIZE
check(
  '登录与账户工具都低于 guest exec 上限',
  binIno !== 0 && accountToolSizes.every(([, size]) => size > 0 && size <= execLimit),
  `${accountToolSizes.map(([name, size]) => `${name}=${size} B`).join(', ')} / ${execLimit} B`,
)
check('引导标语带的是当前版本', boot.includes(`crados ${OS_VERSION}`), OS_VERSION)
check('根盘写盘成功', /sda: root image written, \d+ inodes/.test(boot))
check('引导在 4000 个 tick 内结束', bootTicks < 4000, `${bootTicks} ticks`)
void bootTicks

const rootPassword = 'correct-horse-battery-staple'
type('root')
settle()
check('首次启动强制设置 root 密码', /Set an initial password for root/.test(consoleText()))
type(rootPassword)
settle()
check('密码输入不回显', !consoleText().includes(rootPassword))
type(rootPassword)
settle()
check('root 初始密码已写入 bcrypt 散列', /password updated/.test(consoleText()))
type('root')
settle()
check('root 登录要求密码', /Password: $/.test(consoleText()))
type(rootPassword)
settle()
check('root 密码登录成功', /root@crados:\/root\$/.test(consoleText()))

// ---------- 2. 启动来源 ----------
// 三种引导方式覆盖开机菜单的三个选项；这里每种都开一台新机器，跑完就扔
const sdaImage = k.machine.disks.image('sda')!
check('能取到 sda 整盘字节', sdaImage.length === 1024 * 1024, `${sdaImage.length} B`)

const fromImage = new Kernel()
const imageErr = await fromImage.machine.powerOn({ kind: 'image', bytes: sdaImage, filename: 'sda.img' })
check('从 .img 引导成功', imageErr === null && fromImage.panic === null, imageErr ?? fromImage.panic ?? '')
check(
  '从 .img 引导后系统程序就位',
  /bin: \d+ programs installed/.test(screenText(fromImage)),
)
check(
  '从 .img 引导后 init 以机器码启动',
  /init: pid 1 started from \/bin\/init as machine code/.test(
    screenText(fromImage),
  ),
)
await fromImage.destroy()

const shortImage = new Kernel()
// 短镜像由盘位按零补齐（与真机一样），随后被操作系统当成非 ext2 盘拒掉
const shortErr = await shortImage.machine.powerOn({ kind: 'image', bytes: new Uint8Array(4096), filename: 'junk.img' })
check('短镜像被补齐后拒掉（不是 ext2）', typeof shortErr === 'string' && shortErr.length > 0, String(shortErr))
await shortImage.destroy()

const blankImage = new Kernel()
const blankErr = await blankImage.machine.powerOn({ kind: 'image', bytes: new Uint8Array(1024 * 1024), filename: 'blank.img' })
check('全零镜像被拒且给出原因', typeof blankErr === 'string' && blankErr.length > 0, String(blankErr))
await blankImage.destroy()

// 介质层面的问题由盘位当场说清楚，用不着操作系统出面
const hugeImage = new Kernel()
const hugeErr = await hugeImage.machine.powerOn({ kind: 'image', bytes: new Uint8Array(1024 * 1024 + 1), filename: 'huge.img' })
check('比盘还长的镜像被盘位拒收', typeof hugeErr === 'string' && hugeErr.length > 0, String(hugeErr))
check('被拒收的介质不会留在盘位上', hugeImage.machine.disks.system === null)
check('机器没上电，操作系统没接管', hugeImage.panic === null)
await hugeImage.destroy()

const noStore = new Kernel()
const storeErr = await noStore.machine.powerOn({ kind: 'stored' })
check('没有 IndexedDB 时明确报错', typeof storeErr === 'string' && storeErr.length > 0, String(storeErr))
await noStore.destroy()

// ---------- 3. 交互 ----------
const session: Array<[string, RegExp]> = [
  ['ls /bin', /(^|\s)cat(\s|$)/],
  ['as /root/count.s -o /tmp/count', /assembly complete/],
  ['/tmp/count', /0 1 2 3 4 5 6 7 8 9/],
  ['echo hi > /tmp/a', /root@crados/],
  ['cat /tmp/a', /(^|\n)hi(\s|$)/],
  ['ps', /\[idle\]/],
  ['ps', /\/bin\/init/],
  ['lsblk', /sda\s+1048576\s+disk\s+\//],
  ['dmesg', /sched: pid \d+ \(\w+\) exited/],
  // 相对路径与 cd：ino_in_range 一度把 r6（vfs_resolve 的当前 inode）冲掉，
  // 于是所有相对路径都解析成 inode 0xFFFF，cd 到哪都不动
  ['mkdir /tmp/rt', /root@crados:\/root\$/],
  ['cd /tmp/rt', /root@crados:\/tmp\/rt\$/],
  ['echo hi > rel.txt', /root@crados:\/tmp\/rt\$/],
  ['cat rel.txt', /(^|\n)hi(\s|$)/],
  ['mkdir sub', /root@crados:\/tmp\/rt\$/],
  ['cd sub', /root@crados:\/tmp\/rt\/sub\$/],
  ['cat ../rel.txt', /(^|\n)hi(\s|$)/],
  ['ls ..', /rel\.txt/],
  ['ls .', /\.\./],
  ['cd ..', /root@crados:\/tmp\/rt\$/],
  ['pwd', /(^|\n)\/tmp\/rt(\s|$)/],
  ['cd .', /root@crados:\/tmp\/rt\$/],
  ['cd /root', /root@crados:\/root\$/],
  // 账户与 su：一次性 login 必须能和控制台登录循环并存（曾经被单例判据挡死）
  ['useradd alice', /root@crados/],
  ['su', /root@crados:\/root\$/],
  ['whoami', /(^|\n)root(\s|$)/],
  ['exit', /root@crados:\/root\$/],
]
for (const [cmd, expect] of session) {
  const before = consoleText()
  type(cmd)
  settle()
  // 提示符会在同一行上重绘，所以从命令回显前一点开始截取
  const delta = consoleText().slice(Math.max(0, before.length - 40))
  // 登录会清屏（输出比之前短），此时直接看整屏
  const seen = delta.length > 0 ? delta : consoleText()
  check(`命令 ${cmd}`, expect.test(seen), expect.test(seen) ? '' : JSON.stringify(seen.slice(0, 120)))
  if (k.panic) {
    check(`命令 ${cmd} 没有把机器搞崩`, false, k.panic)
    break
  }
}

const accountFs = k.filesystem('sda')!
const etcIno = accountFs.lookup(2, 'etc')
const passwdIno = etcIno ? accountFs.lookup(etcIno, 'passwd') : 0
const readAccounts = () => passwdIno ? parsePasswd(accountFs.read(passwdIno)) : []
const alicePassword = 'alice-secure-password-2026'
const aliceUpdatedPassword = 'alice-updated-password-2026'
type('su alice')
settle(40000, 40, 1400)
check('新建账户默认锁定，未设密码不能 su', /login incorrect/.test(consoleText()) && /root@crados:\/root\$/.test(consoleText()))
type('passwd alice')
settle()
check('root 可为锁定账户设置密码', /New password: $/.test(consoleText()))
type(alicePassword)
settle()
check('passwd 要求二次确认', /Retype new password: $/.test(consoleText()))
type(alicePassword)
settle()
check('alice 密码已保存', /password updated/.test(consoleText()))
type('su alice')
settle()
check('root 可免密切换到其他账户', /alice@crados:\/home\/alice\$/.test(consoleText()))
type('exit')
settle()
check('退出 su 返回 root', /root@crados:\/root\$/.test(consoleText()))
type('exit')
settle()
type('alice')
settle()
check('普通账户控制台登录要求密码', /Password: $/.test(consoleText()))
type(alicePassword)
settle()
check('alice 密码登录成功', /alice@crados:\/home\/alice\$/.test(consoleText()))
type('users')
settle()
check('users 以受限特权身份显示账户信息，不泄露散列', /alice/.test(consoleText()) && !consoleText().includes('$2b$'), JSON.stringify(consoleText().slice(-180)))
type('cat /etc/passwd')
settle()
check('普通用户不能读取密码文件', /cannot open file|permission denied/i.test(consoleText()), JSON.stringify(consoleText().slice(-180)))
type('passwd')
settle()
check('普通用户改密必须验证当前密码', /Current password: $/.test(consoleText()))
type('incorrect-current-password')
settle(40000, 40, 1400)
check('错误的当前密码不能重置账户', /authentication failed/.test(consoleText()) && /alice@crados:\/home\/alice\$/.test(consoleText()))
const aliceHashBeforeMismatch = readAccounts().find((account) => account.name === 'alice')?.hash
type('passwd')
settle()
type(alicePassword)
settle()
type('mismatch-candidate-password-2026')
settle()
type('mismatch-confirm-password-2026')
settle()
check('两次输入不一致时不更新散列', /passwords do not match/.test(consoleText()) && readAccounts().find((account) => account.name === 'alice')?.hash === aliceHashBeforeMismatch)
type('passwd')
settle()
type(alicePassword)
settle()
type(aliceUpdatedPassword)
settle()
type(aliceUpdatedPassword)
settle()
check('通过当前密码验证后可以更新密码', /password updated/.test(consoleText()), JSON.stringify(consoleText().slice(-180)))
type('exit')
settle()
type('alice')
settle()
check('更新后的密码用于再次登录', /Password: $/.test(consoleText()))
type(aliceUpdatedPassword)
settle()
check('更新后的密码登录成功', /alice@crados:\/home\/alice\$/.test(consoleText()))
type('su root')
settle()
check('普通用户 su root 必须验证 root 密码', /Password: $/.test(consoleText()))
type(rootPassword)
settle()
check('输入 root 密码后 su 成功', /root@crados:\/root\$/.test(consoleText()))
type('whoami')
settle()
check('su root 的身份正确', /\broot\b/.test(consoleText()))
type('exit')
settle()
check('退出 root su 返回 alice', /alice@crados:\/home\/alice\$/.test(consoleText()))
type('exit')
settle()
type('root')
settle()
type(rootPassword)
settle()
check('root 可重新登录控制台', /root@crados:\/root\$/.test(consoleText()))
type('exit')
settle()
const disk = accountFs
const passwdRows = readAccounts()
let legacyHash = 5381
for (const byte of new TextEncoder().encode(rootPassword)) legacyHash = ((Math.imul(legacyHash, 33) ^ byte) & 0xffff) >>> 0
const legacyRows = passwdRows.map((account) => account.name === 'root' ? { ...account, hash: String(legacyHash) } : account)
const legacyWrite = passwdIno ? disk.write(passwdIno, serializePasswd(legacyRows)) : { err: 'ENOENT' }
check('旧版 root 散列测试夹具写入', typeof legacyWrite === 'number')
type('root')
settle()
type(rootPassword)
settle()
check('旧版散列认证后强制迁移', /Password storage needs an upgrade/.test(consoleText()) && /New password: $/.test(consoleText()))
type(rootPassword)
settle()
type(rootPassword)
settle()
const upgradedRows = passwdIno ? parsePasswd(disk.read(passwdIno)) : []
check('旧版数值散列已升级为 bcrypt', upgradedRows.find((account) => account.name === 'root')?.hash.startsWith('$2b$12$') === true)
type('root')
settle()
type(rootPassword)
settle()
check('迁移后的 root 凭据仍可登录', /root@crados:\/root\$/.test(consoleText()))

check('会话结束仍然没有 panic', k.panic === null, k.panic ?? '')

// ---------- 3. 后台作业留下的僵尸 ----------
// 后台命令（尾随 &）没有 wait，僵尸会一直占着 PCB 槽位：攒到十几个之后
// 进程表满，连 echo 都起不来（sh: command not found）。槽位分配器要能回收
// 「没人会再 wait」的僵尸。
for (let i = 0; i < 14; i++) {
  type('ls /bin &')
  settle()
}
type('echo alive-after-bg')
settle()
const bgTail = consoleText().slice(-200)
check('十几个后台作业之后还能起新进程', /(^|\n)alive-after-bg(\s|$)/.test(bgTail), JSON.stringify(bgTail.slice(-60)))

// 丢失唤醒不变式：阻塞中的进程不该有「已经在等它的僵尸子进程」——
// 子进程若在「父进程扫完 PCB 表、还没标 BLOCKED」的窗口里退出，唤醒会丢，
// 父进程（通常就是 shell）会永远停在等待上，提示符再也不出现。
const alive = k.processes()
const zombies = alive.filter((p) => p.state === 'zombie')
const stuck = alive.filter(
  (p) =>
    p.state === 'blocked' &&
    !p.readStdin &&
    p.waitFor !== null &&
    zombies.some((z) => z.ppid === p.pid && (p.waitFor === -1 || z.pid === p.waitFor)),
)
check('没有进程卡在丢失唤醒的等待上', stuck.length === 0, stuck.map((p) => `${p.pid}:${p.name} 等 ${p.waitFor}`).join(', '))

// ---------- 4. 观测层 ----------
const cp = new ControlPanel(k)
const snap = cp.getSnapshot()
check('快照包含 4 个以上进程', snap.procs.length >= 4, `${snap.procs.length}`)
check('物理帧有主', snap.mem.framesUsed >= 100, `${snap.mem.framesUsed} used`)
const countNodes = (n: { kids: unknown[] }): number =>
  1 + n.kids.reduce((a: number, c) => a + countNodes(c as { kids: unknown[] }), 0)
const countDisasm = (n: { kids: unknown[]; disasm?: string[] }): number =>
  (n.disasm ? 1 : 0) + n.kids.reduce((a: number, c) => a + countDisasm(c as never), 0)
check('目录树可构建', countNodes(snap.tree) > 60, `${countNodes(snap.tree)} 个节点`)
check('可执行文件都能反汇编', countDisasm(snap.tree) >= 40, `${countDisasm(snap.tree)} 个`)
cp.detach()
await k.destroy()

if (failures.length) {
  console.error(`\n${failures.length} 项失败:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\n冒烟测试通过')
