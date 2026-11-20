// Private-gateway first slice: administrator-assisted account recovery.
// Recovery never reads/changes a household calendar, never grants household
// membership, and never emails a reset secret. The operator verifies identity
// outside the app before issuing a short-lived one-use link.
// No plaintext passwords, reset bearer tokens or session cookies are persisted.
import { createHash, randomBytes } from 'node:crypto'
import { createFamilyAuthTables, hashFamilyPassword } from './family-auth.mjs'

export const RECOVERY_REQUEST_TTL_MS = 24 * 60 * 60 * 1000
export const RECOVERY_LINK_TTL_MS = 30 * 60 * 1000
const TOKEN = /^[a-f0-9]{64}$/
const USERNAME = /^[a-zA-Z0-9._-]{3,40}$/
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const digest = value => createHash('sha256').update(value).digest('hex')

function requireTime(now) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid recovery clock.')
}
function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = action()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
export function createFamilyPasswordRecoveryTables(db) {
  createFamilyAuthTables(db)
  db.exec([
    'CREATE TABLE IF NOT EXISTS family_recovery_requests (',
    'id INTEGER PRIMARY KEY,',
    'user_id INTEGER NOT NULL REFERENCES family_users(id),',
    "state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','issued','denied','redeemed','revoked')),",
    'created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,',
    'decided_by INTEGER REFERENCES family_users(id), decided_at INTEGER,',
    'token_hash TEXT UNIQUE, token_expires_at INTEGER, redeemed_at INTEGER,',
    'CHECK(expires_at > created_at),',
    "CHECK((state != 'issued') OR (token_hash IS NOT NULL AND token_expires_at IS NOT NULL))",
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS family_recovery_user_idx',
    'ON family_recovery_requests(user_id, created_at);',
    'CREATE INDEX IF NOT EXISTS family_recovery_pending_idx',
    'ON family_recovery_requests(state, expires_at);',
    // A contact is optional and UNVERIFIED until a separate challenge flow
    // proves control of the mailbox. It cannot be used to reset a password.
    'CREATE TABLE IF NOT EXISTS family_recovery_contacts (',
    'user_id INTEGER PRIMARY KEY REFERENCES family_users(id) ON DELETE CASCADE,',
    'email TEXT NOT NULL, verified_at INTEGER, updated_at INTEGER NOT NULL',
    ') STRICT;',
  ].join('\n'))
}
function assertOperator(db, userId, trustedAdministratorUserIds) {
  if (!Number.isSafeInteger(userId) || userId <= 0 ||
      !Array.isArray(trustedAdministratorUserIds) ||
      !trustedAdministratorUserIds.includes(userId) ||
      !db.prepare([
        'SELECT id FROM family_users',
        "WHERE id = ? AND disabled = 0 AND account_kind = 'person'",
      ].join(' ')).get(userId)) {
    throw new Error('Trusted system administrator required.')
  }
}

export function requestFamilyPasswordRecovery(db, { username, now = Date.now() }) {
  requireTime(now)
  // No observable account-existence result; the public HTTP handler always
  // responds the same way for a well-formed username, known or unknown.
  const normalized = typeof username === 'string' && USERNAME.test(username)
    ? username.toLowerCase() : null
  if (!normalized) return { accepted: true }
  const user = db.prepare([
    'SELECT id FROM family_users',
    "WHERE username = ? AND disabled = 0 AND account_kind = 'person'",
  ].join(' ')).get(normalized)
  if (!user) return { accepted: true }
  transaction(db, () => {
    // Never flood an operator with requests from an account. A recently
    // issued, denied, or pending request also holds this one-hour cooldown.
    const recent = db.prepare([
      'SELECT id FROM family_recovery_requests',
      'WHERE user_id = ? AND created_at > ? ORDER BY id DESC LIMIT 1',
    ].join(' ')).get(user.id, now - 60 * 60 * 1000)
    if (!recent) {
      db.prepare([
        'INSERT INTO family_recovery_requests(user_id, created_at, expires_at)',
        'VALUES (?, ?, ?)',
      ].join(' ')).run(user.id, now, now + RECOVERY_REQUEST_TTL_MS)
    }
  })
  return { accepted: true }
}

