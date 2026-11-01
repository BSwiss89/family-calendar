// Disposable central identity-only directory tests; no household data files.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { listHouseholdMembers } from '../Server/household-member-directory.mjs'
import {
  createHouseholdMembershipTables, registerHousehold, grantHouseholdMembership,
} from '../Server/household-memberships.mjs'

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  createHouseholdMembershipTables(db)
  const add = db.prepare(`
    INSERT INTO family_users(username, display_name, password_hash, account_kind)
    VALUES (?, ?, 'fixture-hash', ?)
  `)
  const ownerA = Number(add.run('owner-a', 'Owner A', 'person').lastInsertRowid)
  const memberA = Number(add.run('member-a', 'Member A', 'person').lastInsertRowid)
  const ownerB = Number(add.run('owner-b', 'Owner B', 'person').lastInsertRowid)
  const hubA = Number(add.run('hub-a', 'Hub A', 'hub').lastInsertRowid)
  const disabledA = Number(add.run('disabled-a', 'Disabled A', 'person').lastInsertRowid)
  registerHousehold(db, { householdId: 'household-a', displayName: 'A Family' })
  registerHousehold(db, { householdId: 'household-b', displayName: 'B Family' })
  for (const [id, family, role] of [
    [ownerA, 'household-a', 'owner'],
    [memberA, 'household-a', 'member'],
    [ownerB, 'household-b', 'owner'],
    [hubA, 'household-a', 'owner'],
    [disabledA, 'household-a', 'member'],
  ]) {
    grantHouseholdMembership(db, {
      serverVerifiedUserId: id, householdId: family, role,
    })
  }
  db.prepare('UPDATE family_users SET disabled = 1 WHERE id = ?').run(disabledA)
  return { db, ownerA, memberA, ownerB, hubA, disabledA }
}

const roster = (db, owner) => listHouseholdMembers(db, {
  householdId: 'household-a', serverVerifiedOwnerUserId: owner,
})

test('only active human members of selected household appear with safe fields', t => {
  const { db, ownerA } = fixture(t)
  assert.deepEqual(roster(db, ownerA), [
    { userId: ownerA, username: 'owner-a', displayName: 'Owner A', role: 'owner' },
    { userId: db.prepare("SELECT id FROM family_users WHERE username = 'member-a'").get().id,
      username: 'member-a', displayName: 'Member A', role: 'member' },
  ])
  assert.doesNotMatch(JSON.stringify(roster(db, ownerA)), /hash|token|session|password/i)
})

test('member, hub and other household owner cannot read another family roster', t => {
  const { db, ownerA, ownerB, memberA, hubA } = fixture(t)
  for (const id of [ownerB, memberA, hubA, 0, -1]) {
    assert.throws(() => roster(db, id), /owner permission/)
  }
  assert.throws(() => listHouseholdMembers(db, {
    householdId: 'household-b', serverVerifiedOwnerUserId: ownerA,
  }), /owner permission/)
  db.prepare('UPDATE household_memberships SET disabled = 1 WHERE user_id = ?')
    .run(ownerA)
  assert.throws(() => roster(db, ownerA), /owner permission/)
})

test('revoked and disabled user grants disappear from roster without deleting accounts', t => {
  const { db, ownerA, memberA, disabledA } = fixture(t)
  db.prepare('UPDATE household_memberships SET disabled = 1 WHERE user_id = ?')
    .run(memberA)
  assert.deepEqual(roster(db, ownerA).map(r => r.username), ['owner-a'])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_users WHERE id IN (?,?)')
    .get(memberA, disabledA).n, 2)
})
