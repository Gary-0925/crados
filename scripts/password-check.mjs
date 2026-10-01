import { build } from 'esbuild'
import bcrypt from 'bcryptjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'crados-password-'))
await build({
  entryPoints: {
    password: path.join(root, 'src/os/password.ts'),
    accounts: path.join(root, 'src/os/accounts.ts'),
  },
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'warning',
})

const passwords = await import(pathToFileURL(path.join(outdir, 'password.js')).href)
const accounts = await import(pathToFileURL(path.join(outdir, 'accounts.js')).href)
const failures = []
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const secret = 'correct-horse-battery-staple'
const hash = passwords.hashPassword(secret)
const secondHash = passwords.hashPassword(secret)
check('生成 bcrypt cost 12 散列', typeof hash === 'string' && /^\$2b\$12\$[./A-Za-z0-9]{53}$/.test(hash ?? ''))
check('每次散列使用不同随机盐', !!hash && !!secondHash && bcrypt.getSalt(hash) !== bcrypt.getSalt(secondHash))
check('散列不包含明文', !!hash && !hash.includes(secret))
check('正确密码可验证', !!hash && passwords.verifyPassword(secret, hash) === 'match')
check('错误密码不能验证', !!hash && passwords.verifyPassword('incorrect-password', hash) === 'invalid')
check('15 个 Unicode 字符可通过策略', passwords.passwordPolicy('🔐'.repeat(15)))
check('短密码被拒绝', !passwords.passwordPolicy('short-password'))
check('超过 bcrypt 输入上限的密码被拒绝', !passwords.passwordPolicy('a'.repeat(73)))
check('未配对代理项被拒绝', !passwords.passwordPolicy('\ud800'.repeat(15)))
check('空密码不能生成散列或验证', passwords.hashPassword('') === null && passwords.verifyPassword('', '5381') === 'invalid')

let legacy = 5381
for (const byte of new TextEncoder().encode('legacy-password')) legacy = ((Math.imul(legacy, 33) ^ byte) & 0xffff) >>> 0
check('旧版散列只用于兼容验证', passwords.verifyPassword('legacy-password', String(legacy)) === 'legacy')
check('过低或异常的 bcrypt cost 被拒绝', !passwords.isPasswordHash(`$2b$10$${'a'.repeat(53)}`) && !passwords.isPasswordHash(`$2b$31$${'a'.repeat(53)}`))
check('未配对代理项不能作为旧散列密码验证', passwords.verifyPassword(String.fromCharCode(0xd800), '0') === 'invalid')
check('无效散列格式被拒绝', !passwords.isPasswordHash('not-a-hash'))

const validRows = [
  { name: 'root', uid: 0, hash: hash ?? '-', perms: 'lmbka' },
  { name: 'alice', uid: 1, hash: '!', perms: 'lmbk' },
]
const serialized = accounts.serializePasswd(validRows)
const parsed = accounts.parsePasswd(serialized)
check('账户表保留 bcrypt 散列与锁定状态', parsed.length === 2 && parsed[0].hash === hash && parsed[1].hash === '!')
check('工厂 root 仅处于首次初始化状态', accounts.factoryAccounts()[0].hash === '-')
check('重复 UID 的账户行被拒绝', accounts.parsePasswd('root:0:-:lmbka\nalice:0:!:lmbk\n').length === 1)
check('无效账户名与权限字段被拒绝', accounts.parsePasswd('BadName:1:!:lmbk\nalice:1:!:ll\n').length === 0)

fs.rmSync(outdir, { recursive: true, force: true })
if (failures.length) {
  console.error(`\n${failures.length} 项失败:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('\n密码系统检查通过')
