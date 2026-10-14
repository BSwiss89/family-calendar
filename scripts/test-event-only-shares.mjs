import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  createEventShareTables, inviteSelectedEvents, respondToEventInvitation,
  revokeSelectedEventShare, listAcceptedSharedEvents, listEventShareInvitations,
  synchronizeSelectedEventShare, registerTrustedShareConnection,
  listTrustedEventShareRecipients,
} from '../Server/event-only-shares.mjs'

// Disposable in-memory copies only; no existing preview/live SQLite touched.
function fixture(t) {
  const db = new DatabaseSync(':memory:')
  const source = new DatabaseSync(':memory:')
  t.after(() => { db.close(); source.close() })
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE family_users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE household_registry (
      id INTEGER PRIMARY KEY, storage_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE household_memberships (
      user_id INTEGER NOT NULL, household_id INTEGER NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL,
      PRIMARY KEY(user_id, household_id)
    );
    INSERT INTO family_users(id,username)
      VALUES(1,'alice'),(2,'alex'),(3,'brenda'),(4,'charlie');
    INSERT INTO household_registry(id,storage_id,display_name)
      VALUES(1,'family-a','Family A'),(2,'family-b','Family B'),(3,'family-c','Family C');
    INSERT INTO household_memberships(user_id,household_id,role)
      VALUES(1,1,'owner'),(2,1,'member'),(3,2,'owner'),(4,3,'owner');
  `)
  createEventShareTables(db)
  registerTrustedShareConnection(db, {
    sourceHouseholdId: 'family-a', recipientHouseholdId: 'family-b',
  })
  registerTrustedShareConnection(db, {
    sourceHouseholdId: 'family-a', recipientHouseholdId: 'family-c',
  })
  source.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, title TEXT, date TEXT, end_date TEXT,
      time TEXT, end_time TEXT, repeat_unit TEXT, notes TEXT,
      location TEXT, person TEXT
    );
    INSERT INTO events VALUES
      (1,'A BBQ','2026-12-20',NULL,'12:00','14:00',NULL,
       'PRIVATE NOTES','HOME ADDRESS','PERSON');
    INSERT INTO events VALUES
      (2,'A WORK','2026-12-21',NULL,'07:00','09:00',NULL,
       'PRIVATE NOTES B','PRIVATE LOCATION','B');
    INSERT INTO events VALUES
      (3,'A GIFT','2026-12-22',NULL,NULL,NULL,NULL,
       'SECRET GIFT','PRIVATE','C');
    INSERT INTO events VALUES
      (4,'REPEATING SHIFT','2026-12-23',NULL,'07:00',NULL,'day',
       'SHOULD NOT SHARE','PRIVATE','C');
  `)
  return { db, source }
}
const send = (db, source, eventIds, recipientHouseholdIds, extra = {}) =>
  inviteSelectedEvents(db, {
    sourceDatabase: source, serverVerifiedUserId: 1,
    sourceHouseholdId: 'family-a', eventIds, recipientHouseholdIds, ...extra,
  })
const pending = (db, userId, home) => listEventShareInvitations(db, {
  serverVerifiedUserId: userId, recipientHouseholdId: home,
})
const visible = (db, userId, home) => listAcceptedSharedEvents(db, {
  serverVerifiedUserId: userId, recipientHouseholdId: home,
})

test('one selected event reveals neither other source events nor private event fields', t => {
  const { db, source } = fixture(t)
  assert.deepEqual(visible(db, 3, 'family-b'), [])
  const created = send(db, source, [1], ['family-b'])
  assert.equal(created.length, 1)
  assert.deepEqual(visible(db, 3, 'family-b'), [])
  assert.deepEqual(pending(db, 4, 'family-c'), [])
  assert.deepEqual(pending(db, 3, 'family-b').map(event => event.title), ['A BBQ'])
  assert.equal(pending(db, 3, 'family-b')[0].sharedBy, 'Family A')
  assert.doesNotMatch(JSON.stringify(pending(db, 3, 'family-b')), /PRIVATE|PERSON|HOME ADDRESS/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM household_memberships').get().n, 4)
  respondToEventInvitation(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b', shareId: created[0].shareId, decision: 'accepted',
  })
  assert.deepEqual(visible(db, 3, 'family-b').map(event => event.title), ['A BBQ'])
  assert.doesNotMatch(JSON.stringify(visible(db, 3, 'family-b')),
    /PRIVATE|PERSON|HOME ADDRESS|WORK|GIFT/)
  assert.deepEqual(visible(db, 4, 'family-c'), [])
  // Accepting an individual invitation NEVER adds source-family membership.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM household_memberships').get().n, 4)
})

