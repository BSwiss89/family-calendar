// Short-lived Owner password re-verification for security-sensitive family
// member administration. A remembered personal-device session never skips
// this check. PINs are for a separately verified shared Home kiosk, not phones.
import { verifyFamilyPassword } from './family-auth.mjs'

export function createOwnerPasswordStepUp({
  now = Date.now, windowMs = 15 * 60 * 1000, maxFailures = 5,
  maxConcurrent = 4, maxIdentities = 512,
} = {}) {
  const failures = new Map()
  let checking = 0

  async function verify(identityDatabase, { serverVerifiedUserId, password }) {
    if (!Number.isSafeInteger(serverVerifiedUserId) || serverVerifiedUserId < 1) {
      return { status: 'denied' }
    }
    const timestamp = now()
    // Bound memory even when old sessions are retained or clients reconnect.
    for (const [key, record] of failures) {
      if (timestamp - record.started >= windowMs) failures.delete(key)
    }
    const key = failures.has(serverVerifiedUserId) || failures.size < maxIdentities
      ? serverVerifiedUserId : -1
    let record = failures.get(key)
    if (!record) {
      record = { started: timestamp, count: 0 }
      failures.set(key, record)
    }
    if (record.count >= maxFailures) {
      return {
        status: 'limited',
        retryAfter: Math.max(1, Math.ceil((windowMs - (timestamp - record.started)) / 1000)),
      }
    }
    if (checking >= maxConcurrent) return { status: 'busy' }

    // Count BEFORE waiting for scrypt so concurrent requests cannot bypass
    // the limit. Keep the password out of errors, logs and response bodies.
    record.count++
    if (typeof password !== 'string' || password.length < 1 || password.length > 200) {
      return { status: 'denied' }
    }
    checking++
    try {
      const account = identityDatabase.prepare([
        'SELECT password_hash FROM family_users',
        "WHERE id = ? AND disabled = 0 AND account_kind = 'person'",
      ].join(' ')).get(serverVerifiedUserId)
      const valid = await verifyFamilyPassword(password, account?.password_hash)
      if (!account || !valid) return { status: 'denied' }
      failures.delete(key)
      return { status: 'verified' }
    } finally {
      checking--
    }
  }

  return { verify }
}
