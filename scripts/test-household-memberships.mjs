import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createHouseholdMembershipTables,
  registerHousehold,
  grantHouseholdMembership,
  lookupGrantedHouseholdForSessionUser,
  listGrantedHouseholdsForSessionUser,
} from '../Server/household-memberships.mjs'

function fixture(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-membership-test-'))
  const db = new DatabaseSync(path.join(work, 'central-identity.db'))
  t.after(() => {
    db.close()
    fs.rmSync(work, { recursive: true, force: true })
  })
  createHouseholdMembershipTables(db)
  const add = db.prepare(
    'INSERT INTO family_users(username, display_name, password_hash) VALUES (?, ?, ?)'
  )
  const a = Number(add.run('family_a_owner', 'A Owner', 'test-only-unusable').lastInsertRowid)
  const b = Number(add.run('family_b_owner', 'B Owner', 'test-only-unusable').lastInsertRowid)
  const shared = Number(add.run('shared_person', 'Shared', 'test-only-unusable').lastInsertRowid)
  registerHousehold(db, { householdId: 'family-a', displayName: 'Family A' })
  registerHousehold(db, { householdId: 'family-b', displayName: 'Family B' })
  grantHouseholdMembership(db, {
    serverVerifiedUserId: a, householdId: 'family-a', role: 'owner',
  })
  grantHouseholdMembership(db, {
    serverVerifiedUserId: b, householdId: 'family-b', role: 'owner',
  })
  return { db, a, b, shared }
}

const find = (db, serverVerifiedUserId, requestedHouseholdId) =>
  lookupGrantedHouseholdForSessionUser(db, { serverVerifiedUserId, requestedHouseholdId })

test('each account sees only its own household even with a guessed valid ID', t => {
  const { db, a, b } = fixture(t)
  assert.deepEqual(find(db, a, 'family-a'), {
    householdId: 'family-a', displayName: 'Family A', role: 'owner',
  })
  assert.deepEqual(find(db, b, 'family-b'), {
    householdId: 'family-b', displayName: 'Family B', role: 'owner',
  })
  assert.equal(find(db, a, 'family-b'), null)
  assert.equal(find(db, b, 'family-a'), null)
  assert.deepEqual(listGrantedHouseholdsForSessionUser(db, { serverVerifiedUserId: a }), [
    { householdId: 'family-a', displayName: 'Family A', role: 'owner' },
  ])
  assert.deepEqual(listGrantedHouseholdsForSessionUser(db, { serverVerifiedUserId: b }), [
    { householdId: 'family-b', displayName: 'Family B', role: 'owner' },
  ])
})

test('shared household membership requires a deliberate trusted grant', t => {
  const { db, a, b, shared } = fixture(t)
  assert.equal(find(db, shared, 'family-a'), null)
  assert.equal(find(db, shared, 'family-b'), null)
  grantHouseholdMembership(db, {
    serverVerifiedUserId: shared, householdId: 'family-b', role: 'member',
  })
  assert.equal(find(db, shared, 'family-a'), null)
  assert.equal(find(db, shared, 'family-b').role, 'member')
  // Granting third-person membership does not change existing owners' access.
  assert.equal(find(db, a, 'family-b'), null)
  assert.equal(find(db, b, 'family-b').role, 'owner')
})

test('revoking membership, disabling account or household denies access immediately', t => {
  const { db, a, b } = fixture(t)
  db.prepare([
    'UPDATE household_memberships SET disabled = 1',
    'WHERE user_id = ? AND household_id =',
    '(SELECT id FROM household_registry WHERE storage_id = ?)',
  ].join(' ')).run(a, 'family-a')
  assert.equal(find(db, a, 'family-a'), null)
  assert.deepEqual(listGrantedHouseholdsForSessionUser(db, { serverVerifiedUserId: a }), [])

  db.prepare('UPDATE family_users SET disabled = 1 WHERE id = ?').run(b)
  assert.equal(find(db, b, 'family-b'), null)
  assert.deepEqual(listGrantedHouseholdsForSessionUser(db, { serverVerifiedUserId: b }), [])

  db.prepare('UPDATE family_users SET disabled = 0 WHERE id = ?').run(b)
  db.prepare('UPDATE household_registry SET disabled = 1 WHERE storage_id = ?').run('family-b')
  assert.equal(find(db, b, 'family-b'), null)
})

