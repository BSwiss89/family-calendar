// Only synthetic, standalone OS-temp SQLite and uploads. No installed
// family calendar, LIVE, TEST, scheduler, Tailscale or production backup.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'
import {
  createHouseholdMembershipTables, registerHousehold, grantHouseholdMembership,
} from '../Server/household-memberships.mjs'
import { setFamilyAccount } from '../Server/family-auth.mjs'
import {
  createEventShareTables, registerTrustedShareConnection,
  inviteSelectedEvents, respondToEventInvitation, listAcceptedSharedEvents,
} from '../Server/event-only-shares.mjs'
import { createEventShareSyncJournal, markEventShareSyncPending } from '../Server/event-share-sync-journal.mjs'
import { installPrivateEventIdentity } from '../Server/private-event-identity.mjs'
import { verifyOfflinePrivateRestoreSet } from '../Server/private-restore-preflight.mjs'
import { copyVerifiedPrivateRestoreSet } from '../Server/private-offline-restore-rehearsal.mjs'
import { captureDisposableCoordinatedHouseholdSnapshot } from '../Server/private-disposable-coordinated-snapshot.mjs'

const pass = 'Disposable-Only-Strong-Password-123!'
function fixture(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-coordinated-capture-'))
  t.after(() => fs.rmSync(work, { recursive: true, force: true }))
  const serverDirectory = path.join(work, 'checkout', 'Server')
  const sourceRoot = path.join(work, 'offline-input')
  const destinationRoot = path.join(work, 'captured-backup')
  fs.mkdirSync(serverDirectory, { recursive: true })
  fs.mkdirSync(sourceRoot)
  fs.mkdirSync(path.join(sourceRoot, 'central'))
  const homes = ['family-a', 'family-b'].map(id =>
    provisionEmptyHousehold({ serverDirectory, storageRoot: sourceRoot, householdId: id }))
  for (const [i, home] of homes.entries()) {
    const db = new DatabaseSync(home.databasePath)
    try {
      db.exec([
        'CREATE TABLE events(id INTEGER PRIMARY KEY, title TEXT,',
        'date TEXT, end_date TEXT, time TEXT, end_time TEXT,',
        'repeat_unit TEXT) STRICT;',
        'CREATE TABLE lists(id INTEGER PRIMARY KEY, name TEXT) STRICT;',
      ].join(' '))
      installPrivateEventIdentity(db)
      db.prepare('INSERT INTO events(title,date,time) VALUES (?,?,?)')
        .run(i === 0 ? 'Private A BBQ' : 'Private B dinner', '2027-02-06', '18:00')
      db.prepare('INSERT INTO lists(name) VALUES(?)')
        .run(i === 0 ? 'A groceries' : 'B groceries')
    } finally { db.close() }
    fs.mkdirSync(path.join(home.uploadFolder, 'photos'))
    fs.writeFileSync(path.join(home.uploadFolder, 'photos', 'image.bin'),
      Buffer.from([i + 1, 0, 255, 23]))
  }

  const centralPath = path.join(sourceRoot, 'central', 'identity.db')
  const central = new DatabaseSync(centralPath)
  try {
    createHouseholdMembershipTables(central)
    setFamilyAccount(central, 'synthetic-a', 'A Owner', pass)
    setFamilyAccount(central, 'synthetic-b', 'B Owner', pass)
    const ids = ['family-a', 'family-b']
    for (const [i, slug] of ids.entries()) {
      registerHousehold(central, { householdId: slug, displayName: 'Family ' + i })
      const userId = central.prepare('SELECT id FROM family_users WHERE username=?')
        .get('synthetic-' + (i === 0 ? 'a' : 'b')).id
      grantHouseholdMembership(central, {
        serverVerifiedUserId: userId, householdId: slug, role: 'owner',
      })
    }
    createEventShareTables(central)
    createEventShareSyncJournal(central)
    registerTrustedShareConnection(central, {
      sourceHouseholdId: 'family-a', recipientHouseholdId: 'family-b',
    })
    const source = new DatabaseSync(homes[0].databasePath, { readOnly: true })
    try {
      const a = central.prepare("SELECT id FROM family_users WHERE username='synthetic-a'")
        .get().id
      const b = central.prepare("SELECT id FROM family_users WHERE username='synthetic-b'")
        .get().id
      const [invite] = inviteSelectedEvents(central, {
        serverVerifiedUserId: a, sourceHouseholdId: 'family-a',
        eventIds: [1], recipientHouseholdIds: ['family-b'], sourceDatabase: source,
      })
      respondToEventInvitation(central, {
        serverVerifiedUserId: b, recipientHouseholdId: 'family-b',
        shareId: invite.shareId, decision: 'accepted',
      })
    } finally { source.close() }
  } finally { central.close() }

  const args = { serverDirectory, sourceRoot, destinationRoot }
  return { args, work, homes, centralPath }
}
const captured = f => captureDisposableCoordinatedHouseholdSnapshot(f.args)