test('two usernames of the same family can share only handpicked events with named recipients', t => {
  const { db, source } = fixture(t)
  const created = send(db, source, [1, 2], ['family-b', 'family-c'],
    { serverVerifiedUserId: 2 })
  assert.equal(created.length, 4)
  assert.deepEqual(pending(db, 3, 'family-b').map(event => event.title).sort(),
    ['A BBQ', 'A WORK'])
  assert.deepEqual(pending(db, 4, 'family-c').map(event => event.title).sort(),
    ['A BBQ', 'A WORK'])
  respondToEventInvitation(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b', shareId: created[0].shareId, decision: 'accepted',
  })
  respondToEventInvitation(db, {
    serverVerifiedUserId: 4, recipientHouseholdId: 'family-c', shareId: created[1].shareId, decision: 'accepted',
  })
  respondToEventInvitation(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b', shareId: created[2].shareId, decision: 'declined',
  })
  assert.deepEqual(visible(db, 3, 'family-b').map(event => event.title), ['A BBQ'])
  assert.deepEqual(visible(db, 4, 'family-c').map(event => event.title), ['A BBQ'])
  // Revocation of A-to-B's BBQ does not remove A-to-C's BBQ or A-to-C's work invite.
  revokeSelectedEventShare(db, { serverVerifiedUserId: 1, sourceHouseholdId: 'family-a', shareId: created[0].shareId })
  assert.deepEqual(visible(db, 3, 'family-b'), [])
  assert.deepEqual(visible(db, 4, 'family-c').map(event => event.title), ['A BBQ'])
  assert.equal(pending(db, 4, 'family-c').length, 1)
  assert.throws(() => respondToEventInvitation(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b', shareId: created[0].shareId, decision: 'accepted',
  }), /no longer pending/)
})

test('wrong users, broad sharing, recurrence and invalid batches fail without partial grants', t => {
  const { db, source } = fixture(t)
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM event_share_grants').get().n
  assert.throws(() => send(db, source, [1], ['family-b'],
    { serverVerifiedUserId: 3 }), /Not authorized/)
  assert.throws(() => send(db, source, [], ['family-b']), /Select individual/)
  assert.throws(() => send(db, source, [1], ['*']), /Invalid recipient/)
  assert.throws(() => send(db, source, [1], ['family-a']), /own household/)
  assert.throws(() => send(db, source, [4], ['family-b']), /Recurring events require/)
  assert.throws(() => send(db, source, [1, 999], ['family-b']), /does not exist/)
  assert.equal(count(), 0)
  assert.deepEqual(listTrustedEventShareRecipients(db, {
    serverVerifiedUserId: 1, sourceHouseholdId: 'family-a',
  }).map(x => x.householdId), ['family-b', 'family-c'])
  assert.deepEqual(listTrustedEventShareRecipients(db, {
    serverVerifiedUserId: 3, sourceHouseholdId: 'family-b',
  }), [])
  assert.throws(() => listTrustedEventShareRecipients(db, {
    serverVerifiedUserId: 3, sourceHouseholdId: 'family-a',
  }), /Not authorized/)
  assert.throws(() => send(db, source, [1], ['family-c', 'family-b', 'family-c']), /Duplicate/)
  const one = send(db, source, [1], ['family-b'])
  assert.equal(count(), 1)
  assert.throws(() => send(db, source, [2, 1], ['family-b']), /UNIQUE/)
  assert.equal(count(), 1)
  assert.throws(() => pending(db, 1, 'family-b'), /Not authorized/)
  assert.throws(() => visible(db, 3, 'family-a'), /Not authorized/)
  assert.throws(() => respondToEventInvitation(db, {
    serverVerifiedUserId: 1, shareId: one[0].shareId, decision: 'accepted',
  }), /Not authorized/)
  assert.throws(() => revokeSelectedEventShare(db, {
    serverVerifiedUserId: 3, shareId: one[0].shareId,
  }), /Not authorized/)
  assert.deepEqual(visible(db, 3, 'family-b'), [])
  assert.throws(() => respondToEventInvitation(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-a',
    shareId: one[0].shareId, decision: 'accepted',
  }), /selected household/)
  assert.throws(() => revokeSelectedEventShare(db, {
    serverVerifiedUserId: 1, sourceHouseholdId: 'family-b',
    shareId: one[0].shareId,
  }), /selected household/)
})

