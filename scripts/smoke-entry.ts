const store = new Map<string, string>()
globalThis.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k) : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
}

const { Kernel } = await import('../src/os/kernel')

const kernel = new Kernel()
const fail = (msg: string) => {
  console.error('smoke: FAIL ' + msg)
  process.exitCode = 1
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const type = async (line: string) => {
  for (const ch of line) kernel.typeChar(ch)
  kernel.pressEnter()
  await sleep(300)
}
const output = () =>
  kernel
    .consoleLines()
    .map((l) => l.segs.map((s) => s.t).join(''))
    .join('\n')

await sleep(400)
if (kernel.panic) {
  fail('kernel panicked at boot: ' + JSON.stringify(kernel.panic))
  process.exit(process.exitCode ?? 1)
}
if (!kernel.kmsg().some((l) => l.includes(`crados 3.1 booting on browser/js`)))
  fail('boot banner missing version')

await sleep(200)
if (!output().includes('user@crados:')) fail(`prompt prefix should be user@crados:`)
await type('whoami')
if (!output().split('\n').includes('user')) fail('whoami should print user')

await type('uname -a')
if (!output().includes(`crados 3.1 browser js single-core`)) fail('uname -a missing version')

await type('kill 1')
if (!output().includes('kill: failed')) fail('kill 1 did not fail for uid 1 (EPERM expected)')

await type('mount sdb /mnt')
if (!output().includes('mount: cannot mount device'))
  fail('mount as uid 1 did not fail (root-only expected)')

await type('echo hi > /tmp/a')
await type('cat /tmp/a')
if (!output().includes('hi')) fail('write into sticky /tmp then cat failed')

await type('chmod +s /tmp/a')
await type('ls -l /tmp')
if (/^-rwxrws/.test(output())) fail('uid 1 managed to set the setuid bit')
const lsTmp = output().split('\n').filter((l) => l.startsWith('-'))
if (!lsTmp.some((l) => /^-\S+\s+user\s/.test(l))) fail(`ls -l owner column should show user: ${lsTmp}`)

const linesBefore = output().split('\n').length
await type('chmod u-w /tmp/a')
await type('echo x > /tmp/a')
await type('cat /tmp/a')
const added = output().split('\n').slice(linesBefore)
if (!added.some((l) => l === 'hi')) fail('cat /tmp/a lost its content after denied write')

const before2 = output().split('\n').length
await type('echo HACKED > /home/user/README.md')
const afterEcho = output().split('\n').length
await type('cat /home/user/README.md')
const catOut = output().split('\n').slice(afterEcho)
if (catOut.some((l) => l === 'HACKED'))
  fail('uid 1 managed to overwrite a root-owned file')
if (!catOut.some((l) => l.startsWith('# crados')))
  fail('README.md first line wrong after denied write')

console.log(output().split('\n').slice(-10).join('\n'))
if (!process.exitCode) console.log('smoke: OK')
kernel.destroy()
