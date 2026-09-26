// 账户表：根盘上的 /etc/passwd，一行一个账户，全部是磁盘字节。
//
//   name:uid:hash:perms
//
//   name   1..8 个字符，小写字母开头，允许字母数字 _ -
//   uid    十进制，root 固定为 0
//   hash   密码的 djb2-16 校验值（十进制）；"-" 表示空密码
//   perms  权限字母的子集："-" 表示没有
//            l  允许从控制台登录（去掉即锁定账户）
//            m  允许 mount/umount
//            b  允许 block_read/block_write 原始块读写
//            k  允许向其他账户的进程发信号
//            a  管理员：登录会话以有效 uid 0 运行
//          uid 0 永远隐式拥有全部权限。
//
// 哈希只有 16 位，挡不住任何认真的攻击——这是教学系统，账户表的意义
// 在于把"密码"和"权限"变成真实的盘上字段，而不是提供真正的安全。

export interface Account {
  name: string
  uid: number
  hash: string // '-' = 空密码
  perms: string // '-' = 无
}

export const ROOT_NAME = 'root'
export const MAX_ACCOUNTS = 24
export const PERM_LETTERS = 'lmbka'

export const accountNameOk = (name: string): boolean =>
  /^[a-z][a-z0-9_-]{0,7}$/.test(name)

export const sanitizePerms = (raw: string): string => {
  let out = ''
  for (const ch of raw) {
    if (PERM_LETTERS.includes(ch) && !out.includes(ch)) out += ch
  }
  return out || '-'
}

// djb2 的 16 位变体：h = h*33 ^ c，模 2^16。空密码没有哈希。
export const hashPassword = (pass: string): string => {
  if (!pass) return '-'
  let h = 5381
  for (let i = 0; i < pass.length; i++) {
    h = ((h * 33) ^ pass.charCodeAt(i)) & 0xffff
  }
  return String(h)
}

export const parsePasswd = (text: string): Account[] => {
  const out: Account[] = []
  for (const line of text.split('\n')) {
    const rec = line.trim()
    if (!rec) continue
    const [name, uid, hash, perms] = rec.split(':')
    if (!name || uid === undefined) continue
    const n = Number(uid)
    if (!Number.isInteger(n) || n < 0 || n > 65535) continue
    out.push({
      name: name.slice(0, 8),
      uid: n,
      hash: hash && hash !== '' ? hash : '-',
      perms: perms && perms !== '' ? perms : '-',
    })
  }
  return out
}

export const serializePasswd = (list: Account[]): string =>
  list.map((a) => `${a.name}:${a.uid}:${a.hash}:${a.perms}`).join('\n') + '\n'

// 出厂默认：只有 root，密码为空。
export const factoryAccounts = (): Account[] => [
  { name: ROOT_NAME, uid: 0, hash: '-', perms: PERM_LETTERS },
]
