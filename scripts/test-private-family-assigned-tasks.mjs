import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  createFamilyMemberAccessTables, setFamilyMemberType,
  setFamilyMemberPermission, setFamilyMemberPersonLink,
} from '../Server/family-member-access.mjs'
import { registerHousehold, grantHouseholdMembership } from '../Server/household-memberships.mjs'
import {
  createFamilyAssignedTaskTables, createVerifiedFamilyAssignedTask,
  listVerifiedFamilyAssignedTasks, completeVerifiedFamilyAssignedTask,
  reopenVerifiedFamilyAssignedTask,
} from '../Server/private-family-assigned-tasks.mjs'
import { requiredFamilyMemberActions } from '../Server/family-member-route-enforcement.mjs'

function fixture(t) {
  const identity = new DatabaseSync(':memory:')
  const familyA = new DatabaseSync(':memory:')
  const familyB = new DatabaseSync(':memory:')
  t.after(() => { familyB.close(); familyA.close(); identity.close() })
  createFamilyMemberAccessTables(identity)
  const seedUser = identity.prepare(
    'INSERT INTO family_users(username,display_name,password_hash) VALUES (?,?,?)'
  )
  const add = name => Number(seedUser.run(name, name, 'not-a-real-login').lastInsertRowid)
  const ownerA = add('owner-a')
  const adultA = add('adult-a')
  const childA = add('child-a')
  const ownerB = add('owner-b')
  const childB = add('child-b')
  const outsider = add('outsider')
  registerHousehold(identity, { householdId: 'family-a', displayName: 'Family A' })
  registerHousehold(identity, { householdId: 'family-b', displayName: 'Family B' })
  for (const [user, home, role] of [
    [ownerA, 'family-a', 'owner'], [adultA, 'family-a', 'member'],
    [childA, 'family-a', 'member'], [ownerB, 'family-b', 'owner'],
    [childB, 'family-b', 'member'],
  ]) grantHouseholdMembership(identity, {
    serverVerifiedUserId: user, householdId: home, role,
  })
  for (const [owner, user, home, type] of [
    [ownerA, adultA, 'family-a', 'adult'],
    [ownerA, childA, 'family-a', 'child'],
    [ownerB, childB, 'family-b', 'child'],
  ]) setFamilyMemberType(identity, {
    householdId: home, serverVerifiedOwnerUserId: owner,
    targetUserId: user, memberType: type,
  })
  familyA.exec([
    'CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT NOT NULL);',
    "INSERT INTO people VALUES(11,'A Owner'),(12,'A Child'),(13,'A Adult');",
  ].join(' '))
  familyB.exec([
    'CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT NOT NULL);',
    "INSERT INTO people VALUES(21,'B Owner'),(22,'B Child');",
  ].join(' '))
  // The owner must link to an EXISTING Person from their own verified house.
  for (const [db, home, owner, user, personId] of [
    [familyA, 'family-a', ownerA, ownerA, 11],
    [familyA, 'family-a', ownerA, adultA, 13],
    [familyA, 'family-a', ownerA, childA, 12],
    [familyB, 'family-b', ownerB, ownerB, 21],
    [familyB, 'family-b', ownerB, childB, 22],
  ]) setFamilyMemberPersonLink(identity, {
    householdId: home, serverVerifiedOwnerUserId: owner,
    targetUserId: user, personId, householdDatabase: db,
  })
  const a = userId => ({
    identityDatabase: identity, householdDatabase: familyA,
    householdId: 'family-a', serverVerifiedUserId: userId,
  })
  const b = userId => ({
    identityDatabase: identity, householdDatabase: familyB,
    householdId: 'family-b', serverVerifiedUserId: userId,
  })
  return { identity, familyA, familyB, ownerA, adultA, childA,
    ownerB, childB, outsider, a, b }
}

test('import never creates tables; explicit schema stays in selected household DB', t => {
  const x = fixture(t)
  assert.equal(x.familyA.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='family_assigned_tasks'"
  ).get().n, 0)
  createFamilyAssignedTaskTables(x.familyA)
  assert.equal(x.familyA.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='family_assigned_tasks'"
  ).get().n, 1)
  assert.equal(x.familyB.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='family_assigned_tasks'"
  ).get().n, 0)
  assert.equal(x.identity.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='family_assigned_tasks'"
  ).get().n, 0)
})

