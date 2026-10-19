import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { installPrivateEventIdentity } from '../Server/private-event-identity.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createEventShareSyncJournal, markEventShareSyncPending,
  markEventShareSyncInFlight, acknowledgeEventShareSyncInFlight,
  countPendingEventShareSync, countUnresolvedEventShareSync,
  replayEventShareSyncPending,
} from '../Server/event-share-sync-journal.mjs'
import {
  createEventShareTables, inviteSelectedEvents, respondToEventInvitation,
  revokeSelectedEventShare, removeReceivedEventShare, listAcceptedSharedEvents, listEventShareInvitations,
  synchronizeSelectedEventShare, registerTrustedShareConnection,
  listTrustedEventShareRecipients, listOutgoingEventShares,
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
  installPrivateEventIdentity(source)
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

test('outgoing invites are visible only to source family members and can be individually revoked', t => {
  const { db, source } = fixture(t)
  const created = send(db, source, [1, 2], ['family-b'])
  const sentA = listOutgoingEventShares(db, {
    serverVerifiedUserId: 2, sourceHouseholdId: 'family-a',
  })
  assert.deepEqual(sentA.map(item => item.title), ['A BBQ', 'A WORK'])
  assert.deepEqual(sentA.map(item => item.status), ['pending', 'pending'])
  assert.equal(sentA[0].recipientDisplayName, 'Family B')
  assert.equal(Object.hasOwn(sentA[0], 'notes'), false)
  assert.throws(() => listOutgoingEventShares(db, {
    serverVerifiedUserId: 3, sourceHouseholdId: 'family-a',
  }), /Not authorized/)
  assert.deepEqual(listOutgoingEventShares(db, {
    serverVerifiedUserId: 3, sourceHouseholdId: 'family-b',
  }), [])

  respondToEventInvitation(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: created[0].shareId, decision: 'accepted',
  })
  assert.deepEqual(listOutgoingEventShares(db, {
    serverVerifiedUserId: 1, sourceHouseholdId: 'family-a',
  }).map(item => item.status), ['accepted', 'pending'])
  revokeSelectedEventShare(db, {
    serverVerifiedUserId: 2, sourceHouseholdId: 'family-a',
    shareId: created[0].shareId,
  })
  assert.deepEqual(listOutgoingEventShares(db, {
    serverVerifiedUserId: 1, sourceHouseholdId: 'family-a',
  }).map(item => item.title), ['A BBQ', 'A WORK'])
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
  assert.throws(() => send(db, source, [2, 1], ['family-b']), /already waiting/)
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

test('explicit re-invites retain historical revoked and declined grants without auto-acceptance', t => {
  const { db, source } = fixture(t)
  const original = send(db, source, [1, 2], ['family-b'])
  respondToEventInvitation(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: original[0].shareId, decision: 'accepted',
  })
  revokeSelectedEventShare(db, {
    serverVerifiedUserId: 1, sourceHouseholdId: 'family-a', shareId: original[0].shareId,
  })
  respondToEventInvitation(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: original[1].shareId, decision: 'declined',
  })
  assert.throws(() => send(db, source, [1, 2], ['family-b']), /previously sent/)
  const resent = send(db, source, [1, 2], ['family-b'], { allowResend: true })
  assert.equal(new Set([...original, ...resent].map(row => row.shareId)).size, 4)
  assert.deepEqual(visible(db, 3, 'family-b'), [])
  assert.deepEqual(pending(db, 3, 'family-b').map(row => row.title), ['A BBQ', 'A WORK'])
  assert.deepEqual(db.prepare(
    'SELECT status FROM event_share_grants WHERE id IN (?, ?) ORDER BY id'
  ).all(original[0].shareId, original[1].shareId).map(row => row.status), ['revoked', 'declined'])
  assert.throws(() => respondToEventInvitation(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: original[0].shareId, decision: 'accepted',
  }), /no longer pending/)
  assert.throws(() => send(db, source, [1], ['family-b']), /already waiting/)
  assert.throws(() => send(db, source, [1], ['family-b'], { allowResend: true }), /already waiting/)
  respondToEventInvitation(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: resent[0].shareId, decision: 'accepted',
  })
  assert.deepEqual(visible(db, 3, 'family-b').map(row => row.title), ['A BBQ'])
})