test('complete two-family offline snapshot contains central identity, private Lists, photos and accepted shares', t => {
  const f = fixture(t)
  const result = captured(f)
  assert.equal(result.capturedFromDisposableOfflineStage, true)
  assert.equal(result.sourceWritersVerifiedStopped, false)
  assert.equal(result.productionBackupAuthorized, false)
  assert.equal(result.householdCount, 2)
  assert.equal(result.snapshotRoot, f.args.destinationRoot)
  assert.deepEqual(verifyOfflinePrivateRestoreSet({
    serverDirectory: f.args.serverDirectory, restoreRoot: result.snapshotRoot,
  }, result.attestation), { ok: true, households: 2, files: result.attestation.files.length })
  assert.equal(fs.existsSync(path.join(f.args.sourceRoot,
    '.family-calendar-restore-review.json')), false, 'source is never marked or modified')
  const copyRoot = path.join(f.work, 'verified-restore')
  copyVerifiedPrivateRestoreSet({
    serverDirectory: f.args.serverDirectory, sourceRoot: result.snapshotRoot,
    destinationRoot: copyRoot, approvedAttestation: result.attestation,
  })
  const db = new DatabaseSync(path.join(copyRoot, 'central', 'identity.db'),
    { readOnly: true })
  try {
    const b = db.prepare("SELECT id FROM family_users WHERE username='synthetic-b'")
      .get().id
    assert.deepEqual(listAcceptedSharedEvents(db, {
      serverVerifiedUserId: b, recipientHouseholdId: 'family-b',
    }).map(x => x.title), ['Private A BBQ'])
  } finally { db.close() }
  for (const [i, slug] of ['family-a', 'family-b'].entries()) {
    const base = path.join(copyRoot, 'households', slug)
    const family = new DatabaseSync(path.join(base, 'data', 'calendar.db'),
      { readOnly: true })
    try {
      assert.equal(family.prepare('SELECT name FROM lists').get().name,
        i === 0 ? 'A groceries' : 'B groceries')
    } finally { family.close() }
    assert.deepEqual([...fs.readFileSync(path.join(base, 'uploads', 'photos', 'image.bin'))],
      [i + 1, 0, 255, 23])
  }
})

test('missing, unexpected or uncheckpointed SQLite sidecar refuses without creating snapshot', t => {
  const f = fixture(t)
  const wal = f.homes[0].databasePath + '-wal'
  fs.writeFileSync(wal, 'synthetic pending journal')
  assert.throws(() => captured(f), /unrecognized or missing files/)
  assert.equal(fs.existsSync(f.args.destinationRoot), false)
  fs.unlinkSync(wal)
  const extra = path.join(f.args.sourceRoot, 'households', 'surprise-household')
  fs.mkdirSync(extra)
  assert.throws(() => captured(f), /unrecognized or missing files|registry does not match/)
  assert.equal(fs.existsSync(f.args.destinationRoot), false)
})

test('a modified source event cannot silently preserve an accepted invitation', t => {
  const f = fixture(t)
  const db = new DatabaseSync(f.homes[0].databasePath)
  try { db.prepare('UPDATE events SET title=? WHERE id=1').run('Changed secret event') }
  finally { db.close() }
  assert.throws(() => captured(f), /active shared invitation does not match/)
  assert.equal(fs.existsSync(f.args.destinationRoot), false)
})

test('pending source sync and restorable active login sessions fail before publication', t => {
  const f = fixture(t)
  const central = new DatabaseSync(f.centralPath)
  try {
    markEventShareSyncPending(central, { sourceHouseholdId: 'family-a', sourceEventId: 1 })
  } finally { central.close() }
  assert.throws(() => captured(f), /unfinished event mutations/)
  const reset = new DatabaseSync(f.centralPath)
  try {
    reset.prepare('DELETE FROM event_share_sync_pending').run()
    const user = reset.prepare("SELECT id FROM family_users WHERE username='synthetic-a'")
      .get().id
    reset.prepare([
      'INSERT INTO family_sessions',
      '(user_id,token_hash,device_label,created_at,last_seen_at,expires_at)',
      'VALUES(?,?,?,?,?,?)',
    ].join(' ')).run(user, 'c'.repeat(64), 'old device',
      Date.now(), Date.now(), Date.now() + 3600000)
  } finally { reset.close() }
  assert.throws(() => captured(f), /restored login session could regain access/)
  assert.equal(fs.existsSync(f.args.destinationRoot), false)
})

test('existing verified backup is never overwritten or deleted on later refusal', t => {
  const f = fixture(t)
  const result = captured(f)
  assert.throws(() => captured(f), /already exists/)
  const snapshotFile = path.join(result.snapshotRoot, 'central', 'identity.db')
  const original = fs.readFileSync(snapshotFile)
  fs.writeFileSync(path.join(f.homes[0].uploadFolder, 'photos', 'image.bin'),
    Buffer.from('changed after capture'))
  assert.throws(() => captured(f), /already exists/)
  assert.deepEqual(fs.readFileSync(snapshotFile), original)
  assert.equal(fs.existsSync(f.args.destinationRoot + '.capture-lock'), false)
})

test('tampered backup file fails independently saved attestation on restore', t => {
  const f = fixture(t)
  const result = captured(f)
  const file = path.join(result.snapshotRoot, 'households', 'family-b',
    'uploads', 'photos', 'image.bin')
  fs.writeFileSync(file, 'TAMPERED')
  assert.throws(() => verifyOfflinePrivateRestoreSet({
    serverDirectory: f.args.serverDirectory, restoreRoot: result.snapshotRoot,
  }, result.attestation), /do not match the approved/)
})

test('root or nested destination and non-temporary source cannot be used', t => {
  const f = fixture(t)
  assert.throws(() => captureDisposableCoordinatedHouseholdSnapshot({
    ...f.args, destinationRoot: path.join(f.args.sourceRoot, 'nested'),
  }), /only separate disposable/)
  assert.throws(() => captureDisposableCoordinatedHouseholdSnapshot({
    ...f.args, sourceRoot: path.dirname(process.execPath),
  }), /only separate disposable/)
  assert.equal(fs.existsSync(f.args.destinationRoot), false)
})
