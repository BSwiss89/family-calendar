// All restore inspections use synthetic databases and uploads in OS temp.
// Never invoke a live restore, stop a server, or access the laptop's data.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'
import { installPrivateEventIdentity } from '../Server/private-event-identity.mjs'
import {
  createHouseholdMembershipTables, registerHousehold, grantHouseholdMembership,
} from '../Server/household-memberships.mjs'
import { setFamilyAccount } from '../Server/family-auth.mjs'
import {
  createEventShareTables, registerTrustedShareConnection,
  inviteSelectedEvents, respondToEventInvitation,
} from '../Server/event-only-shares.mjs'
import {
  createEventShareSyncJournal, markEventShareSyncPending,
} from '../Server/event-share-sync-journal.mjs'
import {
  attestOfflinePrivateRestoreSet, verifyOfflinePrivateRestoreSet,
} from '../Server/private-restore-preflight.mjs'

const password = 'Disposable-Restore-Unit-Tests-Only!'
function fixture(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-offline-restore-'))
  t.after(() => fs.rmSync(work, { recursive: true, force: true }))
  const serverDirectory = path.join(work, 'checkout', 'Server')
  const restoreRoot = path.join(work, 'staged-offline-only')
  fs.mkdirSync(serverDirectory, { recursive: true })
  fs.mkdirSync(restoreRoot)
  fs.writeFileSync(path.join(restoreRoot, '.family-calendar-restore-review.json'),
    JSON.stringify({ kind: 'private-household-offline-restore-review', version: 1 }))
  const centralFolder = path.join(restoreRoot, 'central')
  fs.mkdirSync(centralFolder)
  const sourceDbPath = path.join(centralFolder, 'identity.db')
  const a = provisionEmptyHousehold({
    serverDirectory, storageRoot: restoreRoot, householdId: 'family-a',
  })
  const b = provisionEmptyHousehold({
    serverDirectory, storageRoot: restoreRoot, householdId: 'family-b',
  })
  for (const [storage, title] of [
    [a, 'Family A only BBQ'],
    [b, 'Family B private dinner'],
  ]) {
    const db = new DatabaseSync(storage.databasePath)
    try {
      db.exec([
        'CREATE TABLE events (id INTEGER PRIMARY KEY,',
        'title TEXT NOT NULL, date TEXT NOT NULL, end_date TEXT,',
        'time TEXT, end_time TEXT, repeat_unit TEXT) STRICT;',
      ].join(' '))
      installPrivateEventIdentity(db)
      db.prepare('INSERT INTO events (title, date, time) VALUES (?,?,?)')
        .run(title, '2027-01-20', '18:00')
    } finally {
      db.close()
    }
  }
  fs.writeFileSync(path.join(a.uploadFolder, 'shared-photo.txt'), 'PRIVATE FAMILY A PHOTO')
  fs.writeFileSync(path.join(b.uploadFolder, 'shared-photo.txt'), 'PRIVATE FAMILY B PHOTO')
  const central = new DatabaseSync(sourceDbPath)
  try {
    createHouseholdMembershipTables(central)
    setFamilyAccount(central, 'household-a', 'A owner', password)
    setFamilyAccount(central, 'household-b', 'B owner', password)
    registerHousehold(central, { householdId: 'family-a', displayName: 'Family A' })
    registerHousehold(central, { householdId: 'family-b', displayName: 'Family B' })
    const userA = central.prepare(
      "SELECT id FROM family_users WHERE username='household-a'"
    ).get().id
    const userB = central.prepare(
      "SELECT id FROM family_users WHERE username='household-b'"
    ).get().id
    grantHouseholdMembership(central, {
      serverVerifiedUserId: userA, householdId: 'family-a', role: 'owner',
    })
    grantHouseholdMembership(central, {
      serverVerifiedUserId: userB, householdId: 'family-b', role: 'owner',
    })
    createEventShareTables(central)
    createEventShareSyncJournal(central)
    registerTrustedShareConnection(central, {
      sourceHouseholdId: 'family-a', recipientHouseholdId: 'family-b',
    })
    const source = new DatabaseSync(a.databasePath, { readOnly: true })
    try {
      const [invited] = inviteSelectedEvents(central, {
        serverVerifiedUserId: userA, sourceHouseholdId: 'family-a',
        eventIds: [1], recipientHouseholdIds: ['family-b'],
        sourceDatabase: source,
      })
      respondToEventInvitation(central, {
        serverVerifiedUserId: userB, recipientHouseholdId: 'family-b',
        shareId: invited.shareId, decision: 'accepted',
      })
    } finally {
      source.close()
    }
  } finally {
    central.close()
  }
  return {
    work, restoreRoot, serverDirectory,
    a, b, centralPath: sourceDbPath,
    options: { restoreRoot, serverDirectory },
  }
}

test('offline snapshot attestation validates central identities, two households and uploads', t => {
  const f = fixture(t)
  const approved = attestOfflinePrivateRestoreSet(f.options)
  assert.deepEqual(approved.households, ['family-a', 'family-b'])
  assert.match(approved.sha256, /^[0-9a-f]{64}$/)
  assert.equal(approved.files.some(x => x.path === 'central/identity.db'), true)
  assert.ok(approved.files.some(x => x.path.endsWith('/shared-photo.txt')))
  assert.deepEqual(verifyOfflinePrivateRestoreSet(f.options, approved),
    { ok: true, households: 2, files: approved.files.length })
  assert.equal(fs.existsSync(path.join(f.restoreRoot, 'manifest.json')), false)
})