test('Adult creates a task for an existing Person; linked Child can see and complete only theirs', t => {
  const x = fixture(t)
  createFamilyAssignedTaskTables(x.familyA)
  const created = createVerifiedFamilyAssignedTask(x.a(x.adultA), {
    title: '  Feed the pets  ', assignedPersonId: 12, at: 1000,
  })
  assert.equal(created.taskId, 1)
  assert.equal(created.assignedPersonId, 12)
  const childTasks = listVerifiedFamilyAssignedTasks(x.a(x.childA))
  assert.equal(childTasks.length, 1)
  assert.equal(childTasks[0].title, 'Feed the pets')
  assert.equal(childTasks[0].assignedPersonId, 12)
  assert.throws(() => completeVerifiedFamilyAssignedTask(x.a(x.ownerA),
    { taskId: 1, at: 1200 }), /cannot perform/)
  assert.throws(() => completeVerifiedFamilyAssignedTask(x.a(x.adultA),
    { taskId: 1, at: 1200 }), /cannot perform/)
  assert.deepEqual(completeVerifiedFamilyAssignedTask(x.a(x.childA), {
    taskId: 1, at: 1200,
  }), { taskId: 1, completed: true, alreadyCompleted: false })
  assert.deepEqual(completeVerifiedFamilyAssignedTask(x.a(x.childA), {
    taskId: 1, at: 1300,
  }), { taskId: 1, completed: true, alreadyCompleted: true })
  const audit = x.familyA.prepare('SELECT completed_at AS at,completed_by_user_id AS byUser,' +
    'completed_by_person_id AS byPerson FROM family_assigned_tasks WHERE id = 1').get()
  assert.equal(audit.at, 1200)
  assert.equal(audit.byUser, x.childA)
  assert.equal(audit.byPerson, 12)
  assert.throws(() => reopenVerifiedFamilyAssignedTask(x.a(x.childA), { taskId: 1 }),
    /cannot perform/)
  assert.deepEqual(reopenVerifiedFamilyAssignedTask(x.a(x.ownerA), { taskId: 1 }),
    { taskId: 1, reopened: true })
  assert.equal(listVerifiedFamilyAssignedTasks(x.a(x.childA))[0].completedAt, null)
  assert.equal(x.familyA.prepare('SELECT COUNT(*) AS n FROM family_assigned_tasks').get().n, 1)
})

test('Task list filters by verified Person and manager rights; spoofed avatar never selects a task', t => {
  const x = fixture(t)
  createFamilyAssignedTaskTables(x.familyA)
  createVerifiedFamilyAssignedTask(x.a(x.ownerA), {
    title: 'Parent task', assignedPersonId: 11, at: 2000,
  })
  createVerifiedFamilyAssignedTask(x.a(x.ownerA), {
    title: 'Child task', assignedPersonId: 12, at: 2001,
  })
  assert.deepEqual(listVerifiedFamilyAssignedTasks(x.a(x.childA)).map(t => t.title),
    ['Child task'])
  assert.equal(listVerifiedFamilyAssignedTasks(x.a(x.ownerA)).length, 2)
  assert.equal(listVerifiedFamilyAssignedTasks(x.a(x.adultA)).length, 2)
  // An account's selected avatar is never an input. This is always tied to
  // the server-verified central member link.
  assert.throws(() => completeVerifiedFamilyAssignedTask({
    ...x.a(x.childA), selectedPersonId: 11, actor: 'owner',
  }, { taskId: 1, at: 3000 }), /cannot perform/)
})