test('source edit refreshes only selected snapshots and deletion cancels that share', t => {
  const { db, source } = fixture(t)
  const created = send(db, source, [1, 2], ['family-b'])
  respondToEventInvitation(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b', shareId: created[0].shareId, decision: 'accepted',
  })
  source.prepare('UPDATE events SET title=?, time=?, notes=?, location=? WHERE id=1')
    .run('BBQ Updated', '16:00', 'NEW PRIVATE NOTES', 'NEW ADDRESS')
  const refreshed = synchronizeSelectedEventShare(db, {
    serverVerifiedUserId: 2, sourceHouseholdId: 'family-a',
    sourceEventId: 1, sourceDatabase: source,
  })
  assert.equal(refreshed.updated, 1)
  const result = visible(db, 3, 'family-b')
  assert.deepEqual(result.map(event => event.title), ['BBQ Updated'])
  assert.equal(result[0].time, '16:00')
  assert.doesNotMatch(JSON.stringify(result), /NEW PRIVATE|NEW ADDRESS/)
  assert.deepEqual(pending(db, 3, 'family-b').map(event => event.title), ['A WORK'])
  source.prepare('DELETE FROM events WHERE id = ?').run(1)
  const cancelled = synchronizeSelectedEventShare(db, {
    serverVerifiedUserId: 1, sourceHouseholdId: 'family-a',
    sourceEventId: 1, sourceDatabase: source,
  })
  assert.equal(cancelled.cancelled, 1)
  assert.deepEqual(visible(db, 3, 'family-b'), [])
  assert.deepEqual(pending(db, 3, 'family-b').map(event => event.title), ['A WORK'])
})

test('editing a previously shared one-time event into recurrence cancels its old grant', t => {
  const { db, source } = fixture(t)
  const created = send(db, source, [1], ['family-b'])
  respondToEventInvitation(db, {
    serverVerifiedUserId: 3,
    recipientHouseholdId: 'family-b',
    shareId: created[0].shareId,
    decision: 'accepted',
  })
  assert.deepEqual(visible(db, 3, 'family-b').map(e => e.title), ['A BBQ'])
  source.prepare('UPDATE events SET repeat_unit = ? WHERE id = ?').run('week', 1)
  const result = synchronizeSelectedEventShare(db, {
    serverVerifiedUserId: 1,
    sourceHouseholdId: 'family-a',
    sourceEventId: 1,
    sourceDatabase: source,
  })
  assert.equal(result.cancelled, 1)
  assert.deepEqual(visible(db, 3, 'family-b'), [])
  assert.equal(db.prepare('SELECT status FROM event_share_grants WHERE id = ?')
    .get(created[0].shareId).status, 'cancelled')
})

test('only explicitly connected households may receive selected-event invitations', t => {
  const { db, source } = fixture(t)
  db.prepare('DELETE FROM event_share_connections WHERE recipient_household_id = 3').run()
  assert.deepEqual(listTrustedEventShareRecipients(db, {
    serverVerifiedUserId: 1, sourceHouseholdId: 'family-a',
  }).map(row => row.householdId), ['family-b'])
  assert.throws(() => send(db, source, [1], ['family-c']), /not connected/)
  assert.throws(() => send(db, source, [1, 2], ['family-b', 'family-c']), /not connected/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM event_share_grants').get().n, 0)
})
