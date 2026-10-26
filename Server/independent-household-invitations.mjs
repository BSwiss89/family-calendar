// PRIVATE multi-household gateway only. Separate from existing member invitations.
// No public signup, browser-selectable roles, or automatic backend activation.
import { createHash, randomBytes } from 'node:crypto'
import { hashFamilyPassword } from './family-auth.mjs'
import { createHouseholdMembershipTables } from './household-memberships.mjs'
import { provisionEmptyHousehold } from './household-storage.mjs'

const TOKEN = /^[a-f0-9]{64}$/
const USERNAME = /^[a-zA-Z0-9._-]{3,40}$/
export const INDEPENDENT_INVITATION_TTL_MS = 72 * 60 * 60 * 1000
const hash = token => createHash('sha256').update(token).digest('hex')
function validNow(now) {
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('Invalid clock.')
}
function trustedAdmin(db, userId, allowlist) {
  return Number.isSafeInteger(userId) && userId > 0 &&
    Array.isArray(allowlist) && allowlist.includes(userId) &&
    Boolean(db.prepare(
      "SELECT id FROM family_users WHERE id = ? AND disabled = 0 AND account_kind = 'person'"
    ).get(userId))
}
function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE')
  try { const result = action(); db.exec('COMMIT'); return result }
  catch (error) { db.exec('ROLLBACK'); throw error }
}
export function createIndependentHouseholdInvitationTables(db) {
  createHouseholdMembershipTables(db)
  db.exec([
    'CREATE TABLE IF NOT EXISTS independent_household_invitations (',
    'id INTEGER PRIMARY KEY,',
    'issuer_user_id INTEGER NOT NULL REFERENCES family_users(id),',
    'token_hash TEXT NOT NULL UNIQUE,',
    'created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at > created_at),',
    'revoked_at INTEGER, redeemed_at INTEGER,',
    'redeemed_user_id INTEGER REFERENCES family_users(id),',
    'household_id INTEGER REFERENCES household_registry(id),',
    'CHECK((redeemed_at IS NULL) = (redeemed_user_id IS NULL)),',
    'CHECK((redeemed_at IS NULL) = (household_id IS NULL))',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS independent_invites_issuer_idx',
    'ON independent_household_invitations(issuer_user_id, created_at);',
  ].join('\n'))
}
export function issueIndependentHouseholdInvitation(db, {
  serverVerifiedAdministratorUserId, trustedAdministratorUserIds, now = Date.now(),
}) {
  validNow(now)
  const token = randomBytes(32).toString('hex')
  const invitationId = transaction(db, () => {
    if (!trustedAdmin(db, serverVerifiedAdministratorUserId, trustedAdministratorUserIds)) {
      throw new Error('Trusted calendar administrator permission required.')
    }
    const pending = db.prepare([
      'SELECT COUNT(*) AS n FROM independent_household_invitations WHERE',
      'issuer_user_id = ? AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at > ?',
    ].join(' ')).get(serverVerifiedAdministratorUserId, now).n
    const recent = db.prepare([
      'SELECT COUNT(*) AS n FROM independent_household_invitations WHERE',
      'issuer_user_id = ? AND created_at > ? AND created_at <= ?',
    ].join(' ')).get(serverVerifiedAdministratorUserId, now - 3600000, now).n
    if (pending >= 10 || recent >= 3) throw new Error('Independent household invitation limit reached.')
    return Number(db.prepare([
      'INSERT INTO independent_household_invitations',
      '(issuer_user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ].join(' ')).run(serverVerifiedAdministratorUserId, hash(token), now,
      now + INDEPENDENT_INVITATION_TTL_MS).lastInsertRowid)
  })
  return { invitationId, token, expiresAt: now + INDEPENDENT_INVITATION_TTL_MS }
}
export function revokeIndependentHouseholdInvitation(db, {
  serverVerifiedAdministratorUserId, trustedAdministratorUserIds,
  invitationId, now = Date.now(),
}) {
  validNow(now)
  if (!Number.isSafeInteger(invitationId) || invitationId < 1) throw new Error('Invalid invitation.')
  return transaction(db, () => {
    if (!trustedAdmin(db, serverVerifiedAdministratorUserId, trustedAdministratorUserIds)) {
      throw new Error('Trusted calendar administrator permission required.')
    }
    return db.prepare([
      'UPDATE independent_household_invitations SET revoked_at = ?',
      'WHERE id = ? AND issuer_user_id = ? AND redeemed_at IS NULL',
      'AND revoked_at IS NULL AND expires_at > ?',
    ].join(' ')).run(now, invitationId, serverVerifiedAdministratorUserId, now).changes === 1
  })
}
/**
 * One-time registration of a NEW owner's independent storage and login.
 * Identity registry, account, owner membership, and invite redemption are one
 * SQLite transaction. The filesystem cannot join that transaction: on an
 * interrupted write, newly created storage may remain as an inaccessible,
 * unregistered orphan. Never silently reuse or delete it.
 *
 * New household backends are NOT started or added to gateway routing here.
 */
export function redeemIndependentHouseholdInvitation(db, {
  token, username, displayName, password, householdName,
  trustedAdministratorUserIds, serverDirectory, storageRoot, now = Date.now(),
}) {
  validNow(now)
  if (typeof token !== 'string' || !TOKEN.test(token)) {
    throw new Error('Invalid or expired invitation.')
  }
  if (typeof username !== 'string' || !USERNAME.test(username) ||
      typeof displayName !== 'string' || !displayName.trim() ||
      displayName.trim().length > 80 || typeof householdName !== 'string' ||
      !householdName.trim() || householdName.trim().length > 80) {
    throw new Error('Invalid registration fields.')
  }
  const invite = db.prepare([
    'SELECT id, issuer_user_id AS issuerId FROM independent_household_invitations',
    'WHERE token_hash = ? AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at > ?',
  ].join(' ')).get(hash(token), now)
  if (!invite || !trustedAdmin(db, invite.issuerId, trustedAdministratorUserIds)) {
    throw new Error('Invalid or expired invitation.')
  }
  const passwordHash = hashFamilyPassword(password)
  return transaction(db, () => {
    const valid = db.prepare([
      'SELECT id, issuer_user_id AS issuerId FROM independent_household_invitations',
      'WHERE id = ? AND token_hash = ? AND revoked_at IS NULL',
      'AND redeemed_at IS NULL AND expires_at > ?',
    ].join(' ')).get(invite.id, hash(token), now)
    if (!valid || !trustedAdmin(db, valid.issuerId, trustedAdministratorUserIds)) {
      throw new Error('Invalid or expired invitation.')
    }
    const normalized = username.toLowerCase()
    if (db.prepare('SELECT 1 FROM family_users WHERE username = ?').get(normalized)) {
      throw new Error('Username unavailable.')
    }
    // This new random 96-bit ID cannot be influenced by the browser.
    const householdId = 'family-' + randomBytes(12).toString('hex')
    if (db.prepare('SELECT id FROM household_registry WHERE storage_id = ?').get(householdId)) {
      throw new Error('Household identifier collision.')
    }
    provisionEmptyHousehold({ serverDirectory, storageRoot, householdId })
    const registry = db.prepare(
      'INSERT INTO household_registry(storage_id, display_name) VALUES (?, ?)'
    ).run(householdId, householdName.trim())
    const account = db.prepare([
      'INSERT INTO family_users(username, display_name, password_hash, account_kind)',
      "VALUES (?, ?, ?, 'person')",
    ].join(' ')).run(normalized, displayName.trim(), passwordHash)
    const userId = Number(account.lastInsertRowid)
    const householdKey = Number(registry.lastInsertRowid)
    db.prepare([
      'INSERT INTO household_memberships(user_id, household_id, role)',
      "VALUES (?, ?, 'owner')",
    ].join(' ')).run(userId, householdKey)
    const changed = db.prepare([
      'UPDATE independent_household_invitations',
      'SET redeemed_at = ?, redeemed_user_id = ?, household_id = ?',
      'WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?',
    ].join(' ')).run(now, userId, householdKey, invite.id, now).changes
    if (changed !== 1) throw new Error('Invalid or expired invitation.')
    return { userId, householdId, role: 'owner', activation: 'pending' }
  })
}