test('recycled source event ID does not collide with historical cancelled share', t => {
  const { db, source } = fixture(t)
  const original = send(db, source, [1], ['family-b'])[0]
  respondToEventInvitation(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: original.shareId, decision: 'accepted',
  })
  source.prepare('DELETE FROM events WHERE id = ?').run(1)
  const sync = synchronizeSelectedEventShare(db, {
    serverVerifiedUserId: 1, sourceHouseholdId: 'family-a',
    sourceEventId: 1, sourceDatabase: source,
  })
  assert.equal(sync.cancelled, 1)
  source.prepare([
    'INSERT INTO events (id, title, date, time, end_time, repeat_unit)',
    "VALUES (1, 'NEW EVENT', '2026-12-27', '19:00', '20:00', NULL)",
  ].join(' ')).run()
  const newer = send(db, source, [1], ['family-b'], { allowResend: true })[0]
  assert.notEqual(newer.shareId, original.shareId)
  assert.deepEqual(visible(db, 3, 'family-b'), [])
  assert.deepEqual(pending(db, 3, 'family-b').map(row => row.title), ['NEW EVENT'])
  assert.equal(db.prepare('SELECT status FROM event_share_grants WHERE id = ?')
    .get(original.shareId).status, 'cancelled')
  respondToEventInvitation(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: newer.shareId, decision: 'accepted',
  })
  assert.deepEqual(visible(db, 3, 'family-b').map(row => row.title), ['NEW EVENT'])
})

test('legacy lifetime-unique grants migrate transactionally and preserve inactive history', t => {
  const { db, source } = fixture(t)
  db.exec('DROP TABLE event_share_grants;')
  db.exec([
    'CREATE TABLE event_share_grants (',
    'id INTEGER PRIMARY KEY,',
    'source_household_id INTEGER NOT NULL REFERENCES household_registry(id),',
    'recipient_household_id INTEGER NOT NULL REFERENCES household_registry(id),',
    'source_event_id INTEGER NOT NULL CHECK(source_event_id > 0),',
    'created_by_user_id INTEGER NOT NULL REFERENCES family_users(id),',
    "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','revoked','cancelled')),",
    'title TEXT NOT NULL, date TEXT NOT NULL, end_date TEXT, time TEXT, end_time TEXT,',
    'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, responded_at INTEGER,',
    'CHECK(source_household_id != recipient_household_id),',
    'UNIQUE(source_household_id, recipient_household_id, source_event_id)',
    ') STRICT;',
  ].join(' '))
  db.prepare([
    'INSERT INTO event_share_grants',
    '(id,source_household_id,recipient_household_id,source_event_id,created_by_user_id,',
    'status,title,date,end_date,time,end_time,created_at,updated_at,responded_at)',
    "VALUES (41,1,2,1,1,'cancelled','A BBQ','2026-12-20',NULL,'12:00','14:00',123,124,NULL)",
  ].join(' ')).run()
  createEventShareTables(db)
  createEventShareTables(db)
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'event_share_grants'").get().sql, /'removed'/)
  assert.equal(db.prepare('SELECT status FROM event_share_grants WHERE id = 41')
    .get().status, 'cancelled')
  const renewed = send(db, source, [1], ['family-b'], { allowResend: true })[0]
  assert.ok(renewed.shareId > 41)
  assert.deepEqual(pending(db, 3, 'family-b').map(row => row.title), ['A BBQ'])
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM event_share_grants')
    .get().count, 2)
  const indexes = db.prepare("PRAGMA index_list('event_share_grants')").all()
  assert.ok(indexes.some(row => row.name === 'event_share_live_pair_idx' && row.partial === 1))
})

test('pending or accepted share never triggers a duplicate invite even with resend confirmation', t => {
  const { db, source } = fixture(t)
  const original = send(db, source, [1], ['family-b'])[0]
  assert.throws(() => send(db, source, [1], ['family-b'], { allowResend: true }), /already waiting/)
  assert.deepEqual(pending(db, 3, 'family-b').map(row => row.shareId), [original.shareId])
  respondToEventInvitation(db, { serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: original.shareId, decision: 'accepted' })
  assert.throws(() => send(db, source, [1], ['family-b'], { allowResend: true }), /already on the receiving calendar/)
  assert.deepEqual(visible(db, 3, 'family-b').map(row => row.shareId), [original.shareId])
  assert.deepEqual(pending(db, 3, 'family-b'), [])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM event_share_grants').get().n, 1)
  revokeSelectedEventShare(db, { serverVerifiedUserId: 1, sourceHouseholdId: 'family-a',
    shareId: original.shareId })
  assert.deepEqual(visible(db, 3, 'family-b'), [])
  assert.throws(() => send(db, source, [1], ['family-b']), /previously sent/)
  const resent = send(db, source, [1], ['family-b'], { allowResend: true })[0]
  assert.notEqual(resent.shareId, original.shareId)
  assert.deepEqual(pending(db, 3, 'family-b').map(row => row.shareId), [resent.shareId])
  assert.deepEqual(visible(db, 3, 'family-b'), [])
  respondToEventInvitation(db, { serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: resent.shareId, decision: 'accepted' })
  assert.deepEqual(visible(db, 3, 'family-b').map(row => row.shareId), [resent.shareId])
})

