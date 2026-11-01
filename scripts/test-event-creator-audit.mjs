import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  createHouseholdMembershipTables, registerHousehold, grantHouseholdMembership,
} from '../Server/household-memberships.mjs'
import { createFamilyAuthTables, setFamilyAccount } from '../Server/family-auth.mjs'
import {
  createEventCreatorAuditTables, recordAuthenticatedEventCreator,
  listAuthenticatedEventCreators, cleanupDeletedEventCreator,
} from '../Server/event-creator-audit.mjs'

test('old central user schema gains account kind without losing accounts or sessions', t => {
  const central = new DatabaseSync(':memory:')
  t.after(() => central.close())
  central.exec([
    'CREATE TABLE family_users (',
    'id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,',
    'display_name TEXT NOT NULL, password_hash TEXT NOT NULL,',
    'disabled INTEGER NOT NULL DEFAULT 0) STRICT;',
  ].join(' '))
  central.prepare('INSERT INTO family_users(username, display_name, password_hash) VALUES (?, ?, ?)')
    .run('legacyuser', 'Old account', 'hash')
  createFamilyAuthTables(central)
  assert.equal(central.prepare('SELECT account_kind FROM family_users WHERE username = ?')
    .get('legacyuser').account_kind, 'person')
  createFamilyAuthTables(central)
  assert.equal(central.prepare('SELECT COUNT(*) AS n FROM family_users').get().n, 1)
})

test('distinct member and hub logins centrally sign creator data without trusting browser author fields', t => {
  const central = new DatabaseSync(':memory:')
  const source = new DatabaseSync(':memory:')
  t.after(() => { source.close(); central.close() })
  createHouseholdMembershipTables(central)
  setFamilyAccount(central, 'mobilemember', 'Mobile Member',
    'Private-Test-Password-For-Member-123')
  setFamilyAccount(central, 'livingroomhub', 'Living Room Hub',
    'Private-Test-Password-For-Hub-456', { accountKind: 'hub' })
  setFamilyAccount(central, 'othermember', 'Other Member',
    'Private-Test-Password-For-Other-789')
  registerHousehold(central, { householdId: 'family-a', displayName: 'Family A' })
  registerHousehold(central, { householdId: 'family-b', displayName: 'Family B' })
  const getId = name => central.prepare('SELECT id FROM family_users WHERE username = ?')
    .get(name).id
  const member = getId('mobilemember')
  const hub = getId('livingroomhub')
  const outsider = getId('othermember')
  grantHouseholdMembership(central, {
    serverVerifiedUserId: member, householdId: 'family-a', role: 'owner',
  })
  grantHouseholdMembership(central, {
    serverVerifiedUserId: hub, householdId: 'family-a', role: 'member',
  })
  grantHouseholdMembership(central, {
    serverVerifiedUserId: outsider, householdId: 'family-b', role: 'owner',
  })
  createEventCreatorAuditTables(central)
  source.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, title TEXT)')
  source.prepare('INSERT INTO events(id,title) VALUES (?,?)').run(1, 'Family event 1')
  source.prepare('INSERT INTO events(id,title) VALUES (?,?)').run(2, 'Family event 2')

  const record = (verifiedUserId, eventId) => recordAuthenticatedEventCreator(central, {
    verifiedUserId, verifiedHouseholdId: 'family-a', eventId, trustedSourceDb: source,
  })
  record(member, 1)
  record(hub, 2)
  const visible = listAuthenticatedEventCreators(central, {
    verifiedUserId: member, verifiedHouseholdId: 'family-a', trustedSourceDb: source,
  })
  assert.deepEqual(visible.map(v => [v.eventId, v.displayName, v.accountKind]), [
    [1, 'Mobile Member', 'person'], [2, 'Living Room Hub', 'hub'],
  ])
  assert.equal(Object.hasOwn(visible[0], 'password_hash'), false)
  assert.throws(() => record(outsider, 1), /No household membership/)
  assert.throws(() => listAuthenticatedEventCreators(central, {
    verifiedUserId: outsider, verifiedHouseholdId: 'family-a', trustedSourceDb: source,
  }), /No household membership/)
  assert.throws(() => record(member, 100), /not committed/)
  assert.throws(() => record(member, -1), /Invalid/)
  assert.equal(central.prepare('SELECT COUNT(*) AS n FROM event_creator_audit')
    .get().n, 2)

  source.prepare('DELETE FROM events WHERE id = ?').run(1)
  assert.deepEqual(listAuthenticatedEventCreators(central, {
    verifiedUserId: member, verifiedHouseholdId: 'family-a', trustedSourceDb: source,
  }).map(v => v.eventId), [2])
  assert.equal(cleanupDeletedEventCreator(central, {
    verifiedUserId: member, verifiedHouseholdId: 'family-a',
    eventId: 1, trustedSourceDb: source,
  }), true)

  // Reused SQLite row ID is attributed to the new server-verified creator,
  // never to the previous account that created the deleted event.
  source.prepare('INSERT INTO events(id,title) VALUES (?,?)').run(1, 'New event')
  record(hub, 1)
  const relisted = listAuthenticatedEventCreators(central, {
    verifiedUserId: member, verifiedHouseholdId: 'family-a', trustedSourceDb: source,
  })
  assert.equal(relisted.find(v => v.eventId === 1).displayName, 'Living Room Hub')
  assert.equal(relisted.find(v => v.eventId === 1).accountKind, 'hub')
})