export function listPendingFamilyPasswordRecovery(db, {
  serverVerifiedAdministratorUserId, trustedAdministratorUserIds,
  now = Date.now(),
}) {
  requireTime(now)
  assertOperator(db, serverVerifiedAdministratorUserId, trustedAdministratorUserIds)
  return db.prepare([
    'SELECT r.id, r.created_at AS createdAt, r.expires_at AS expiresAt,',
    'u.username, u.display_name AS displayName',
    'FROM family_recovery_requests r JOIN family_users u ON u.id = r.user_id',
    "WHERE r.state = 'pending' AND r.expires_at > ? AND u.disabled = 0",
    "AND u.account_kind = 'person'",
    'ORDER BY r.created_at, r.id LIMIT 100',
  ].join(' ')).all(now).map(x => ({ ...x }))
}

export function issueFamilyPasswordResetLink(db, {
  serverVerifiedAdministratorUserId, trustedAdministratorUserIds,
  recoveryRequestId, verifiedOutOfBand, now = Date.now(),
}) {
  requireTime(now)
  if (!Number.isSafeInteger(recoveryRequestId) || recoveryRequestId <= 0 ||
      verifiedOutOfBand !== true) {
    throw new Error('Verified recovery request and independent identity check required.')
  }
  const token = randomBytes(32).toString('hex')
  const expiresAt = now + RECOVERY_LINK_TTL_MS
  const result = transaction(db, () => {
    assertOperator(db, serverVerifiedAdministratorUserId, trustedAdministratorUserIds)
    const request = db.prepare([
      'SELECT r.id, r.user_id AS userId FROM family_recovery_requests r',
      'JOIN family_users u ON u.id = r.user_id',
      "WHERE r.id = ? AND r.state = 'pending' AND r.expires_at > ?",
      "AND u.disabled = 0 AND u.account_kind = 'person'",
    ].join(' ')).get(recoveryRequestId, now)
    if (!request) throw new Error('Recovery request is no longer pending.')
    // Old reset links cannot survive a new approved link.
    db.prepare([
      "UPDATE family_recovery_requests SET state = 'revoked', token_hash = NULL",
      "WHERE user_id = ? AND state = 'issued'",
    ].join(' ')).run(request.userId)
    const changed = db.prepare([
      "UPDATE family_recovery_requests SET state = 'issued',",
      'decided_by = ?, decided_at = ?, token_hash = ?, token_expires_at = ?',
      "WHERE id = ? AND state = 'pending'",
    ].join(' ')).run(serverVerifiedAdministratorUserId,
      now, digest(token), expiresAt, request.id).changes
    if (changed !== 1) throw new Error('Recovery request changed during approval.')
    return { requestId: request.id, expiresAt }
  })
  // Only the currently authenticated, password-reverified operator sees this
  // secret, exactly once, to deliver via a separately verified contact path.
  return { ...result, token }
}

export function denyFamilyPasswordRecovery(db, {
  serverVerifiedAdministratorUserId, trustedAdministratorUserIds,
  recoveryRequestId, now = Date.now(),
}) {
  requireTime(now)
  if (!Number.isSafeInteger(recoveryRequestId) || recoveryRequestId < 1) {
    throw new Error('Invalid recovery request.')
  }
  return transaction(db, () => {
    assertOperator(db, serverVerifiedAdministratorUserId, trustedAdministratorUserIds)
    return db.prepare([
      "UPDATE family_recovery_requests SET state = 'denied',",
      'decided_at = ?, decided_by = ?',
      "WHERE id = ? AND state = 'pending' AND expires_at > ?",
    ].join(' ')).run(now, serverVerifiedAdministratorUserId,
      recoveryRequestId, now).changes === 1
  })
}