test('previously declined invitation can be resent once, never duplicated while waiting', t => {
  const { db, source } = fixture(t)
  const old = send(db, source, [1], ['family-b'])[0]
  respondToEventInvitation(db, { serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: old.shareId, decision: 'declined' })
  assert.deepEqual(pending(db, 3, 'family-b'), [])
  assert.throws(() => send(db, source, [1], ['family-b']), /previously sent/)
  const newer = send(db, source, [1], ['family-b'], { allowResend: true })[0]
  assert.deepEqual(pending(db, 3, 'family-b').map(row => row.shareId), [newer.shareId])
  assert.throws(() => send(db, source, [1], ['family-b'], { allowResend: true }), /already waiting/)
  assert.equal(db.prepare('SELECT status FROM event_share_grants WHERE id=?').get(old.shareId).status, 'declined')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM event_share_grants').get().n, 2)
})

test('mixed recipient resend batch rejects active invitation atomically', t => {
  const { db, source } = fixture(t)
  const original = send(db, source, [1], ['family-b'])[0]
  assert.throws(() => send(db, source, [1], ['family-b','family-c'],
    { allowResend: true }), /already waiting/)
  assert.deepEqual(pending(db, 4, 'family-c'), [])
  respondToEventInvitation(db, { serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: original.shareId, decision: 'declined' })
  assert.throws(() => send(db, source, [1], ['family-b','family-c']), /previously sent/)
  assert.deepEqual(pending(db, 4, 'family-c'), [])
  const sent = send(db, source, [1], ['family-b','family-c'], { allowResend: true })
  assert.equal(sent.length, 2)
  assert.equal(pending(db, 3, 'family-b').length, 1)
  assert.equal(pending(db, 4, 'family-c').length, 1)
})

test('recipient can remove only their own accepted snapshot; source and other recipients remain intact', t => {
  const { db, source } = fixture(t)
  const shares = send(db, source, [1], ['family-b', 'family-c'])
  const familyB = shares.find(x => x.recipientHouseholdId === 'family-b')
  const familyC = shares.find(x => x.recipientHouseholdId === 'family-c')
  for (const [user, house, share] of [[3, 'family-b', familyB], [4, 'family-c', familyC]]) {
    respondToEventInvitation(db, { serverVerifiedUserId: user,
      recipientHouseholdId: house, shareId: share.shareId, decision: 'accepted' })
  }
  assert.throws(() => removeReceivedEventShare(db, {
    serverVerifiedUserId: 1, recipientHouseholdId: 'family-b',
    shareId: familyB.shareId,
  }), /Not authorized/)
  assert.throws(() => removeReceivedEventShare(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: familyC.shareId,
  }), /Not authorized/)
  assert.throws(() => removeReceivedEventShare(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: 999999,
  }), /not available/)
  assert.deepEqual(removeReceivedEventShare(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: familyB.shareId,
  }), { shareId: familyB.shareId, status: 'removed' })
  assert.deepEqual(visible(db, 3, 'family-b'), [])
  assert.deepEqual(pending(db, 3, 'family-b'), [])
  assert.deepEqual(visible(db, 4, 'family-c').map(x => x.title), ['A BBQ'])
  assert.equal(source.prepare('SELECT title FROM events WHERE id=1').get().title, 'A BBQ')
  assert.equal(db.prepare('SELECT status FROM event_share_grants WHERE id=?')
    .get(familyB.shareId).status, 'removed')
  assert.throws(() => removeReceivedEventShare(db, {
    serverVerifiedUserId: 3, recipientHouseholdId: 'family-b',
    shareId: familyB.shareId,
  }), /unavailable/)
  assert.throws(() => send(db, source, [1], ['family-b']), /previously sent/)
  const resent = send(db, source, [1], ['family-b'], { allowResend: true })[0]
  assert.notEqual(resent.shareId, familyB.shareId)
  assert.deepEqual(pending(db, 3, 'family-b').map(x => x.shareId), [resent.shareId])
  assert.deepEqual(visible(db, 4, 'family-c').map(x => x.shareId), [familyC.shareId])
  respondToEventInvitation(db, { serverVerifiedUserId: 3,
    recipientHouseholdId: 'family-b', shareId: resent.shareId, decision: 'accepted' })
  assert.deepEqual(visible(db, 3, 'family-b').map(x => x.shareId), [resent.shareId])
  assert.deepEqual(visible(db, 4, 'family-c').map(x => x.shareId), [familyC.shareId])
})

