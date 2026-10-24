// Draft multi-household foundation: invitation tokens exist ONLY in central
// identity SQLite, never in household calendars. NOT wired to public HTTP.
// Trusted gateway callers must supply server-verified account IDs; never copy
// an untrusted user/household selector directly from a browser request.
import { createHash, randomBytes } from 'node:crypto'
import { createHouseholdMembershipTables } from './household-memberships.mjs'
import { hashFamilyPassword } from './family-auth.mjs'

const VALID_HOUSEHOLD = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const VALID_USERNAME = /^[a-zA-Z0-9._-]{3,40}$/
const VALID_TOKEN = /^[a-f0-9]{64}$/
export const INVITATION_TTL_MS = 72 * 60 * 60 * 1000

function requireId(id, name) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid ' + name + '.')
  return id
}

function requireHousehold(id) {
  if (typeof id !== 'string' || !VALID_HOUSEHOLD.test(id)) {
    throw new Error('Invalid household ID.')
  }
  return id
}

function validNow(now) {
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('Invalid clock.')
  return now
}

function digest(token) {
  return createHash('sha256').update(token).digest('hex')
}

// This schema is additive. The old users, sessions, household memberships,
// people, events and lists are never altered or copied.
export function createHouseholdInvitationTables(identityDatabase) {
  createHouseholdMembershipTables(identityDatabase)
  identityDatabase.exec(`
    CREATE TABLE IF NOT EXISTS household_member_invitations (
      id INTEGER PRIMARY KEY,
      household_id INTEGER NOT NULL REFERENCES household_registry(id) ON DELETE CASCADE,
      issuer_user_id INTEGER NOT NULL REFERENCES family_users(id),
      token_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role = 'member'),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
      revoked_at INTEGER,
      redeemed_at INTEGER,
      redeemed_user_id INTEGER REFERENCES family_users(id),
      CHECK((redeemed_at IS NULL) = (redeemed_user_id IS NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS household_member_invites_household_idx
      ON household_member_invitations(household_id, created_at);
  `)
}

function activeOwner(identityDatabase, householdId, userId) {
  return identityDatabase.prepare(`
    SELECT h.id AS householdKey, h.display_name AS displayName
    FROM household_registry h
    JOIN household_memberships m ON m.household_id = h.id
    JOIN family_users u ON u.id = m.user_id
    WHERE h.storage_id = ? AND m.user_id = ?
      AND h.disabled = 0 AND m.disabled = 0 AND u.disabled = 0
      AND u.account_kind = 'person' AND m.role = 'owner'
  `).get(householdId, userId)
}

function ownerOrThrow(identityDatabase, householdId, userId) {
  const owner = activeOwner(identityDatabase, requireHousehold(householdId),
    requireId(userId, 'verified owner'))
  if (!owner) throw new Error('Active household owner permission required.')
  return owner
}

function transaction(identityDatabase, callback) {
  identityDatabase.exec('BEGIN IMMEDIATE')
  try {
    const value = callback()
    identityDatabase.exec('COMMIT')
    return value
  } catch (error) {
    identityDatabase.exec('ROLLBACK')
    throw error
  }
}

/** Owner-only, 72-hour member invitation. Return raw token exactly once. */
export function issueHouseholdMemberInvitation(identityDatabase, {
  householdId, serverVerifiedIssuerUserId, now = Date.now(), role = 'member',
}) {
  validNow(now)
  if (role !== 'member') throw new Error('Invitation cannot confer owner or hub privileges.')
  const token = randomBytes(32).toString('hex')
  const result = transaction(identityDatabase, () => {
    const owner = ownerOrThrow(identityDatabase, householdId, serverVerifiedIssuerUserId)
    const pending = identityDatabase.prepare(`
      SELECT COUNT(*) AS count FROM household_member_invitations
      WHERE household_id = ? AND revoked_at IS NULL AND redeemed_at IS NULL
        AND expires_at > ?
    `).get(owner.householdKey, now).count
    if (pending >= 20) throw new Error('Too many active invitations for this household.')
    const recent = identityDatabase.prepare(`
      SELECT COUNT(*) AS count FROM household_member_invitations
      WHERE issuer_user_id = ? AND created_at > ? AND created_at <= ?
    `).get(serverVerifiedIssuerUserId, now - 60 * 60 * 1000, now).count
    if (recent >= 5) throw new Error('Too many invitations. Try again later.')
    const issued = identityDatabase.prepare(`
      INSERT INTO household_member_invitations
        (household_id, issuer_user_id, token_hash, role, created_at, expires_at)
      VALUES (?, ?, ?, 'member', ?, ?)
    `).run(owner.householdKey, serverVerifiedIssuerUserId, digest(token),
      now, now + INVITATION_TTL_MS)
    return Number(issued.lastInsertRowid)
  })
  return { invitationId: result, token, expiresAt: now + INVITATION_TTL_MS }
}