test('unknown, invalid, or attacker-selected household context fails closed', t => {
  const { db, a, b } = fixture(t)
  for (const id of [
    undefined, null, '', '../family-b', 'Family-B', 'family-a/../family-b',
    "family-b' OR 1=1 --", 'family-c',
  ]) {
    assert.equal(find(db, a, id), null)
  }
  for (const user of [undefined, null, 0, -1, '1', 999, 1.1]) {
    assert.equal(find(db, user, 'family-a'), null)
    assert.deepEqual(listGrantedHouseholdsForSessionUser(db, { serverVerifiedUserId: user }), [])
  }
  assert.equal(find(db, a, 'family-b'), null)
  assert.equal(find(db, b, 'family-a'), null)
})

test('trusted provisioning does not overwrite household/account grants or accept invalid roles', t => {
  const { db, a, b, shared } = fixture(t)
  assert.throws(() => registerHousehold(db, {
    householdId: 'family-a', displayName: 'Overwrite existing',
  }), /UNIQUE/)
  assert.equal(find(db, a, 'family-a').displayName, 'Family A')
  assert.throws(() => registerHousehold(db, {
    householdId: '../family-x', displayName: 'Wrong',
  }), /Invalid household ID/)
  assert.throws(() => registerHousehold(db, {
    householdId: 'family-c', displayName: '',
  }), /display name/)

  assert.throws(() => grantHouseholdMembership(db, {
    serverVerifiedUserId: shared, householdId: 'family-a', role: 'admin',
  }), /Invalid household role/)
  assert.throws(() => grantHouseholdMembership(db, {
    serverVerifiedUserId: shared, householdId: 'missing', role: 'member',
  }), /not provisioned/)
  assert.throws(() => grantHouseholdMembership(db, {
    serverVerifiedUserId: 123456, householdId: 'family-a', role: 'member',
  }), /Account not found/)
  assert.throws(() => grantHouseholdMembership(db, {
    serverVerifiedUserId: a, householdId: 'family-a', role: 'member',
  }), /UNIQUE/)
  assert.throws(() => grantHouseholdMembership(db, {
    serverVerifiedUserId: '1', householdId: 'family-a', role: 'owner',
  }), /server-verified user ID/)
  db.prepare('UPDATE family_users SET disabled = 1 WHERE id = ?').run(b)
  assert.throws(() => grantHouseholdMembership(db, {
    serverVerifiedUserId: b, householdId: 'family-a', role: 'member',
  }), /disabled/)
})


test('one account cannot belong to two households, even through direct SQL', t => {
  const { db, shared } = fixture(t)
  grantHouseholdMembership(db, {
    serverVerifiedUserId: shared, householdId: 'family-a', role: 'member',
  })
  assert.throws(() => grantHouseholdMembership(db, {
    serverVerifiedUserId: shared, householdId: 'family-b', role: 'member',
  }), /UNIQUE/)
  const other = db.prepare('SELECT id FROM household_registry WHERE storage_id = ?').get('family-b')
  assert.throws(() => db.prepare(
    'INSERT INTO household_memberships(user_id, household_id, role) VALUES (?, ?, ?)'
  ).run(shared, other.id, 'member'), /UNIQUE/)
  assert.deepEqual(listGrantedHouseholdsForSessionUser(db, { serverVerifiedUserId: shared }), [
    { householdId: 'family-a', displayName: 'Family A', role: 'member' },
  ])
})

test('conflicting legacy memberships block migration without deleting records', t => {
  const { db, shared } = fixture(t)
  db.exec('DROP INDEX household_memberships_one_household_per_user')
  const a = db.prepare('SELECT id FROM household_registry WHERE storage_id = ?').get('family-a')
  const b = db.prepare('SELECT id FROM household_registry WHERE storage_id = ?').get('family-b')
  const insert = db.prepare('INSERT INTO household_memberships(user_id, household_id, role) VALUES (?, ?, ?)')
  insert.run(shared, a.id, 'member')
  insert.run(shared, b.id, 'member')
  assert.throws(() => createHouseholdMembershipTables(db), /UNIQUE/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM household_memberships WHERE user_id = ?').get(shared).n, 2)
})