test('recipient cannot remove pending, declined, revoked or source-cancelled shares', t => {
  const { db, source } = fixture(t)
  const [pendingShare, declinedShare, revokedShare, cancelledShare] =
    send(db, source, [1, 2], ['family-b','family-c'])
  // Ordering is event-major: B1, C1, B2, C2.
  assert.equal(pendingShare.recipientHouseholdId, 'family-b')
  assert.throws(() => removeReceivedEventShare(db, { serverVerifiedUserId: 3,
    recipientHouseholdId: 'family-b', shareId: pendingShare.shareId }), /unavailable/)
  respondToEventInvitation(db, { serverVerifiedUserId: 4,
    recipientHouseholdId: 'family-c', shareId: declinedShare.shareId, decision: 'declined' })
  assert.throws(() => removeReceivedEventShare(db, { serverVerifiedUserId: 4,
    recipientHouseholdId: 'family-c', shareId: declinedShare.shareId }), /unavailable/)
  revokeSelectedEventShare(db, { serverVerifiedUserId: 1,
    sourceHouseholdId: 'family-a', shareId: revokedShare.shareId })
  assert.throws(() => removeReceivedEventShare(db, { serverVerifiedUserId: 3,
    recipientHouseholdId: 'family-b', shareId: revokedShare.shareId }), /unavailable/)
  source.prepare('DELETE FROM events WHERE id=?').run(2)
  synchronizeSelectedEventShare(db, { serverVerifiedUserId: 1,
    sourceHouseholdId: 'family-a', sourceEventId: 2, sourceDatabase: source })
  assert.throws(() => removeReceivedEventShare(db, { serverVerifiedUserId: 4,
    recipientHouseholdId: 'family-c', shareId: cancelledShare.shareId }), /unavailable/)
  assert.deepEqual(pending(db, 3, 'family-b').map(x => x.title), ['A BBQ'])
})

test('durable journal replays a missed shared-event edit exactly once', t => {
  const { db, source } = fixture(t)
  createEventShareSyncJournal(db)
  createEventShareSyncJournal(db)
  const [share] = send(db, source, [1], ['family-b'])
  respondToEventInvitation(db, { serverVerifiedUserId: 3,
    recipientHouseholdId: 'family-b', shareId: share.shareId, decision: 'accepted' })
  assert.equal(markEventShareSyncPending(db, {
    sourceHouseholdId: 'family-a', sourceEventId: 1,
  }), 1)
  source.prepare('UPDATE events SET title = ?, time = ? WHERE id = 1')
    .run('Rescheduled Family A BBQ', '15:00')
  // Simulate process death between the committed backend edit and the usual
  // post-response sharing sync. Central queue survives, snapshot is still old.
  assert.deepEqual(visible(db, 3, 'family-b').map(x => x.title), ['A BBQ'])
  const reconcile = ({ sourceEventId }) => synchronizeSelectedEventShare(db, {
    serverVerifiedUserId: 1, sourceHouseholdId: 'family-a',
    sourceEventId, sourceDatabase: source,
  })
  assert.deepEqual(replayEventShareSyncPending(db, {
    sourceHouseholdId: 'family-a', apply: reconcile,
  }), { replayed: 1, remaining: 0 })
  assert.deepEqual(visible(db, 3, 'family-b').map(x => [x.title, x.time]),
    [['Rescheduled Family A BBQ', '15:00']])
  assert.deepEqual(replayEventShareSyncPending(db, {
    sourceHouseholdId: 'family-a', apply: reconcile,
  }), { replayed: 0, remaining: 0 })
})

