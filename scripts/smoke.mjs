// End-to-end smoke test: boot, login, chmod fix, accounts, permissions.
import { loadKernelModule, makeDriver } from './harness.mjs'

const { server, mod } = await loadKernelModule()
let failures = 0
const pass = (msg) => console.log(`ok   ${msg}`)
const fail = (msg, extra) => {
  failures++
  console.log(`FAIL ${msg}${extra ? `\n----- console tail -----\n${extra.slice(-2500)}` : ''}`)
}

let markerSeq = 0
try {
  const { Kernel } = mod
  const { lookupAbs } = await server.ssrLoadModule('/src/os/fs.ts')
  const { kernel, text, enter, waitFor } = makeDriver(Kernel)
  kernel.setSpeed('max')

  // run shell commands and wait for them to finish: the shell touches a
  // marker file after the commands (sequentially), and we poll the host
  // filesystem for it. No console-text matching, no races with echo.
  const run = async (cmds, timeoutMs = 10000) => {
    const before = text().length
    const mark = `/tmp/.mk${++markerSeq}`
    for (const c of Array.isArray(cmds) ? cmds : [cmds]) enter(c)
    enter(`touch ${mark}`)
    await waitFor(() => lookupAbs(kernel.fss.get('sda'), mark) !== 0, timeoutMs)
    return text().slice(before)
  }

  // ---- 1. boot reaches the console login prompt (factory disk: root only) ----
  await waitFor('crados login: ')
  pass('boot reaches the login prompt')

  // ---- 2. root logs in without a password (hash "-") ----
  enter('root')
  await waitFor('root@crados')
  pass('root logs in with an empty password')

  // ---- 3. chmod can now set bits that were not set before ----
  await run(['touch /tmp/f', 'chmod o+w /tmp/f'])
  const l1 = await run('ls -l /tmp/f')
  if (l1.includes('-rw-rw---')) pass('chmod o+w adds a previously unset bit')
  else fail(`chmod o+w did not take effect: ${JSON.stringify(l1)}`, text())
  await run('chmod u+x /tmp/f')
  const l2 = await run('ls -l /tmp/f')
  if (l2.includes('-rwxrw---')) pass('chmod u+x adds a previously unset bit')
  else fail(`chmod u+x did not take effect: ${JSON.stringify(l2)}`, text())
  await run('chmod o-w /tmp/f')
  const l3 = await run('ls -l /tmp/f')
  if (l3.includes('-rwxr----')) pass('chmod still clears bits')
  else fail(`chmod clear regressed: ${JSON.stringify(l3)}`, text())

  // ---- 4. account table starts with root only ----
  const users1 = await run('users')
  if (users1.includes('root') && users1.includes('lmbk') && !users1.includes('alice')) pass('users shows only root at factory')
  else fail('unexpected users output', text())
  const pw = await run('cat /etc/passwd')
  if (pw.includes('root:0:-:lmbk')) pass('/etc/passwd holds the factory account')
  else fail('unexpected /etc/passwd', text())

  // ---- 5. useradd creates an account with a home directory ----
  const add = await run('useradd alice')
  if (add.includes('account created')) pass('useradd alice')
  else fail('useradd failed', text())
  const users2 = await run('users')
  if (/alice\s+1\s+lmbk/.test(users2)) pass('users lists alice with uid 1 and default perms')
  else fail('users after useradd unexpected', text())
  const lsHome = await run('ls -l /home')
  if (lsHome.includes('alice')) pass('/home/alice exists')
  else fail('/home/alice missing', text())

  // ---- 6. passwd sets a password (input must not echo) ----
  const before = text().length
  enter('passwd alice')
  await waitFor((t) => t.slice(before).includes('New password: '))
  enter('wonder')
  await waitFor((t) => t.slice(before).includes('Retype new password: '))
  const mid = text().slice(before)
  if (!mid.includes('wonder')) pass('password entry is not echoed')
  else fail('password was echoed to the console', text())
  enter('wonder')
  await waitFor((t) => t.slice(before).includes('password updated'))
  pass('passwd alice completes')
  const pw2 = await run('cat /etc/passwd')
  if (/alice:1:\d+:lmbk/.test(pw2)) pass('hash stored in /etc/passwd')
  else fail('hash not stored', text())

  // ---- 7. logout, then alice logs in with her password ----
  enter('exit')
  await waitFor((t) => t.split('crados login:').length >= 3)
  enter('alice')
  await waitFor('Password: ')
  enter('wrongpass')
  await waitFor('login incorrect')
  pass('wrong password rejected')
  enter('alice')
  await waitFor('Password: ')
  enter('wonder')
  await waitFor('alice@crados')
  pass('alice logs in with the right password')

  // ---- 8. login session env: USER/HOME and cd ----
  const wa = await run('whoami')
  if (wa.includes('alice')) pass('whoami in login session')
  else fail('whoami wrong', text())
  await run('cd')
  const pwd = await run('pwd')
  if (pwd.includes('/home/alice')) pass('bare cd goes to $HOME')
  else fail('cd $HOME wrong', text())
  await run('touch note')
  const lsn = await run('ls -l')
  if (lsn.includes('note')) pass('alice can create files in her home')
  else fail('alice home file listing odd', text())

  // ---- 9. permission enforcement: kill denied without k ----
  enter('su root')
  await waitFor('root@crados', 10000)
  pass('su root from inside alice (root has no password)')
  await run('sleep 60 &')
  const ps = await run('ps')
  const m = ps.match(/^\s*(\d+)\s+\d+\s+0\s+\S+.*sleep/m)
  if (!m) fail('cannot find root sleep process in ps', text())
  else {
    const pid = m[1]
    await run(`kill ${pid}`)
    const ps2 = await run('ps')
    if (ps2.includes('sleep')) pass('alice cannot kill root processes without k')
    else fail('kill went through without k perm', text())
    await run('chperm alice lk')
    const users3 = await run('users')
    if (/alice\s+1\s+lk/.test(users3)) pass('chperm updated the permission letters')
    else fail('chperm result missing', text())
    enter('exit') // su shell -> back to alice shell
    await waitFor((t) => t.slice(-400).includes('alice@crados'))
    await run(`kill ${pid}`)
    const ps3 = await run('ps')
    if (!ps3.includes('sleep')) pass('kill works once k is granted')
    else fail('kill still denied with k perm', text())

    // ---- 9b. permission letters: grant admin a, then lock the account ----
    enter('su root')
    await waitFor('root@crados', 10000)
    await run('chperm alice lmbka')
    const usersA = await run('users')
    if (/alice\s+1\s+lmbka/.test(usersA)) pass('chperm grants the admin letter a')
    else fail('admin letter a missing', text())
    await run('chperm alice b') // drop l → account locked
    const usersL = await run('users')
    if (/alice\s+1\s+b\b/.test(usersL) && !/alice\s+1\s+[^ ]*l/.test(usersL))
      pass('chperm can lock an account (drop l)')
    else fail('lock perms wrong', text())
    enter('exit') // su -> alice shell
    await waitFor((t) => t.slice(-400).includes('alice@crados'))
  }

  // ---- 10. locked account cannot log in ----
  enter('exit') // alice shell -> login prompt
  await waitFor((t) => t.split('crados login:').length >= 5)
  enter('alice')
  await waitFor('Password: ')
  enter('wonder')
  await waitFor('cannot start shell')
  pass('locked account is refused a session')

  // ---- 11. userdel removes the account ----
  enter('root')
  await waitFor('root@crados')
  const del = await run('userdel alice')
  if (del.includes('account removed')) pass('userdel alice')
  else fail('userdel failed', text())
  const users4 = await run('users')
  if (!users4.includes('alice')) pass('account table back to root only')
  else fail('alice still listed', text())

  kernel.destroy()
} catch (e) {
  fail(String(e?.message || e))
} finally {
  await server.close()
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS')
process.exit(failures ? 1 : 0)
