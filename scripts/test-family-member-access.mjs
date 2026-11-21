test('personal RSVP and acknowledgement require a linked, matching Person', () => {
  for (const action of ['invitations.respondOwn', 'notifications.acknowledgeOwn']) {
    const actor = { role: 'child', personId: 2, permissions: [action] }
    assert.equal(canFamilyMemberAct(actor, action), false)
    assert.equal(canFamilyMemberAct(actor, action, { assignedPersonId: 1 }), false)
    assert.equal(canFamilyMemberAct(actor, action, { assignedPersonId: 2 }), true)
    assert.equal(canFamilyMemberAct({ ...actor, personId: null }, action,
      { assignedPersonId: 2 }), false)
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  createFamilyMemberAccessTables, setFamilyMemberType,
  setFamilyMemberPermission, getFamilyMemberAuthorization,
  canFamilyMemberAct, canActFromHome,
} from '../Server/family-member-access.mjs'
import {
  registerHousehold, grantHouseholdMembership,
} from '../Server/household-memberships.mjs'

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  createFamilyMemberAccessTables(db)
  const insert = db.prepare(
    'INSERT INTO family_users(username, display_name, password_hash) VALUES (?, ?, ?)'
  )
  const ownerA = Number(insert.run('a_owner', 'Owner A', 'test-only').lastInsertRowid)
  const ownerB = Number(insert.run('b_owner', 'Owner B', 'test-only').lastInsertRowid)
  const adult = Number(insert.run('a_adult', 'Adult A', 'test-only').lastInsertRowid)
  const child = Number(insert.run('a_child', 'Child A', 'test-only').lastInsertRowid)
  const outsider = Number(insert.run('outsider', 'Outsider', 'test-only').lastInsertRowid)
  registerHousehold(db, { householdId: 'home-a', displayName: 'Home A' })
  registerHousehold(db, { householdId: 'home-b', displayName: 'Home B' })
  grantHouseholdMembership(db, { serverVerifiedUserId: ownerA, householdId: 'home-a', role: 'owner' })
  grantHouseholdMembership(db, { serverVerifiedUserId: ownerB, householdId: 'home-b', role: 'owner' })
  grantHouseholdMembership(db, { serverVerifiedUserId: adult, householdId: 'home-a', role: 'member' })
  grantHouseholdMembership(db, { serverVerifiedUserId: child, householdId: 'home-a', role: 'member' })
  return { db, ownerA, ownerB, adult, child, outsider }
}

function enroll(db, ownerA, targetUserId, memberType) {
  setFamilyMemberType(db, {
    householdId: 'home-a', serverVerifiedOwnerUserId: ownerA,
    targetUserId, memberType,
  })
}
function grant(db, ownerA, targetUserId, action, enabled = true) {
  setFamilyMemberPermission(db, {
    householdId: 'home-a', serverVerifiedOwnerUserId: ownerA,
    targetUserId, action, enabled,
  })
}
function auth(db, userId, householdId = 'home-a') {
  return getFamilyMemberAuthorization(db, { householdId, serverVerifiedUserId: userId })
}

test('only one active Owner can be registered for a household', t => {
  const { db, ownerA, outsider } = fixture(t)
  assert.throws(() => grantHouseholdMembership(db, {
    serverVerifiedUserId: outsider, householdId: 'home-b', role: 'owner',
  }), /UNIQUE|already has an active Owner/)
  // The independent one-household-per-user constraint still applies.
  assert.equal(auth(db, ownerA).role, 'owner')
  assert.equal(canFamilyMemberAct(auth(db, ownerA), 'permissions.manage'), true)
})

test('unknown member type fails closed; Child sees calendar and only assigned tasks', t => {
  const { db, ownerA, child } = fixture(t)
  assert.equal(auth(db, child), null)
  enroll(db, ownerA, child, 'child')
  const childActor = auth(db, child)
  assert.equal(childActor.role, 'child')
  assert.equal(canFamilyMemberAct(childActor, 'calendar.view'), true)
  assert.equal(canFamilyMemberAct(childActor, 'events.create'), false)
  assert.equal(canFamilyMemberAct(childActor, 'lists.edit'), false)
  assert.equal(canFamilyMemberAct(childActor, 'tasks.completeAssigned', { assignedPersonId: 11 }), false)
  // Linking a People row must be verified by the future household backend.
  db.exec('UPDATE family_member_access SET person_id = 11 WHERE user_id = ' + child)
  const linkedChild = auth(db, child)
  assert.equal(canFamilyMemberAct(linkedChild, 'tasks.completeAssigned', { assignedPersonId: 11 }), true)
  assert.equal(canFamilyMemberAct(linkedChild, 'tasks.completeAssigned', { assignedPersonId: 12 }), false)
})

test('Owner can grant or revoke individual Child actions without granting admin privileges', t => {
  const { db, ownerA, child, ownerB } = fixture(t)
  enroll(db, ownerA, child, 'child')
  grant(db, ownerA, child, 'events.create', true)
  assert.equal(canFamilyMemberAct(auth(db, child), 'events.create'), true)
  grant(db, ownerA, child, 'events.create', false)
  assert.equal(canFamilyMemberAct(auth(db, child), 'events.create'), false)
  assert.throws(() => grant(db, ownerA, child, 'permissions.manage'), /not delegable/)
  assert.throws(() => grant(db, ownerA, child, 'devices.manage'), /not delegable/)
  assert.throws(() => grant(db, ownerA, child, 'members.invite'), /Adult/)
  assert.throws(() => setFamilyMemberPermission(db, {
    householdId: 'home-a', serverVerifiedOwnerUserId: ownerB,
    targetUserId: child, action: 'events.create', enabled: true,
  }), /Owner required/)
})

test('adult default actions, explicit overrides and changed-role grants are checked server-side', t => {
  const { db, ownerA, adult } = fixture(t)
  enroll(db, ownerA, adult, 'adult')
  assert.equal(canFamilyMemberAct(auth(db, adult), 'events.edit'), true)
  assert.equal(canFamilyMemberAct(auth(db, adult), 'permissions.manage'), false)
  grant(db, ownerA, adult, 'events.edit', false)
  assert.equal(canFamilyMemberAct(auth(db, adult), 'events.edit'), false)
  grant(db, ownerA, adult, 'members.invite', true)
  assert.equal(canFamilyMemberAct(auth(db, adult), 'members.invite'), true)
  enroll(db, ownerA, adult, 'child')
  assert.equal(auth(db, adult).role, 'child')
  assert.equal(canFamilyMemberAct(auth(db, adult), 'members.invite'), false)
  assert.equal(canFamilyMemberAct(auth(db, adult), 'events.edit'), false)
})

test('self Join and Leave require the linked actor Person and independent grants', t => {
  const { db, ownerA, adult, child } = fixture(t)
  enroll(db, ownerA, adult, 'adult')
  enroll(db, ownerA, child, 'child')
  db.prepare('UPDATE family_member_access SET person_id = ? WHERE user_id = ?').run(11, adult)
  db.prepare('UPDATE family_member_access SET person_id = ? WHERE user_id = ?').run(12, child)
  for (const action of ['events.joinOwn', 'events.leaveOwn']) {
    assert.equal(canFamilyMemberAct(auth(db, adult), action, { assignedPersonId: 11 }), true)
    assert.equal(canFamilyMemberAct(auth(db, adult), action, { assignedPersonId: 12 }), false)
    assert.equal(canFamilyMemberAct(auth(db, child), action, { assignedPersonId: 12 }), false)
    assert.equal(canFamilyMemberAct(auth(db, ownerA), action, { assignedPersonId: 12 }), false)
  }
  grant(db, ownerA, child, 'events.joinOwn', true)
  assert.equal(canFamilyMemberAct(auth(db, child), 'events.joinOwn', { assignedPersonId: 12 }), true)
  assert.equal(canFamilyMemberAct(auth(db, child), 'events.leaveOwn', { assignedPersonId: 12 }), false)
  grant(db, ownerA, child, 'events.leaveOwn', true)
  assert.equal(canFamilyMemberAct(auth(db, child), 'events.leaveOwn', { assignedPersonId: 12 }), true)
  grant(db, ownerA, child, 'events.joinOwn', false)
  assert.equal(canFamilyMemberAct(auth(db, child), 'events.joinOwn', { assignedPersonId: 12 }), false)
  assert.equal(canFamilyMemberAct(auth(db, child), 'events.leaveOwn', { assignedPersonId: 12 }), true)
  assert.equal(canActFromHome({ serverVerifiedHomeDevice: true, actor: auth(db, adult),
    action: 'events.joinOwn', assignedPersonId: 11 }), false)
})

test('Home selection never elevates a Child or an unverified kiosk into a writer', t => {
  const { db, ownerA, adult, child } = fixture(t)
  enroll(db, ownerA, adult, 'adult')
  enroll(db, ownerA, child, 'child')
  const adultActor = auth(db, adult)
  const childActor = auth(db, child)
  assert.equal(canActFromHome({
    serverVerifiedHomeDevice: false, actor: adultActor, action: 'events.create',
  }), false)
  assert.equal(canActFromHome({
    serverVerifiedHomeDevice: true, action: 'calendar.view',
  }), true)
  assert.equal(canActFromHome({
    serverVerifiedHomeDevice: true, action: 'events.create',
  }), false)
  assert.equal(canActFromHome({
    serverVerifiedHomeDevice: true, actor: childActor, action: 'events.create',
  }), false)
  assert.equal(canActFromHome({
    serverVerifiedHomeDevice: true, actor: adultActor, action: 'events.create',
  }), true)
  assert.equal(canActFromHome({
    serverVerifiedHomeDevice: true, actor: adultActor, action: 'lists.edit',
  }), true)
  assert.equal(canActFromHome({
    serverVerifiedHomeDevice: true, actor: adultActor, action: 'permissions.manage',
  }), false)
  assert.equal(canActFromHome({
    serverVerifiedHomeDevice: true, actor: adultActor, action: 'events.delete',
  }), false)
})

test('cross-household, disabled, Hub and non-owner changes are rejected', t => {
  const { db, ownerA, adult, child, outsider } = fixture(t)
  enroll(db, ownerA, child, 'child')
  assert.equal(auth(db, child, 'home-b'), null)
  assert.equal(auth(db, outsider), null)
  assert.throws(() => setFamilyMemberType(db, {
    householdId: 'home-a', serverVerifiedOwnerUserId: adult,
    targetUserId: child, memberType: 'adult',
  }), /Owner required/)
  db.prepare('UPDATE family_users SET disabled = 1 WHERE id = ?').run(child)
  assert.equal(auth(db, child), null)
  db.prepare('UPDATE family_users SET account_kind = ? WHERE id = ?').run('hub', adult)
  assert.equal(auth(db, adult), null)
})