test('failed replay rolls back share update and keeps work queued for retry', t => {
  const { db, source } = fixture(t)
  createEventShareSyncJournal(db)
  const [share] = send(db, source, [1], ['family-b'])
  respondToEventInvitation(db, { serverVerifiedUserId: 3,
    recipientHouseholdId: 'family-b', shareId: share.shareId, decision: 'accepted' })
  markEventShareSyncPending(db, { sourceHouseholdId: 'family-a', sourceEventId: 1 })
  source.prepare('DELETE FROM events WHERE id = ?').run(1)
  assert.throws(() => replayEventShareSyncPending(db, {
    sourceHouseholdId: 'family-a',
    apply: ({ sourceEventId }) => {
      synchronizeSelectedEventShare(db, { serverVerifiedUserId: 1,
        sourceHouseholdId: 'family-a', sourceEventId, sourceDatabase: source })
      throw new Error('Crash between share change and acknowledgement')
    },
  }), /Crash between share change/)
  assert.equal(countPendingEventShareSync(db), 1)
  assert.deepEqual(visible(db, 3, 'family-b').map(x => x.title), ['A BBQ'])
  assert.deepEqual(replayEventShareSyncPending(db, {
    sourceHouseholdId: 'family-a',
    apply: ({ sourceEventId }) => synchronizeSelectedEventShare(db, {
      serverVerifiedUserId: 1, sourceHouseholdId: 'family-a',
      sourceEventId, sourceDatabase: source,
    }),
  }), { replayed: 1, remaining: 0 })
  assert.deepEqual(visible(db, 3, 'family-b'), [])
  assert.equal(db.prepare('SELECT status FROM event_share_grants WHERE id = ?')
    .get(share.shareId).status, 'cancelled')
})

test('journal persists across closing and reopening central SQLite', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'family-calendar-sync-journal-'))
  let recovered
  t.after(() => {
    recovered?.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const databasePath = path.join(root, 'central.db')
  const first = new DatabaseSync(databasePath)
  first.exec(`CREATE TABLE household_registry (
    id INTEGER PRIMARY KEY, storage_id TEXT UNIQUE, disabled INTEGER DEFAULT 0
  ) STRICT;
  INSERT INTO household_registry (id,storage_id) VALUES (1,'family-a'),(2,'family-b');
  CREATE TABLE sync_test_effects (id INTEGER PRIMARY KEY, note TEXT);`)
  createEventShareSyncJournal(first)
  markEventShareSyncPending(first, { sourceHouseholdId: 'family-a', sourceEventId: 17 })
  markEventShareSyncPending(first, { sourceHouseholdId: 'family-a', sourceEventId: 17 })
  assert.equal(countPendingEventShareSync(first), 1)
  assert.equal(first.prepare('SELECT revision FROM event_share_sync_pending').get().revision, 2)
  first.close()
  recovered = new DatabaseSync(databasePath)
  assert.equal(countPendingEventShareSync(recovered), 1)
  assert.deepEqual(replayEventShareSyncPending(recovered, {
    sourceHouseholdId: 'family-a',
    apply: ({ sourceEventId }) => recovered.prepare(
      'INSERT INTO sync_test_effects(id, note) VALUES (?, ?)'
    ).run(sourceEventId, 'replayed after restart'),
  }), { replayed: 1, remaining: 0 })
  assert.equal(recovered.prepare('SELECT note FROM sync_test_effects WHERE id = 17')
    .get().note, 'replayed after restart')
  assert.equal(countPendingEventShareSync(recovered), 0)
})

test('sync journal rejects untrusted household and event IDs', t => {
  const { db } = fixture(t)
  createEventShareSyncJournal(db)
  assert.throws(() => markEventShareSyncPending(db, {
    sourceHouseholdId: '../family-b', sourceEventId: 1,
  }), /Invalid trusted source/)
  assert.throws(() => markEventShareSyncPending(db, {
    sourceHouseholdId: 'family-unknown', sourceEventId: 1,
  }), /not available/)
  assert.throws(() => markEventShareSyncPending(db, {
    sourceHouseholdId: 'family-a', sourceEventId: -2,
  }), /Invalid source event/)
  assert.throws(() => replayEventShareSyncPending(db, {
    sourceHouseholdId: 'family-a', apply: () => {}, limit: 0,
  }), /Invalid sync replay batch size/)
  assert.equal(countPendingEventShareSync(db), 0)
})