test('two household DBs with same numeric task IDs cannot mix assignments', t => {
  const x = fixture(t)
  createFamilyAssignedTaskTables(x.familyA)
  createFamilyAssignedTaskTables(x.familyB)
  createVerifiedFamilyAssignedTask(x.a(x.ownerA), {
    title: 'Family A only', assignedPersonId: 12,
  })
  createVerifiedFamilyAssignedTask(x.b(x.ownerB), {
    title: 'Family B only', assignedPersonId: 22,
  })
  assert.equal(listVerifiedFamilyAssignedTasks(x.a(x.childA))[0].title, 'Family A only')
  assert.equal(listVerifiedFamilyAssignedTasks(x.b(x.childB))[0].title, 'Family B only')
  assert.throws(() => completeVerifiedFamilyAssignedTask(x.a(x.childB),
    { taskId: 1 }), /Active household member/)
  assert.throws(() => completeVerifiedFamilyAssignedTask(x.b(x.childA),
    { taskId: 1 }), /Active household member/)
  // Even if a trusted caller accidentally passed the wrong household DB,
  // rows retain their household key; no cross-tenant fallback is permitted.
  assert.throws(() => completeVerifiedFamilyAssignedTask({
    ...x.b(x.childB), householdDatabase: x.familyA,
  }, { taskId: 1 }), /unavailable/)
  assert.equal(x.familyB.prepare(
    'SELECT completed_at FROM family_assigned_tasks WHERE id = 1'
  ).get().completed_at, null)
})

test('Owner revokes Child completion and disabled/stale links fail closed immediately', t => {
  const x = fixture(t)
  createFamilyAssignedTaskTables(x.familyA)
  createVerifiedFamilyAssignedTask(x.a(x.ownerA), {
    title: 'Bring recycling out', assignedPersonId: 12,
  })
  setFamilyMemberPermission(x.identity, {
    householdId: 'family-a', serverVerifiedOwnerUserId: x.ownerA,
    targetUserId: x.childA, action: 'tasks.completeAssigned', enabled: false,
  })
  assert.throws(() => completeVerifiedFamilyAssignedTask(x.a(x.childA),
    { taskId: 1 }), /cannot perform/)
  setFamilyMemberPermission(x.identity, {
    householdId: 'family-a', serverVerifiedOwnerUserId: x.ownerA,
    targetUserId: x.childA, action: 'tasks.completeAssigned', enabled: true,
  })
  assert.deepEqual(completeVerifiedFamilyAssignedTask(x.a(x.childA),
    { taskId: 1, at: 3100 }), { taskId: 1, completed: true, alreadyCompleted: false })
  x.identity.prepare('UPDATE household_memberships SET disabled = 1 WHERE user_id = ?')
    .run(x.childA)
  assert.throws(() => completeVerifiedFamilyAssignedTask(x.a(x.childA),
    { taskId: 1 }), /Active household member/)
  x.identity.prepare('UPDATE household_memberships SET disabled = 0 WHERE user_id = ?')
    .run(x.childA)
  setFamilyMemberPersonLink(x.identity, {
    householdId: 'family-a', serverVerifiedOwnerUserId: x.ownerA,
    targetUserId: x.childA, personId: null, householdDatabase: x.familyA,
  })
  assert.throws(() => completeVerifiedFamilyAssignedTask(x.a(x.childA),
    { taskId: 1 }), /cannot perform/)
})

test('invalid assignment, untrusted schema input and absent Person roll back without writes', t => {
  const x = fixture(t)
  assert.throws(() => createFamilyAssignedTaskTables(null), /Trusted/)
  createFamilyAssignedTaskTables(x.familyA)
  for (const item of [
    { title: '', assignedPersonId: 12 }, { title: 'a'.repeat(201), assignedPersonId: 12 },
    { title: 'Valid', assignedPersonId: 999 }, { title: 'Valid', assignedPersonId: 0 },
    { title: 'Valid', assignedPersonId: 12, at: -1 },
  ]) assert.throws(() => createVerifiedFamilyAssignedTask(x.a(x.ownerA), item))
  assert.throws(() => createVerifiedFamilyAssignedTask(x.a(x.childA),
    { title: 'Forged manager', assignedPersonId: 12 }), /cannot perform/)
  assert.throws(() => createVerifiedFamilyAssignedTask(x.a(x.outsider),
    { title: 'Forged member', assignedPersonId: 12 }), /Active household member/)
  assert.throws(() => completeVerifiedFamilyAssignedTask(x.a(x.childA),
    { taskId: 0 }), /Valid task/)
  assert.equal(x.familyA.prepare('SELECT COUNT(*) AS n FROM family_assigned_tasks').get().n, 0)
  // No live API mutation route is made accessible merely by adding a table.
  assert.equal(requiredFamilyMemberActions('POST', '/api/tasks/1/complete'), null)
  assert.equal(requiredFamilyMemberActions('POST', '/api/family-assigned-tasks'), null)
})
