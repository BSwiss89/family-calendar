// Synthetic central identity only. No Windows services, real device logins,
// LIVE or TEST data, backup files, public routes or port listeners are used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { setFamilyAccount } from '../Server/family-auth.mjs'
import {
  grantHouseholdMembership, getSoleActiveHouseholdOwner,
  createHouseholdMembershipTables, registerHousehold,
} from '../Server/household-memberships.mjs'
import { createIndependentHouseholdInvitationTables } from '../Server/independent-household-invitations.mjs'
import {
  createPrivateActivationRecords, approvePrivateHouseholdActivation,
  listApprovedPrivateHouseholds, assertApprovedPrivateHousehold,
} from '../Server/private-household-activation-records.mjs'

const family = 'family-' + 'c'.repeat(24)
const password = 'Disposable-Only-Single-Owner-Security-Test-2026!'

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  createIndependentHouseholdInvitationTables(db)
  createPrivateActivationRecords(db)
  for (const [user, label, kind] of [
    ['originalowner', 'Invited Owner', 'person'],
    ['otherowner', 'Second Person', 'person'],
    ['countertophub', 'Shared Home', 'hub'],
  ]) setFamilyAccount(db, user, label, password,
    kind === 'hub' ? { accountKind: 'hub' } : undefined)
  const ids = Object.fromEntries(db.prepare(
    'SELECT id, username FROM family_users'
  ).all().map(row => [row.username, row.id]))
  const householdKey = registerHousehold(db, {
    householdId: family, displayName: 'Disposable invited family',
  })
  grantHouseholdMembership(db, {
    serverVerifiedUserId: ids.originalowner, householdId: family, role: 'owner',
  })
  db.prepare([
    'INSERT INTO independent_household_invitations',
    '(issuer_user_id, token_hash, created_at, expires_at, redeemed_at,',
    'redeemed_user_id, household_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ].join(' ')).run(ids.otherowner, 'e'.repeat(64), 1, 100000000000, 2,
    ids.originalowner, householdKey)
  return { db, ids, householdKey }
}

test('original invited Person is the only valid Owner for trusted approval and restart', t => {
  const { db, ids } = fixture(t)
  assert.equal(getSoleActiveHouseholdOwner(db, family), ids.originalowner)
  assert.equal(getSoleActiveHouseholdOwner(db, '../../family-other'), null)
  assert.throws(() => grantHouseholdMembership(db, {
    serverVerifiedUserId: ids.otherowner, householdId: family, role: 'owner',
  }), /already has an active Owner/)
  assert.throws(() => grantHouseholdMembership(db, {
    serverVerifiedUserId: ids.countertophub,
    householdId: family, role: 'owner',
  }), /verified person login/)
  const result = approvePrivateHouseholdActivation(db, { householdId: family, now: 1234 })
  assert.equal(result.householdId, family)
  assert.deepEqual(listApprovedPrivateHouseholds(db), [family])
  assert.doesNotThrow(() => assertApprovedPrivateHousehold(db, family))
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM family_sessions").get().n, 0)
})

test('duplicate active Owner records block approval even when a legacy index was removed', t => {
  const { db, ids, householdKey } = fixture(t)
  const insert = db.prepare([
    'INSERT INTO household_memberships(user_id, household_id, role)',
    "VALUES (?, ?, 'owner')",
  ].join(' '))
  assert.throws(() => insert.run(ids.otherowner, householdKey), /UNIQUE/,
    'SQLite must enforce one active Owner even if code bypasses grant function')
  db.exec('DROP INDEX household_memberships_one_active_owner')
  insert.run(ids.otherowner, householdKey)
  assert.equal(getSoleActiveHouseholdOwner(db, family), null)
  assert.throws(() => approvePrivateHouseholdActivation(db, {
    householdId: family, now: 1234,
  }), /active invited household owner/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM private_activated_households').get().n, 0)
  assert.throws(() => createHouseholdMembershipTables(db), /UNIQUE/,
    'Migrating a conflicting central DB must not silently pick an Owner')
  const counts = db.prepare([
    "SELECT COUNT(*) AS n FROM household_memberships WHERE household_id = ?",
    "AND role = 'owner'",
  ].join(' ')).get(householdKey)
  assert.equal(counts.n, 2, 'failed migration must preserve conflicting rows')
})

test('Owner revocation or replacement never transfers the original invitation', t => {
  const { db, ids } = fixture(t)
  approvePrivateHouseholdActivation(db, { householdId: family, now: 1234 })
  db.prepare([
    "UPDATE household_memberships SET disabled = 1 WHERE user_id = ?",
  ].join(' ')).run(ids.originalowner)
  assert.equal(getSoleActiveHouseholdOwner(db, family), null)
  assert.deepEqual(listApprovedPrivateHouseholds(db), [])
  assert.throws(() => assertApprovedPrivateHousehold(db, family), /not previously activated/)
  // A new Owner account cannot inherit invitation redemption merely by
  // receiving the 'owner' role from trusted administrative provisioning.
  grantHouseholdMembership(db, {
    serverVerifiedUserId: ids.otherowner, householdId: family, role: 'owner',
  })
  assert.equal(getSoleActiveHouseholdOwner(db, family), ids.otherowner)
  assert.deepEqual(listApprovedPrivateHouseholds(db), [])
  assert.throws(() => assertApprovedPrivateHousehold(db, family), /not previously activated/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM private_activated_households').get().n,
    1, 'original approval record is kept for operator audit, but is unusable')
})

test('non-Person role corruption, disabled account and removed Owner each fail closed', t => {
  const { db, ids } = fixture(t)
  db.prepare('UPDATE household_memberships SET disabled = 1 WHERE user_id = ?')
    .run(ids.originalowner)
  assert.equal(getSoleActiveHouseholdOwner(db, family), null)
  db.prepare('UPDATE household_memberships SET disabled = 0 WHERE user_id = ?')
    .run(ids.originalowner)
  db.prepare('UPDATE family_users SET disabled = 1 WHERE id = ?')
    .run(ids.originalowner)
  assert.equal(getSoleActiveHouseholdOwner(db, family), null)
  db.prepare('UPDATE family_users SET disabled = 0 WHERE id = ?')
    .run(ids.originalowner)
  db.prepare("UPDATE family_users SET account_kind = 'hub' WHERE id = ?")
    .run(ids.originalowner)
  assert.equal(getSoleActiveHouseholdOwner(db, family), null)
  assert.throws(() => approvePrivateHouseholdActivation(db, {
    householdId: family, now: 1234,
  }), /active invited household owner/)
})