/** Owner-only metadata, never token hashes or raw invitation secrets. */
export function listHouseholdMemberInvitations(identityDatabase, {
  householdId, serverVerifiedOwnerUserId, now = Date.now(),
}) {
  validNow(now)
  const owner = ownerOrThrow(identityDatabase, householdId, serverVerifiedOwnerUserId)
  return identityDatabase.prepare(`
    SELECT id, created_at AS createdAt, expires_at AS expiresAt
    FROM household_member_invitations
    WHERE household_id = ? AND revoked_at IS NULL AND redeemed_at IS NULL
      AND expires_at > ?
    ORDER BY created_at DESC, id DESC
  `).all(owner.householdKey, now)
}

/** Revoke a pending invitation only in the verified owner's household. */
export function revokeHouseholdMemberInvitation(identityDatabase, {
  householdId, serverVerifiedOwnerUserId, invitationId, now = Date.now(),
}) {
  validNow(now)
  const inviteId = requireId(invitationId, 'invitation')
  return transaction(identityDatabase, () => {
    const owner = ownerOrThrow(identityDatabase, householdId, serverVerifiedOwnerUserId)
    return identityDatabase.prepare(`
      UPDATE household_member_invitations SET revoked_at = ?
      WHERE id = ? AND household_id = ?
        AND revoked_at IS NULL AND redeemed_at IS NULL AND expires_at > ?
    `).run(now, inviteId, owner.householdKey, now).changes === 1
  })
}

/**
 * Signup by bearer token. The token is the ONLY household locator: callers
 * cannot choose a household or permission by POST body. No login cookie is
 * issued here; the recipient signs in normally after redemption.
 *
 * The verified invite, new account, grant and consumed token commit in ONE
 * SQLite transaction, preventing half-created accounts or replay races.
 */
export function redeemHouseholdMemberInvitation(identityDatabase, {
  token, username, displayName, password, now = Date.now(),
}) {
  validNow(now)
  if (typeof token !== 'string' || !VALID_TOKEN.test(token)) {
    throw new Error('Invalid or expired invitation.')
  }
  if (typeof username !== 'string' || !VALID_USERNAME.test(username)) {
    throw new Error('Username must be 3–40 letters, digits, dots, dashes or underscores.')
  }
  if (typeof displayName !== 'string' || !displayName.trim() ||
      displayName.trim().length > 80) {
    throw new Error('Display name must be 1–80 characters.')
  }
  const normalizedUsername = username.toLowerCase()
  const key = digest(token)
  const current = identityDatabase.prepare(`
    SELECT i.id, h.storage_id AS householdId
    FROM household_member_invitations i
    JOIN household_registry h ON h.id = i.household_id
    JOIN household_memberships m
      ON m.household_id = i.household_id AND m.user_id = i.issuer_user_id
    JOIN family_users u ON u.id = i.issuer_user_id
    WHERE i.token_hash = ? AND i.expires_at > ?
      AND i.revoked_at IS NULL AND i.redeemed_at IS NULL
      AND h.disabled = 0 AND m.disabled = 0 AND m.role = 'owner'
      AND u.disabled = 0 AND u.account_kind = 'person'
  `).get(key, now)
  if (!current) throw new Error('Invalid or expired invitation.')
  // Expensive password derivation is done outside the write transaction.
  const passwordHash = hashFamilyPassword(password)
  return transaction(identityDatabase, () => {
    // Recheck the token and authority under the SQLite write lock.
    const valid = identityDatabase.prepare(`
      SELECT i.id, i.household_id AS householdKey, h.storage_id AS householdId
      FROM household_member_invitations i
      JOIN household_registry h ON h.id = i.household_id
      JOIN household_memberships m
        ON m.household_id = i.household_id AND m.user_id = i.issuer_user_id
      JOIN family_users u ON u.id = i.issuer_user_id
      WHERE i.id = ? AND i.token_hash = ? AND i.expires_at > ?
        AND i.revoked_at IS NULL AND i.redeemed_at IS NULL
        AND h.disabled = 0 AND m.disabled = 0 AND m.role = 'owner'
        AND u.disabled = 0 AND u.account_kind = 'person'
    `).get(current.id, key, now)
    if (!valid) throw new Error('Invalid or expired invitation.')
    const user = identityDatabase.prepare(`
      INSERT INTO family_users(username, display_name, password_hash, account_kind)
      VALUES (?, ?, ?, 'person')
    `).run(normalizedUsername, displayName.trim(), passwordHash)
    const userId = Number(user.lastInsertRowid)
    identityDatabase.prepare(`
      INSERT INTO household_memberships(user_id, household_id, role)
      VALUES (?, ?, 'member')
    `).run(userId, valid.householdKey)
    const consumed = identityDatabase.prepare(`
      UPDATE household_member_invitations SET redeemed_at = ?, redeemed_user_id = ?
      WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL
        AND expires_at > ?
    `).run(now, userId, current.id, now).changes
    if (consumed !== 1) throw new Error('Invalid or expired invitation.')
    return { userId, householdId: valid.householdId, role: 'member' }
  })
}
