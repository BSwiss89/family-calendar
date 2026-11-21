// Central household membership foundation, not connected to public HTTP.
// This store belongs to a future identity gateway, NOT to any household DB.
// A server-verified user ID is required; username, requested household, or
// cookie fields supplied by the browser NEVER confer membership on their own.
import { createFamilyAuthTables } from './family-auth.mjs'

const householdIdPattern = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

function requireHouseholdId(value) {
  if (typeof value !== 'string' || !householdIdPattern.test(value)) {
    throw new Error('Invalid household ID.')
  }
  return value
}

function requireUserId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('A valid server-verified user ID is required.')
  }
  return value
}

function requireRole(value) {
  if (!['owner', 'member'].includes(value)) {
    throw new Error('Invalid household role.')
  }
  return value
}

export function createHouseholdMembershipTables(identityDatabase) {
  // This must be called only on the dedicated CENTRAL identity SQLite DB,
  // never on the existing family's database. No caller is wired yet.
  createFamilyAuthTables(identityDatabase)
  identityDatabase.exec([
    'PRAGMA foreign_keys = ON;',
    'CREATE TABLE IF NOT EXISTS household_registry (',
    'id INTEGER PRIMARY KEY,',
    'storage_id TEXT NOT NULL UNIQUE,',
    'display_name TEXT NOT NULL,',
    'disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0, 1))',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS household_memberships (',
    'user_id INTEGER NOT NULL REFERENCES family_users(id) ON DELETE CASCADE,',
    'household_id INTEGER NOT NULL REFERENCES household_registry(id) ON DELETE CASCADE,',
    "role TEXT NOT NULL CHECK(role IN ('owner', 'member')),",
    'disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0, 1)),',
    'PRIMARY KEY (user_id, household_id)',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS household_memberships_household_idx',
    'ON household_memberships(household_id);',
    'CREATE TABLE IF NOT EXISTS household_session_selections (',
    'session_id INTEGER PRIMARY KEY REFERENCES family_sessions(id) ON DELETE CASCADE,',
    'household_id INTEGER NOT NULL REFERENCES household_registry(id) ON DELETE CASCADE,',
    'selected_at INTEGER NOT NULL',
    ') STRICT;',
  ].join('\n'))
  // A login belongs to exactly one household, including disabled memberships.
  // Index creation fails closed on legacy conflicts without deleting records.
  identityDatabase.exec('CREATE UNIQUE INDEX IF NOT EXISTS household_memberships_one_household_per_user ON household_memberships(user_id)')
  // Fail closed on legacy conflicts: one active Owner membership per family.
  // Disabled former Owners can remain for audit/transfer without conferring
  // authority. Revoking/disabling a membership precedes a new Owner grant.
  identityDatabase.exec([
    'CREATE UNIQUE INDEX IF NOT EXISTS household_memberships_one_active_owner',
    "ON household_memberships(household_id) WHERE role = 'owner' AND disabled = 0",
  ].join(' '))
}

/**
 * Offline trusted provisioning only. A registry record does NOT provision a
 * database. Gateway setup must separately verify resolveHouseholdStorage.
 * Conflicting IDs are not silently overwritten.
 */
export function registerHousehold(identityDatabase, { householdId, displayName }) {
  const id = requireHouseholdId(householdId)
  if (typeof displayName !== 'string' || !displayName.trim()
      || displayName.trim().length > 80) {
    throw new Error('Household display name must be 1–80 characters.')
  }
  createHouseholdMembershipTables(identityDatabase)
  const result = identityDatabase.prepare([
    'INSERT INTO household_registry(storage_id, display_name)',
    'VALUES (?, ?)',
  ].join(' ')).run(id, displayName.trim())
  return Number(result.lastInsertRowid)
}

/** Offline trusted administration only. NEVER bind to a public endpoint. */
export function grantHouseholdMembership(identityDatabase, {
  serverVerifiedUserId,
  householdId,
  role,
}) {
  const userId = requireUserId(serverVerifiedUserId)
  const id = requireHouseholdId(householdId)
  const grantedRole = requireRole(role)
  const target = identityDatabase.prepare([
    'SELECT id FROM household_registry',
    'WHERE storage_id = ? AND disabled = 0',
  ].join(' ')).get(id)
  if (!target) throw new Error('Requested household is not provisioned in identity registry.')
  // Reject attempts to grant a disabled account rather than creating dormant
  // memberships silently.
  const account = identityDatabase.prepare(
    'SELECT id, account_kind AS accountKind FROM family_users WHERE id = ? AND disabled = 0'
  ).get(userId)
  if (!account) throw new Error('Account not found or disabled.')
  if (grantedRole === 'owner') {
    if (account.accountKind !== 'person') {
      throw new Error('Only a verified person login can be the household Owner.')
    }
    if (identityDatabase.prepare([
      'SELECT 1 FROM household_memberships',
      "WHERE household_id = ? AND role = 'owner' AND disabled = 0 LIMIT 1",
    ].join(' ')).get(target.id)) {
      throw new Error('Household already has an active Owner.')
    }
  }
  identityDatabase.prepare([
    'INSERT INTO household_memberships(user_id, household_id, role)',
    'VALUES (?, ?, ?)',
  ].join(' ')).run(userId, target.id, grantedRole)
}

/**
 * Trusted internal read-only invariant. Browser-selected People profiles,
 * usernames and household IDs do NOT grant Owner authority. A family has a
 * usable sole Owner only when exactly one active Person account and active
 * Owner membership agree; a disabled owner or two conflicting Owners fails
 * closed. This never modifies rows or transfers ownership.
 */
export function getSoleActiveHouseholdOwner(identityDatabase, householdId) {
  if (typeof householdId !== 'string' || !householdIdPattern.test(householdId)) return null
  const owners = identityDatabase.prepare([
    'SELECT u.id AS userId FROM household_registry h',
    'JOIN household_memberships m ON m.household_id = h.id',
    'JOIN family_users u ON u.id = m.user_id',
    'WHERE h.storage_id = ? AND h.disabled = 0',
    "AND m.role = 'owner' AND m.disabled = 0",
    "AND u.disabled = 0 AND u.account_kind = 'person'",
    'LIMIT 2',
  ].join(' ')).all(householdId)
  return owners.length === 1 ? owners[0].userId : null
}

/**
 * Called ONLY after central authentication validated the server-side session.
 * Untrusted requestedHouseholdId is a filter, not proof of access. Return null
 * on any unrecognized, revoked, disabled or unauthorized combination.
 * No filesystem paths or other household names leak to an unauthorized user.
 */
export function lookupGrantedHouseholdForSessionUser(identityDatabase, {
  serverVerifiedUserId,
  requestedHouseholdId,
}) {
  if (!Number.isSafeInteger(serverVerifiedUserId) || serverVerifiedUserId <= 0
      || typeof requestedHouseholdId !== 'string'
      || !householdIdPattern.test(requestedHouseholdId)) {
    return null
  }
  const row = identityDatabase.prepare([
    'SELECT h.storage_id AS householdId, h.display_name AS displayName,',
    'm.role AS role FROM household_registry h',
    'JOIN household_memberships m ON m.household_id = h.id',
    'JOIN family_users u ON u.id = m.user_id',
    'WHERE u.id = ? AND h.storage_id = ? AND u.disabled = 0',
    'AND m.disabled = 0 AND h.disabled = 0',
  ].join(' ')).get(serverVerifiedUserId, requestedHouseholdId)
  return row ? { householdId: row.householdId, displayName: row.displayName, role: row.role } : null
}

/** Return only the households the authenticated user is explicitly granted. */
export function listGrantedHouseholdsForSessionUser(identityDatabase, {
  serverVerifiedUserId,
}) {
  if (!Number.isSafeInteger(serverVerifiedUserId) || serverVerifiedUserId <= 0) {
    return []
  }
  return identityDatabase.prepare([
    'SELECT h.storage_id AS householdId, h.display_name AS displayName,',
    'm.role AS role FROM household_registry h',
    'JOIN household_memberships m ON m.household_id = h.id',
    'JOIN family_users u ON u.id = m.user_id',
    'WHERE u.id = ? AND u.disabled = 0 AND h.disabled = 0 AND m.disabled = 0',
    'ORDER BY h.display_name, h.storage_id',
  ].join(' ')).all(serverVerifiedUserId).map(row => ({
    householdId: row.householdId,
    displayName: row.displayName,
    role: row.role,
  }))
}


/**
 * An explicit browser selection is just a preference bound to one VERIFIED
 * central-login session. It NEVER creates or grants household membership.
 * The caller must use request.familyAccount.id/user_id, not browser fields.
 *
 * Returns null without changing selection when the account, membership,
 * household, or session is inactive. Each selection is persisted per device.
 */
export function selectHouseholdForVerifiedSession(identityDatabase, {
  serverVerifiedSessionId,
  serverVerifiedUserId,
  requestedHouseholdId,
}) {
  if (!Number.isSafeInteger(serverVerifiedSessionId) || serverVerifiedSessionId <= 0
      || !Number.isSafeInteger(serverVerifiedUserId) || serverVerifiedUserId <= 0) {
    return null
  }

  const membership = lookupGrantedHouseholdForSessionUser(identityDatabase, {
    serverVerifiedUserId,
    requestedHouseholdId,
  })
  if (!membership) return null

  const session = identityDatabase.prepare([
    'SELECT id FROM family_sessions',
    'WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?',
  ].join(' ')).get(serverVerifiedSessionId, serverVerifiedUserId, Date.now())
  if (!session) return null

  const household = identityDatabase.prepare([
    'SELECT id FROM household_registry WHERE storage_id = ? AND disabled = 0',
  ].join(' ')).get(membership.householdId)
  if (!household) return null

  identityDatabase.prepare([
    'INSERT INTO household_session_selections(session_id, household_id, selected_at)',
    'VALUES (?, ?, ?)',
    'ON CONFLICT(session_id) DO UPDATE SET',
    'household_id = excluded.household_id, selected_at = excluded.selected_at',
  ].join(' ')).run(serverVerifiedSessionId, household.id, Date.now())
  return membership
}

/**
 * Fetch one device's selected household, revalidating central login, account,
 * membership and household at the time of EACH request. A revoked membership
 * or device never retains authorization through a saved selection.
 */
export function getSelectedHouseholdForVerifiedSession(identityDatabase, {
  serverVerifiedSessionId,
  serverVerifiedUserId,
}) {
  if (!Number.isSafeInteger(serverVerifiedSessionId) || serverVerifiedSessionId <= 0
      || !Number.isSafeInteger(serverVerifiedUserId) || serverVerifiedUserId <= 0) {
    return null
  }
  const row = identityDatabase.prepare([
    'SELECT h.storage_id AS householdId, h.display_name AS displayName,',
    'm.role AS role',
    'FROM household_session_selections selected',
    'JOIN family_sessions s ON s.id = selected.session_id',
    'JOIN family_users u ON u.id = s.user_id',
    'JOIN household_registry h ON h.id = selected.household_id',
    'JOIN household_memberships m ON m.user_id = s.user_id AND m.household_id = h.id',
    'WHERE selected.session_id = ? AND s.user_id = ?',
    'AND s.revoked_at IS NULL AND s.expires_at > ?',
    'AND u.disabled = 0 AND m.disabled = 0 AND h.disabled = 0',
  ].join(' ')).get(serverVerifiedSessionId, serverVerifiedUserId, Date.now())
  return row ? {
    householdId: row.householdId,
    displayName: row.displayName,
    role: row.role,
  } : null
}
