import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  createFamilyMemberAccessTables, setFamilyMemberType,
  setFamilyMemberPermission, setFamilyMemberPersonLink,
  getFamilyMemberAuthorization, getVerifiedFamilyMemberAuthorization,
  canFamilyMemberAct,
} from '../Server/family-member-access.mjs'
import {
  registerHousehold, grantHouseholdMembership,
} from '../Server/household-memberships.mjs'

function fixture(t) {
  const identity = new DatabaseSync(':memory:')
  const familyA = new DatabaseSync(':memory:')
  const familyB = new DatabaseSync(':memory:')
  t.after(() => { familyB.close(); familyA.close(); identity.close() })
  createFamilyMemberAccessTables(identity)
  const add = identity.prepare(
    'INSERT INTO family_users(username, display_name, password_hash) VALUES (?, ?, ?)'
  )
  const ownerA = Number(add.run('owner-a', 'Owner A', 'not-a-real-password').lastInsertRowid)
  const ownerB = Number(add.run('owner-b', 'Owner B', 'not-a-real-password').lastInsertRowid)
  const adultA = Number(add.run('adult-a', 'Adult A', 'not-a-real-password').lastInsertRowid)
  const childA = Number(add.run('child-a', 'Child A', 'not-a-real-password').lastInsertRowid)
  const outsider = Number(add.run('outsider', 'Outsider', 'not-a-real-password').lastInsertRowid)
  registerHousehold(identity, { householdId: 'family-a', displayName: 'Family A' })
  registerHousehold(identity, { householdId: 'family-b', displayName: 'Family B' })
  for (const [user, householdId, role] of [
    [ownerA, 'family-a', 'owner'],
    [ownerB, 'family-b', 'owner'],
    [adultA, 'family-a', 'member'],
    [childA, 'family-a', 'member'],
  ]) grantHouseholdMembership(identity, {
    serverVerifiedUserId: user, householdId, role,
  })
  setFamilyMemberType(identity, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerA,
    targetUserId: adultA, memberType: 'adult',
  })
  setFamilyMemberType(identity, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerA,
    targetUserId: childA, memberType: 'child',
  })
  familyA.exec([
    'CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
    "INSERT INTO people VALUES(1,'Existing Adult'),(2,'Existing Child'),(3,'Existing Owner');",
  ].join(' '))
  familyB.exec([
    'CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
    "INSERT INTO people VALUES(4,'Other Household Person');",
  ].join(' '))
  const link = (targetUserId, personId, options = {}) =>
    setFamilyMemberPersonLink(identity, {
      householdId: 'family-a', serverVerifiedOwnerUserId: ownerA,
      targetUserId, personId, householdDatabase: familyA, ...options,
    })
  const actor = (userId, householdId = 'family-a', householdDatabase = familyA) =>
    getVerifiedFamilyMemberAuthorization(identity, {
      householdId, serverVerifiedUserId: userId, householdDatabase,
    })
  return { identity, familyA, familyB, ownerA, ownerB, adultA, childA, outsider, link, actor }
}

test('Owner links only verified existing People and child completes assigned tasks', t => {
  const { identity, familyA, ownerA, adultA, childA, link, actor } = fixture(t)
  assert.deepEqual(link(ownerA, 3), { userId: ownerA, personId: 3, membershipRole: 'owner' })
  link(adultA, 1)
  link(childA, 2)
  assert.equal(actor(ownerA).role, 'owner')
  assert.equal(actor(ownerA).personId, 3)
  assert.equal(actor(childA).role, 'child')
  assert.equal(actor(childA).personId, 2)
  assert.equal(canFamilyMemberAct(actor(childA), 'tasks.completeAssigned', { assignedPersonId: 2 }), true)
  assert.equal(canFamilyMemberAct(actor(childA), 'tasks.completeAssigned', { assignedPersonId: 1 }), false)
  assert.equal(canFamilyMemberAct(actor(childA), 'events.create'), false)
  assert.equal(identity.prepare('SELECT COUNT(*) AS n FROM family_member_access').get().n, 3)
  assert.equal(familyA.prepare('SELECT COUNT(*) AS n FROM people').get().n, 3)
})

