// 无头冒烟测试：在没有浏览器的情况下把整台机器跑起来。
//
// 覆盖范围
//   1. 引导：内核启动、42 个系统程序汇编进 /bin、sda 根盘写盘、init/login 起来
//   2. 交互：登录 root，跑一遍真实命令（ls / as / count / 重定向 / ps / lsblk / dmesg）
//   3. 观测层：ControlPanel 能构建快照与目录树（打开“存储”面板时走的那条路）
//
// 任何 panic、断言失败或超时都以非零码退出。由 scripts/smoke.mjs 打包后运行。

import { Kernel } from '@/os/kernel'
import { ControlPanel } from '@/cp/snapshot'

// 观测层用 rAF 合并重绘；Node 里没有这个 API
if (typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame !== 'function') {
  const g = globalThis as unknown as Record<string, unknown>
  g.requestAnimationFrame = (fn: (t: number) => void) => setTimeout(() => fn(0), 0)
  g.cancelAnimationFrame = (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)
}

const k = new Kernel()
const consoleText = () => k.consoleLines().map((l) => l.segs.map((s) => s.t).join('')).join('\n')
// 廉价的变化指纹：行数 + 最后两行（提示符会在原行上重绘）
const fingerprint = () => {
  const ls = k.consoleLines()
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
check('引导完成且没有 panic', k.panic === null, k.panic ?? '')
check('登录提示出现', /crados login:/.test(boot))
check('42 个系统程序装进 /bin', boot.includes('42 programs installed on /dev/sda'))
check('根盘写盘成功', /sda: root image written, \d+ inodes/.test(boot))
check('引导在 4000 个 tick 内结束', bootTicks < 4000, `${bootTicks} ticks`)
void bootTicks

// ---------- 2. 交互 ----------
const session: Array<[string, RegExp]> = [
  ['root', /root@crados:\/root\$/],
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
  ['su alice', /alice@crados:\/home\/alice\$/],
  ['whoami', /(^|\n)alice(\s|$)/],
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
k.destroy()

if (failures.length) {
  console.error(`\n${failures.length} 项失败:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\n冒烟测试通过')
