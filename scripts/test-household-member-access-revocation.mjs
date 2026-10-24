// Disposable central identity database only; no family calendar rows touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { revokeHouseholdMemberAccess } from '../Server/household-member-access-revocation.mjs'
import {
  createHouseholdMembershipTables, registerHousehold,
  grantHouseholdMembership, listGrantedHouseholdsForSessionUser,
} from '../Server/household-memberships.mjs'

test('revoke one member grant only, preserve identity and other households', t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  createHouseholdMembershipTables(db)
  const add = db.prepare(`
    INSERT INTO family_users(username, display_name, password_hash, account_kind)
    VALUES (?, ?, 'fake-fixture-hash', ?)
  `)
  const ownerA = Number(add.run('owner-a', 'Owner A', 'person').lastInsertRowid)
  const ownerB = Number(add.run('owner-b', 'Owner B', 'person').lastInsertRowid)
  const member = Number(add.run('member-a', 'Member A', 'person').lastInsertRowid)
  const hub = Number(add.run('hub-a', 'Hub', 'hub').lastInsertRowid)
  registerHousehold(db, { householdId: 'household-a', displayName: 'Household A' })
  registerHousehold(db, { householdId: 'household-b', displayName: 'Household B' })
  for (const [user, family, role] of [
    [ownerA, 'household-a', 'owner'],
    [ownerB, 'household-b', 'owner'],
    [member, 'household-a', 'member'],
    [member, 'household-b', 'member'],
    [hub, 'household-a', 'owner'],
  ]) grantHouseholdMembership(db, {
    serverVerifiedUserId: user, householdId: family, role,
  })
  const remove = (issuer, target, family = 'household-a') =>
    revokeHouseholdMemberAccess(db, {
      householdId: family,
      serverVerifiedOwnerUserId: issuer,
      targetUserId: target,
    })

  assert.equal(remove(ownerB, member), false, 'B owner cannot remove member from A')
  assert.equal(remove(ownerA, ownerA), false, 'Owner cannot remove self')
  assert.equal(remove(ownerA, hub), false, 'Hub cannot be removed through member API')
  assert.equal(remove(ownerA, ownerB), false, 'Owner B is not member in A')
  assert.throws(() => remove(member, member), /owner permission/)
  assert.throws(() => remove(hub, member), /owner permission/)
  assert.throws(() => remove(ownerA, 0), /Invalid member/)
  assert.equal(remove(ownerA, member), true)
  assert.equal(remove(ownerA, member), false, 'Repeated removal is idempotent')
  assert.deepEqual(listGrantedHouseholdsForSessionUser(db, {
    serverVerifiedUserId: member,
  }), [{ householdId: 'household-b', displayName: 'Household B', role: 'member' }])
  assert.equal(db.prepare('SELECT disabled FROM family_users WHERE id = ?')
    .get(member).disabled, 0, 'Account was not disabled or deleted')
  assert.equal(remove(ownerB, member, 'household-b'), true)
  assert.deepEqual(listGrantedHouseholdsForSessionUser(db, {
    serverVerifiedUserId: member,
  }), [])
})

test('disabled owner cannot revoke member grants', t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  createHouseholdMembershipTables(db)
  const add = db.prepare(`
    INSERT INTO family_users(username, display_name, password_hash, account_kind)
    VALUES (?, ?, 'fake-fixture-hash', 'person')
  `)
  const owner = Number(add.run('owner', 'Owner').lastInsertRowid)
  const member = Number(add.run('member', 'Member').lastInsertRowid)
  registerHousehold(db, { householdId: 'home-one', displayName: 'One' })
  grantHouseholdMembership(db, { serverVerifiedUserId: owner, householdId: 'home-one', role: 'owner' })
  grantHouseholdMembership(db, { serverVerifiedUserId: member, householdId: 'home-one', role: 'member' })
  db.prepare('UPDATE household_memberships SET disabled = 1 WHERE user_id = ?').run(owner)
  assert.throws(() => revokeHouseholdMemberAccess(db, {
    householdId: 'home-one', serverVerifiedOwnerUserId: owner, targetUserId: member,
  }), /owner permission/)
  assert.equal(db.prepare('SELECT disabled FROM household_memberships WHERE user_id = ?')
    .get(member).disabled, 0)
})
