// PRIVATE integration-only: central operator-approved activation records.
// Registration is never activation. Persist only an approved generated
// household ID; private backend tokens and ports are reissued each boot.
// No browser endpoint, production scheduler, or untrusted filesystem scanning.
const NEW_ID = /^family-[0-9a-f]{24}$/

export function createPrivateActivationRecords(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS private_activated_households (',
    'household_id INTEGER PRIMARY KEY REFERENCES household_registry(id),',
    'approved_at INTEGER NOT NULL',
    ') STRICT;',
  ].join(' '))
}

function activeInvitedOwner(db, householdId) {
  if (typeof householdId !== 'string' || !NEW_ID.test(householdId)) return null
  return db.prepare([
    'SELECT h.id FROM household_registry h',
    'JOIN independent_household_invitations i ON i.household_id = h.id',
    'JOIN family_users u ON u.id = i.redeemed_user_id',
    'JOIN household_memberships m ON m.user_id = u.id AND m.household_id = h.id',
    'WHERE h.storage_id = ? AND h.disabled = 0 AND u.disabled = 0',
    "AND m.role = 'owner' AND m.disabled = 0",
    'AND i.redeemed_at IS NOT NULL AND i.revoked_at IS NULL LIMIT 1',
  ].join(' ')).get(householdId)
}

/** Called only after a separate, verified loopback backend is healthy. */
export function approvePrivateHouseholdActivation(db, { householdId, now = Date.now() }) {
  if (!Number.isSafeInteger(now) || now < 1) {
    throw new Error('Invalid activation timestamp.')
  }
  const owner = activeInvitedOwner(db, householdId)
  if (!owner) throw new Error('Activation requires an active invited household owner.')
  const result = db.prepare([
    'INSERT OR IGNORE INTO private_activated_households(household_id, approved_at)',
    'VALUES (?, ?)',
  ].join(' ')).run(owner.id, now)
  if (result.changes !== 1) throw new Error('Household was already approved for activation.')
  return { householdId, approvedAt: now }
}

/** Trusted supervisor uses these IDs to decide what to restart; never a browser. */
export function listApprovedPrivateHouseholds(db) {
  const approved = db.prepare([
    'SELECT h.storage_id AS householdId FROM private_activated_households a',
    'JOIN household_registry h ON h.id = a.household_id',
    'WHERE h.disabled = 0 ORDER BY h.storage_id',
  ].join(' ')).all()
  return approved.filter(row => activeInvitedOwner(db, row.householdId))
    .map(row => row.householdId)
}

export function assertApprovedPrivateHousehold(db, householdId) {
  if (!NEW_ID.test(householdId)) return
  const approved = db.prepare([
    'SELECT 1 FROM private_activated_households a',
    'JOIN household_registry h ON h.id = a.household_id',
    'WHERE h.storage_id = ? AND h.disabled = 0',
  ].join(' ')).get(householdId)
  if (!approved || !activeInvitedOwner(db, householdId)) {
    throw new Error('Independent household backend was not previously activated.')
  }
}