test('restore refuses any changed photo, source database or central database after attestation', t => {
  const f = fixture(t)
  const approved = attestOfflinePrivateRestoreSet(f.options)
  const photo = path.join(f.a.uploadFolder, 'shared-photo.txt')
  fs.writeFileSync(photo, 'PRIVATE FAMILY A PHOTO CHANGED')
  assert.throws(() => verifyOfflinePrivateRestoreSet(f.options, approved),
    /do not match the approved/)
  fs.writeFileSync(photo, 'PRIVATE FAMILY A PHOTO')
  const source = new DatabaseSync(f.b.databasePath)
  try {
    source.prepare('INSERT INTO events(title,date) VALUES (?,?)')
      .run('Later B private event', '2027-01-21')
  } finally {
    source.close()
  }
  assert.throws(() => verifyOfflinePrivateRestoreSet(f.options, approved),
    /do not match the approved/)
  const newApproved = attestOfflinePrivateRestoreSet(f.options)
  const central = new DatabaseSync(f.centralPath)
  try {
    central.prepare('UPDATE household_registry SET display_name=? WHERE storage_id=?')
      .run('B family changed after backup', 'family-b')
  } finally {
    central.close()
  }
  assert.throws(() => verifyOfflinePrivateRestoreSet(f.options, newApproved),
    /do not match the approved/)
})

test('mixed snapshot source events and central share grants are rejected BEFORE attestation', t => {
  const f = fixture(t)
  const source = new DatabaseSync(f.a.databasePath)
  try {
    source.prepare('UPDATE events SET title=? WHERE id=1').run('Restored older event details')
  } finally {
    source.close()
  }
  assert.throws(() => attestOfflinePrivateRestoreSet(f.options),
    /active shared invitation does not match/)
})

test('reused SQLite ID cannot rebind a restored accepted share to another event', t => {
  const f = fixture(t)
  const source = new DatabaseSync(f.a.databasePath)
  try {
    source.prepare('DELETE FROM events WHERE id=1').run()
    source.prepare('INSERT INTO events(id,title,date) VALUES(1,?,?)')
      .run('Secret replacement', '2027-01-20')
  } finally {
    source.close()
  }
  assert.throws(() => attestOfflinePrivateRestoreSet(f.options),
    /active shared invitation does not match/)
})

test('missing or unexpected households, WAL files and uploads refuse a stage', t => {
  const f = fixture(t)
  const extra = path.join(f.restoreRoot, 'households', 'family-unknown')
  fs.mkdirSync(extra)
  assert.throws(() => attestOfflinePrivateRestoreSet(f.options), /registry does not match/)
  fs.rmSync(extra, { recursive: true })
  const wal = f.a.databasePath + '-wal'
  fs.writeFileSync(wal, 'partial uncheckpointed WAL')
  assert.throws(() => attestOfflinePrivateRestoreSet(f.options), /unexpected or missing/)
  fs.unlinkSync(wal)
  fs.unlinkSync(f.b.databasePath)
  assert.throws(() => attestOfflinePrivateRestoreSet(f.options), /unexpected or missing/)
  assert.equal(fs.existsSync(f.b.databasePath), false)
})

test('unresolved edits and restored active login sessions block restoration', t => {
  const f = fixture(t)
  const db = new DatabaseSync(f.centralPath)
  try {
    markEventShareSyncPending(db, { sourceHouseholdId: 'family-a', sourceEventId: 1 })
  } finally {
    db.close()
  }
  assert.throws(() => attestOfflinePrivateRestoreSet(f.options),
    /unfinished event mutations/)
  const central = new DatabaseSync(f.centralPath)
  try {
    central.prepare('DELETE FROM event_share_sync_pending').run()
    const id = central.prepare(
      "SELECT id FROM family_users WHERE username='household-a'"
    ).get().id
    central.prepare([
      'INSERT INTO family_sessions',
      '(user_id, token_hash, device_label, created_at, last_seen_at, expires_at)',
      'VALUES (?, ?, ?, ?, ?, ?)',
    ].join(' ')).run(id, 'a'.repeat(64), 'stale device', Date.now(), Date.now(),
      Date.now() + 86400000)
  } finally {
    central.close()
  }
  assert.throws(() => attestOfflinePrivateRestoreSet(f.options),
    /restored login session could regain access/)
  // A separate explicit offline sanitization step must revoke old devices.
  const review = new DatabaseSync(f.centralPath)
  try {
    review.prepare('UPDATE family_sessions SET revoked_at=?').run(Date.now())
  } finally { review.close() }
  assert.match(attestOfflinePrivateRestoreSet(f.options).sha256, /^[0-9a-f]{64}$/)
})

test('missing stage marker, symlinks and modified attestation fail without writes', t => {
  const f = fixture(t)
  const approved = attestOfflinePrivateRestoreSet(f.options)
  assert.throws(() => verifyOfflinePrivateRestoreSet(f.options, {
    ...approved, sha256: '0'.repeat(64),
  }), /attestation was modified/)
  assert.throws(() => verifyOfflinePrivateRestoreSet(f.options, null),
    /independent, trusted backup-time attestation/)
  fs.unlinkSync(path.join(f.restoreRoot, '.family-calendar-restore-review.json'))
  assert.throws(() => attestOfflinePrivateRestoreSet(f.options), /unexpected or missing/)
})