test('browser disconnect cannot acknowledge unfinished backend mutation', t => {
  const { db, source } = fixture(t)
  createEventShareSyncJournal(db)
  const [share] = send(db, source, [1], ['family-b'])
  respondToEventInvitation(db, { serverVerifiedUserId: 3,
    recipientHouseholdId: 'family-b', shareId: share.shareId, decision: 'accepted' })
  markEventShareSyncInFlight(db, {
    sourceHouseholdId: 'family-a', sourceEventId: 1,
  })
  // The real backend has not returned, so a client dropping its socket
  // must NEVER remove this pending intent or serve the old snapshot.
  assert.equal(countUnresolvedEventShareSync(db), 1)
  assert.throws(() => replayEventShareSyncPending(db, {
    sourceHouseholdId: 'family-a',
    apply: ({ sourceEventId }) => synchronizeSelectedEventShare(db, {
      serverVerifiedUserId: 1, sourceHouseholdId: 'family-a',
      sourceEventId, sourceDatabase: source,
    }),
  }), /Unacknowledged source mutation/)
  assert.equal(countPendingEventShareSync(db), 1)
  source.prepare('UPDATE events SET title=? WHERE id=1').run('After dropped browser')
  acknowledgeEventShareSyncInFlight(db, {
    sourceHouseholdId: 'family-a', sourceEventId: 1,
  })
  assert.equal(countUnresolvedEventShareSync(db), 0)
  assert.deepEqual(replayEventShareSyncPending(db, {
    sourceHouseholdId: 'family-a',
    apply: ({ sourceEventId }) => synchronizeSelectedEventShare(db, {
      serverVerifiedUserId: 1, sourceHouseholdId: 'family-a',
      sourceEventId, sourceDatabase: source,
    }),
  }), { replayed: 1, remaining: 0 })
  assert.deepEqual(visible(db, 3, 'family-b').map(x => x.title),
    ['After dropped browser'])
  assert.throws(() => acknowledgeEventShareSyncInFlight(db, {
    sourceHouseholdId: 'family-a', sourceEventId: 1,
  }), /No in-flight event mutation/)
})

test('two concurrent edits require two backend acknowledgements', t => {
  const { db, source } = fixture(t)
  createEventShareSyncJournal(db)
  markEventShareSyncInFlight(db, {
    sourceHouseholdId: 'family-a', sourceEventId: 1,
  })
  markEventShareSyncInFlight(db, {
    sourceHouseholdId: 'family-a', sourceEventId: 1,
  })
  assert.equal(db.prepare('SELECT in_flight_count FROM event_share_sync_pending')
    .get().in_flight_count, 2)
  acknowledgeEventShareSyncInFlight(db, {
    sourceHouseholdId: 'family-a', sourceEventId: 1,
  })
  assert.equal(countUnresolvedEventShareSync(db), 1)
  assert.throws(() => replayEventShareSyncPending(db, {
    sourceHouseholdId: 'family-a', apply: () => {},
  }), /Unacknowledged/)
  source.prepare('UPDATE events SET title=? WHERE id=1').run('Final edit')
  acknowledgeEventShareSyncInFlight(db, {
    sourceHouseholdId: 'family-a', sourceEventId: 1,
  })
  assert.deepEqual(replayEventShareSyncPending(db, {
    sourceHouseholdId: 'family-a', apply: () => {},
  }), { replayed: 1, remaining: 0 })
})

test('legacy ready journal rows migrate without losing revisions', t => {
  const { db } = fixture(t)
  db.exec(`CREATE TABLE event_share_sync_pending (
    source_household_id INTEGER NOT NULL,
    source_event_id INTEGER NOT NULL,
    revision INTEGER NOT NULL, queued_at INTEGER NOT NULL,
    PRIMARY KEY(source_household_id,source_event_id)
  ) STRICT;
  INSERT INTO event_share_sync_pending VALUES(1,1,4,100);`)
  createEventShareSyncJournal(db)
  createEventShareSyncJournal(db)
  assert.deepEqual(db.prepare(
    'SELECT revision,in_flight_count FROM event_share_sync_pending'
  ).get().revision, 4)
  assert.equal(countUnresolvedEventShareSync(db), 0)
  assert.deepEqual(replayEventShareSyncPending(db, {
    sourceHouseholdId: 'family-a', apply: () => {},
  }), { replayed: 1, remaining: 0 })
})