test('one household Person is not claimable by two logins; unlink is explicit', t => {
  const { adultA, childA, link, actor } = fixture(t)
  link(adultA, 1)
  assert.throws(() => link(childA, 1), /UNIQUE/)
  assert.equal(actor(childA).personId, null)
  assert.equal(actor(adultA).personId, 1)
  link(adultA, null)
  link(childA, 1)
  assert.equal(actor(adultA).personId, null)
  assert.equal(actor(childA).personId, 1)
})

test('cross-household, disabled, hub, and non-owner linking fail closed', t => {
  const { identity, familyA, ownerA, ownerB, adultA, childA, outsider, link, actor } = fixture(t)
  assert.throws(() => link(adultA, 1, { serverVerifiedOwnerUserId: ownerB }), /Owner/)
  assert.throws(() => link(adultA, 1, { serverVerifiedOwnerUserId: childA }), /Owner/)
  assert.throws(() => link(outsider, 1), /active household/)
  assert.throws(() => link(ownerB, 1), /active household/)
  assert.equal(actor(adultA).personId, null)
  identity.prepare('UPDATE household_memberships SET disabled=1 WHERE user_id=?').run(childA)
  assert.throws(() => link(childA, 2), /active household/)
  identity.prepare('UPDATE family_users SET account_kind=? WHERE id=?').run('hub', adultA)
  assert.throws(() => link(adultA, 1), /active household/)
  assert.equal(actor(childA), null)
  assert.equal(actor(adultA), null)
  assert.equal(familyA.prepare('SELECT COUNT(*) AS n FROM people').get().n, 3)
})

test('invalid IDs, missing profiles, or untrusted calendar database cannot establish a link', t => {
  const { familyA, familyB, adultA, link, actor } = fixture(t)
  for (const personId of [undefined, '1', 0, -1, 1.5, {}, 999]) {
    assert.throws(() => link(adultA, personId))
  }
  assert.throws(() => link(adultA, 4), /does not exist/)
  assert.throws(() => link(adultA, 1, { householdDatabase: null }), /Trusted/)
  assert.equal(actor(adultA).personId, null)
  assert.equal(actor(adultA, 'family-a', null), null)
  assert.equal(familyB.prepare('SELECT COUNT(*) AS n FROM people').get().n, 1)
  assert.equal(familyA.prepare('SELECT COUNT(*) AS n FROM people').get().n, 3)
})

test('removing a Person invalidates authorization attribution without relinking to another', t => {
  const { identity, familyA, ownerA, childA, link, actor } = fixture(t)
  link(childA, 2)
  assert.equal(canFamilyMemberAct(actor(childA), 'tasks.completeAssigned', { assignedPersonId: 2 }), true)
  familyA.prepare('DELETE FROM people WHERE id = ?').run(2)
  const stale = actor(childA)
  assert.equal(stale.personId, null)
  assert.equal(canFamilyMemberAct(stale, 'tasks.completeAssigned', { assignedPersonId: 2 }), false)
  // The source DB is not mutated by the authorization check; stale link is
  // still visible to the Owner for deliberate repair.
  assert.equal(getFamilyMemberAuthorization(identity, {
    householdId: 'family-a', serverVerifiedUserId: childA,
  }).personId, 2)
  assert.equal(identity.prepare('SELECT COUNT(*) AS n FROM family_member_access').get().n, 1)
  assert.equal(identity.prepare('SELECT COUNT(*) AS n FROM family_member_grants').get().n, 0)
  assert.equal(ownerA > 0, true)
})

test('Adult/Child type changes preserve linked People but clear older permission grants', t => {
  const { identity, ownerA, adultA, link, actor } = fixture(t)
  link(adultA, 1)
  setFamilyMemberPermission(identity, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerA,
    targetUserId: adultA, action: 'members.invite', enabled: true,
  })
  assert.equal(canFamilyMemberAct(actor(adultA), 'members.invite'), true)
  setFamilyMemberType(identity, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerA,
    targetUserId: adultA, memberType: 'child',
  })
  assert.equal(actor(adultA).role, 'child')
  assert.equal(actor(adultA).personId, 1)
  assert.equal(canFamilyMemberAct(actor(adultA), 'members.invite'), false)
  assert.equal(canFamilyMemberAct(actor(adultA), 'events.edit'), false)
})
