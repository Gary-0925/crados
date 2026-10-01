import bcrypt from 'bcryptjs'

export const PASSWORD_COST = 12
export const PASSWORD_MIN_CODEPOINTS = 15
export const PASSWORD_MAX_BYTES = 72

const bcryptPattern = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/
const legacyPattern = /^(0|[1-9][0-9]{0,4})$/
const encoder = new TextEncoder()
const strictDecoder = new TextDecoder('utf-8', { fatal: true })

const hasValidUtf8 = (value: string): boolean => {
  try {
    return strictDecoder.decode(encoder.encode(value)) === value
  } catch {
    return false
  }
}

export type PasswordVerification = 'match' | 'legacy' | 'invalid'

export const isPasswordHash = (value: string): boolean => {
  if (value === '-' || value === '!') return true
  const match = bcryptPattern.exec(value)
  if (match) {
    const cost = Number(match[1])
    return cost >= PASSWORD_COST && cost <= 14
  }
  return legacyPattern.test(value) && Number(value) <= 65535
}

export const passwordPolicy = (password: string): boolean => {
  if (!password || password.includes('\0')) return false
  const bytes = encoder.encode(password)
  if (bytes.length > PASSWORD_MAX_BYTES || [...password].length < PASSWORD_MIN_CODEPOINTS) return false
  return hasValidUtf8(password)
}

export const hashPassword = (password: string): string | null => {
  if (!passwordPolicy(password)) return null
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') throw new Error('Secure random source unavailable')
  return bcrypt.hashSync(password, bcrypt.genSaltSync(PASSWORD_COST))
}

const legacyHash = (password: string): number => {
  let value = 5381
  for (const byte of encoder.encode(password)) value = ((Math.imul(value, 33) ^ byte) & 0xffff) >>> 0
  return value
}

export const verifyPassword = (password: string, stored: string): PasswordVerification => {
  if (!password || password.includes('\0') || !hasValidUtf8(password)) return 'invalid'
  const match = bcryptPattern.exec(stored)
  if (match) {
    const cost = Number(match[1])
    if (cost < PASSWORD_COST || cost > 14 || encoder.encode(password).length > PASSWORD_MAX_BYTES) return 'invalid'
    try {
      return bcrypt.compareSync(password, stored) ? 'match' : 'invalid'
    } catch {
      return 'invalid'
    }
  }
  if (legacyPattern.test(stored) && Number(stored) <= 65535) {
    return legacyHash(password) === Number(stored) ? 'legacy' : 'invalid'
  }
  return 'invalid'
}

export const decodePasswordBytes = (bytes: Uint8Array): string | null => {
  try {
    return strictDecoder.decode(bytes)
  } catch {
    return null
  }
}
