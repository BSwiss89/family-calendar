// PRIVATE multi-household draft: saved Owner preference for the SHARED Home kiosk.
// This is NOT a PIN credential, authenticator, or permission bypass. The real
// Home kiosk must later verify its device session and implement PIN challenge
// enforcement for day-to-day actions. No personal phone uses a routine PIN.
import { createHouseholdMembershipTables } from './household-memberships.mjs'

const VALID_HOUSEHOLD = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

function activeOwner(identityDatabase, householdId, ownerUserId) {
  if (typeof householdId !== 'string' || !VALID_HOUSEHOLD.test(householdId) ||
      !Number.isSafeInteger(ownerUserId) || ownerUserId < 1) {
    throw new Error('Active household Owner required.')
  }
  const row = identityDatabase.prepare([
    'SELECT h.id AS householdKey FROM household_registry h',
    'JOIN household_memberships m ON m.household_id = h.id',
    'JOIN family_users u ON u.id = m.user_id',
    "WHERE h.storage_id = ? AND h.disabled = 0 AND m.user_id = ?",
    "AND m.role = 'owner' AND m.disabled = 0 AND u.disabled = 0",
    "AND u.account_kind = 'person'",
  ].join(' ')).get(householdId, ownerUserId)
  if (!row) throw new Error('Active household Owner required.')
  return row.householdKey
}

export function createPrivateHomePinPolicyTables(identityDatabase) {
  createHouseholdMembershipTables(identityDatabase)
  identityDatabase.exec([
    'CREATE TABLE IF NOT EXISTS private_home_pin_policy (',
    'household_id INTEGER PRIMARY KEY REFERENCES household_registry(id) ON DELETE CASCADE,',
    'pin_enabled INTEGER NOT NULL CHECK(pin_enabled IN (0,1)),',
    'updated_by_user_id INTEGER NOT NULL REFERENCES family_users(id),',
    'updated_at INTEGER NOT NULL',
    ') STRICT;',
  ].join(' '))
}

// Default is PIN ON for any household not yet configured; a missing row
// must never silently mean "PIN disabled." This getter is Owner-scoped.
export function readPrivateHomePinPolicy(identityDatabase, {
  householdId, serverVerifiedOwnerUserId,
}) {
  createPrivateHomePinPolicyTables(identityDatabase)
  const householdKey = activeOwner(
    identityDatabase, householdId, serverVerifiedOwnerUserId
  )
  const row = identityDatabase.prepare(
    'SELECT pin_enabled FROM private_home_pin_policy WHERE household_id = ?'
  ).get(householdKey)
  return { pinEnabled: row ? row.pin_enabled === 1 : true }
}

// A caller must have verified the Owner PASSWORD on this exact request.
// Recheck household ownership inside the write transaction, because session
// membership might have been revoked while asynchronous password verification
// was running. The setting NEVER grants administrator/member rights.
export function setPrivateHomePinPolicy(identityDatabase, {
  householdId, serverVerifiedOwnerUserId, pinEnabled, now = Date.now(),
}) {
  if (typeof pinEnabled !== 'boolean') {
    throw new Error('Shared Home PIN setting must be a boolean.')
  }
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new Error('Invalid shared Home PIN setting timestamp.')
  }
  createPrivateHomePinPolicyTables(identityDatabase)
  identityDatabase.exec('BEGIN IMMEDIATE')
  try {
    const householdKey = activeOwner(
      identityDatabase, householdId, serverVerifiedOwnerUserId
    )
    identityDatabase.prepare([
      'INSERT INTO private_home_pin_policy',
      '(household_id, pin_enabled, updated_by_user_id, updated_at)',
      'VALUES (?, ?, ?, ?) ON CONFLICT(household_id)',
      'DO UPDATE SET pin_enabled=excluded.pin_enabled,',
      'updated_by_user_id=excluded.updated_by_user_id,',
      'updated_at=excluded.updated_at',
    ].join(' ')).run(householdKey, pinEnabled ? 1 : 0,
      serverVerifiedOwnerUserId, now)
    // PIN off/on switches invalidate any previously verified kiosk actor
    // proofs. The optional credential tables may not exist in older drafts.
    const proofTable = identityDatabase.prepare([
      "SELECT name FROM sqlite_master WHERE type='table'",
      "AND name='private_home_actor_proofs'",
    ].join(' ')).get()
    if (proofTable) {
      identityDatabase.prepare(
        'DELETE FROM private_home_actor_proofs WHERE household_id=?'
      ).run(householdKey)
    }
    identityDatabase.exec('COMMIT')
    return { pinEnabled }
  } catch (error) {
    identityDatabase.exec('ROLLBACK')
    throw error
  }
}
