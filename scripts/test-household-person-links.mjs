import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  grantHouseholdMembership, registerHousehold,
} from '../Server/household-memberships.mjs'
import {
  createHouseholdPersonLinkTables, linkHouseholdPersonToAccount,
  getLinkedHouseholdPerson, getAssignedHouseholdNotificationRecipients,
} from '../Server/household-person-links.mjs'

function householdDatabase() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE people (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL, image TEXT
    ) STRICT;
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL
    ) STRICT;
    CREATE TABLE event_people (
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, person_id)
    ) STRICT;
  `)
  return db
}

function fixture(t) {
  const central = new DatabaseSync(':memory:')
  const a = householdDatabase()
  const b = householdDatabase()
  t.after(() => { b.close(); a.close(); central.close() })
  createHouseholdPersonLinkTables(central)
  registerHousehold(central, { householdId: 'family-a', displayName: 'Family A' })
  registerHousehold(central, { householdId: 'family-b', displayName: 'Family B' })
  function user(username, accountKind, householdId, role) {
    const userId = Number(central.prepare(`
      INSERT INTO family_users (username, display_name, password_hash, account_kind)
      VALUES (?, ?, ?, ?)
    `).run(username, username, 'synthetic-no-login', accountKind).lastInsertRowid)
    grantHouseholdMembership(central, {
      serverVerifiedUserId: userId, householdId, role,
    })
    return userId
  }
  const robert = user('robert-test', 'person', 'family-a', 'owner')
  const haylee = user('haylee-test', 'person', 'family-a', 'member')
  const hub = user('hub-test', 'hub', 'family-a', 'member')
  const friend = user('friend-test', 'person', 'family-b', 'owner')

  a.exec(`
    INSERT INTO people VALUES
      (1, 'Robert', '#f00000', 'robert.webp'),
      (2, 'Haylee', '#db4ce6', 'haylee.webp'),
      (3, 'Family', '#4ce64f', NULL);
    INSERT INTO events VALUES (10, 'Dinner together'), (11, 'Haylee appointment'),
      (12, 'Family cleanup');
    INSERT INTO event_people VALUES
      (10, 1), (10, 2), (11, 2), (12, 3);
  `)
  b.exec(`
    INSERT INTO people VALUES (1, 'Friend', '#0000ff', NULL);
    INSERT INTO events VALUES (10, 'Different household event');
    INSERT INTO event_people VALUES (10, 1);
  `)
  const link = (database, householdId, serverVerifiedUserId, personId) =>
    linkHouseholdPersonToAccount(central, database, {
      householdId, serverVerifiedUserId, personId,
    })
  return { central, a, b, robert, haylee, hub, friend, link }
}

test('personal login links keep existing people, colors, avatars and assignments intact', t => {
  const { central, a, robert, haylee, link } = fixture(t)
  const beforePeople = a.prepare('SELECT * FROM people ORDER BY id').all()
  const beforeAssignments = a.prepare('SELECT * FROM event_people ORDER BY event_id, person_id').all()
  link(a, 'family-a', robert, 1)
  link(a, 'family-a', haylee, 2)
  assert.deepEqual(getLinkedHouseholdPerson(central, a, {
    householdId: 'family-a', serverVerifiedUserId: robert,
  }), { householdId: 'family-a', userId: robert, personId: 1 })
  assert.deepEqual(a.prepare('SELECT * FROM people ORDER BY id').all(), beforePeople)
  assert.deepEqual(
    a.prepare('SELECT * FROM event_people ORDER BY event_id, person_id').all(),
    beforeAssignments,
  )
  assert.equal(a.prepare('SELECT COUNT(*) AS count FROM events').get().count, 3)
})

test('participants select notification recipients, never event visibility', t => {
  const { central, a, robert, haylee, hub, link } = fixture(t)
  link(a, 'family-a', robert, 1)
  link(a, 'family-a', haylee, 2)
  const recipients = (eventId, actor = null) =>
    getAssignedHouseholdNotificationRecipients(central, a, {
      householdId: 'family-a', eventId, serverVerifiedActorUserId: actor,
    })
  assert.deepEqual(recipients(10, haylee), [{ userId: robert, personId: 1 }])
  assert.deepEqual(recipients(10, robert), [{ userId: haylee, personId: 2 }])
  assert.deepEqual(recipients(11, robert), [{ userId: haylee, personId: 2 }])
  assert.deepEqual(recipients(11, haylee), [])
  assert.deepEqual(recipients(12), [])
  assert.deepEqual(recipients(10).map(item => item.userId).sort(),
    [robert, haylee].sort())
  assert.ok(!recipients(10).some(item => item.userId === hub))
  // Neither the event rows nor household-wide read access is altered.
  assert.equal(a.prepare('SELECT COUNT(*) AS count FROM events').get().count, 3)
})

test('hub accounts and invalid or reused local profiles cannot impersonate humans', t => {
  const { central, a, robert, haylee, hub, link } = fixture(t)
  assert.throws(() => link(a, 'family-a', hub, 3), /personal account membership/)
  assert.throws(() => link(a, 'family-a', robert, 999), /does not exist/)
  assert.throws(() => link(a, 'family-a', 99999, 1), /personal account membership/)
  assert.throws(() => link(a, 'family-a', robert, -1), /positive integer/)
  assert.throws(() => link(a, '../family-b', robert, 1), /Invalid household/)
  link(a, 'family-a', robert, 1)
  assert.throws(() => link(a, 'family-a', robert, 2), /UNIQUE/)
  assert.throws(() => link(a, 'family-a', haylee, 1), /UNIQUE/)
  assert.equal(getLinkedHouseholdPerson(central, a, {
    householdId: 'family-a', serverVerifiedUserId: hub,
  }), null)
})

test('identical local person/event IDs in separate households never cross-link', t => {
  const { central, a, b, robert, friend, link } = fixture(t)
  link(a, 'family-a', robert, 1)
  link(b, 'family-b', friend, 1)
  assert.deepEqual(getAssignedHouseholdNotificationRecipients(central, a, {
    householdId: 'family-a', eventId: 10,
  }), [{ userId: robert, personId: 1 }])
  assert.deepEqual(getAssignedHouseholdNotificationRecipients(central, b, {
    householdId: 'family-b', eventId: 10,
  }), [{ userId: friend, personId: 1 }])
  assert.equal(getLinkedHouseholdPerson(central, a, {
    householdId: 'family-a', serverVerifiedUserId: friend,
  }), null)
  assert.equal(getLinkedHouseholdPerson(central, b, {
    householdId: 'family-b', serverVerifiedUserId: robert,
  }), null)
})

test('disabled membership, account or household stops new notification recipients', t => {
  const { central, a, robert, haylee, link } = fixture(t)
  link(a, 'family-a', robert, 1)
  link(a, 'family-a', haylee, 2)
  const recipients = () => getAssignedHouseholdNotificationRecipients(central, a, {
    householdId: 'family-a', eventId: 10,
  })
  central.prepare('UPDATE household_memberships SET disabled = 1 WHERE user_id = ?')
    .run(haylee)
  assert.deepEqual(recipients(), [{ userId: robert, personId: 1 }])
  assert.equal(getLinkedHouseholdPerson(central, a, {
    householdId: 'family-a', serverVerifiedUserId: haylee,
  }), null)
  central.prepare('UPDATE family_users SET disabled = 1 WHERE id = ?').run(robert)
  assert.deepEqual(recipients(), [])
  central.prepare('UPDATE family_users SET disabled = 0 WHERE id = ?').run(robert)
  central.prepare('UPDATE household_registry SET disabled = 1 WHERE storage_id = ?')
    .run('family-a')
  assert.deepEqual(recipients(), [])
})
