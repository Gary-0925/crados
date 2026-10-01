import { isPasswordHash } from './password'

export interface Account {
  name: string
  uid: number
  hash: string
  perms: string
}

export const ROOT_NAME = 'root'
export const PERM_LETTERS = 'lmbka'
export const LOCKED_PASSWORD = '!'
export const INITIAL_PASSWORD = '-'

const validName = /^[a-z][a-z0-9_-]{0,7}$/
const validUid = /^(0|[1-9][0-9]{0,4})$/

export const parsePasswd = (text: string): Account[] => {
  const out: Account[] = []
  const names = new Set<string>()
  const uids = new Set<number>()

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const fields = line.split(':')
    if (fields.length !== 4) continue
    const [name, uidText, hash, permsText] = fields
    if (!validName.test(name) || !validUid.test(uidText) || !isPasswordHash(hash)) continue
    if (permsText !== '-' && (!/^[lmbka]+$/.test(permsText) || new Set(permsText).size !== permsText.length)) continue

    const uid = Number(uidText)
    if (uid > 65535 || (name === ROOT_NAME) !== (uid === 0) || names.has(name) || uids.has(uid)) continue

    names.add(name)
    uids.add(uid)
    out.push({
      name,
      uid,
      hash,
      perms: permsText === '-' ? '-' : permsText,
    })
  }
  return out
}

export const serializePasswd = (list: Account[]): string =>
  list.map((a) => `${a.name}:${a.uid}:${a.hash}:${a.perms}`).join('\n') + '\n'

export const factoryAccounts = (): Account[] => [
  { name: ROOT_NAME, uid: 0, hash: INITIAL_PASSWORD, perms: PERM_LETTERS },
]