export function completeFamilyPasswordReset(db, {
  token, newPassword, now = Date.now(),
}) {
  requireTime(now)
  if (typeof token !== 'string' || !TOKEN.test(token)) {
    throw new Error('Invalid or expired password reset link.')
  }
  // Cheap read before expensive scrypt, then transactional revalidation.
  const tokenHash = digest(token)
  const existing = db.prepare([
    'SELECT r.id FROM family_recovery_requests r',
    'JOIN family_users u ON u.id = r.user_id',
    "WHERE r.token_hash = ? AND r.state = 'issued'",
    'AND r.token_expires_at > ? AND r.expires_at > ?',
    "AND u.disabled = 0 AND u.account_kind = 'person'",
  ].join(' ')).get(tokenHash, now, now)
  if (!existing) throw new Error('Invalid or expired password reset link.')
  const passwordHash = hashFamilyPassword(newPassword)
  return transaction(db, () => {
    const valid = db.prepare([
      'SELECT r.id, r.user_id AS userId FROM family_recovery_requests r',
      'JOIN family_users u ON u.id = r.user_id',
      "WHERE r.token_hash = ? AND r.state = 'issued'",
      'AND r.token_expires_at > ? AND r.expires_at > ?',
      "AND u.disabled = 0 AND u.account_kind = 'person'",
    ].join(' ')).get(tokenHash, Date.now(), Date.now())
    if (!valid) throw new Error('Invalid or expired password reset link.')
    const updated = db.prepare([
      "UPDATE family_users SET password_hash = ? WHERE id = ? AND disabled = 0",
    ].join(' ')).run(passwordHash, valid.userId).changes
    if (updated !== 1) throw new Error('Account is no longer available.')
    // Existing personal-device cookies are invalidated immediately; the
    // person must sign in again using the new password.
    db.prepare('DELETE FROM family_sessions WHERE user_id = ?').run(valid.userId)
    db.prepare([
      "UPDATE family_recovery_requests SET state = 'redeemed',",
      'redeemed_at = ?, token_hash = NULL WHERE id = ?',
    ].join(' ')).run(Date.now(), valid.id)
    db.prepare([
      "UPDATE family_recovery_requests SET state = 'revoked', token_hash = NULL",
      "WHERE user_id = ? AND state = 'issued'",
    ].join(' ')).run(valid.userId)
    return { reset: true }
  })
}

export function readOptionalRecoveryContact(db, { serverVerifiedUserId }) {
  if (!Number.isSafeInteger(serverVerifiedUserId) || serverVerifiedUserId < 1) return null
  const member = db.prepare([
    'SELECT id FROM family_users',
    "WHERE id = ? AND disabled = 0 AND account_kind = 'person'",
  ].join(' ')).get(serverVerifiedUserId)
  if (!member) return null
  const data = db.prepare([
    'SELECT c.email, c.verified_at AS verifiedAt',
    'FROM family_recovery_contacts c JOIN family_users u ON u.id = c.user_id',
    "WHERE c.user_id = ? AND u.disabled = 0 AND u.account_kind = 'person'",
  ].join(' ')).get(serverVerifiedUserId)
  return data ? { email: data.email, verified: data.verifiedAt !== null } :
    { email: null, verified: false }
}

export function saveUnverifiedRecoveryContact(db, {
  serverVerifiedUserId, email, now = Date.now(),
}) {
  requireTime(now)
  if (!Number.isSafeInteger(serverVerifiedUserId) || serverVerifiedUserId <= 0 ||
      (email !== null && (typeof email !== 'string' ||
        email.length > 254 || !EMAIL.test(email.toLowerCase())))) {
    throw new Error('Invalid recovery email.')
  }
  const user = db.prepare([
    'SELECT id FROM family_users',
    "WHERE id = ? AND disabled = 0 AND account_kind = 'person'",
  ].join(' ')).get(serverVerifiedUserId)
  if (!user) throw new Error('Account not available.')
  if (email === null) {
    db.prepare('DELETE FROM family_recovery_contacts WHERE user_id = ?')
      .run(serverVerifiedUserId)
  } else {
    db.prepare([
      'INSERT INTO family_recovery_contacts(user_id, email, verified_at, updated_at)',
      'VALUES (?, ?, NULL, ?) ON CONFLICT(user_id)',
      'DO UPDATE SET email = excluded.email, verified_at = NULL,',
      'updated_at = excluded.updated_at',
    ].join(' ')).run(serverVerifiedUserId, email.toLowerCase(), now)
  }
  // Never treat an entered address as proof of mailbox control.
  return { email: email === null ? null : email.toLowerCase(), verified: false }
}
