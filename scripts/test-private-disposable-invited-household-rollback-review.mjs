// THREE-FAMILY DISPOSABLE OFFLINE BACKUP + RESTORE REHEARSAL. Never uses the
// installed LIVE/TEST sites, real user sessions, tasks, services, or ports.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setFamilyAccount } from '../Server/family-auth.mjs'
import { createHouseholdMembershipTables, registerHousehold, grantHouseholdMembership }
  from '../Server/household-memberships.mjs'
import { createIndependentHouseholdInvitationTables, issueIndependentHouseholdInvitation,
  redeemIndependentHouseholdInvitation } from '../Server/independent-household-invitations.mjs'
import { createPrivateActivationRecords } from '../Server/private-household-activation-records.mjs'
import { createEventShareTables } from '../Server/event-only-shares.mjs'
import { createEventShareSyncJournal } from '../Server/event-share-sync-journal.mjs'
import { provisionEmptyHousehold, resolveHouseholdStorage } from '../Server/household-storage.mjs'
import { installPrivateEventIdentity } from '../Server/private-event-identity.mjs'
import { captureDisposableCoordinatedHouseholdSnapshot }
  from '../Server/private-disposable-coordinated-snapshot.mjs'
import { attestOfflinePrivateRestoreSet, verifyOfflinePrivateRestoreSet }
  from '../Server/private-restore-preflight.mjs'
import { copyVerifiedPrivateRestoreSet } from '../Server/private-offline-restore-rehearsal.mjs'
import { reviewDisposableInvitedHouseholdRollback }
  from '../Server/private-disposable-invited-household-rollback-review.mjs'

const pwd = 'Only-Disposable-Invited-Owner-Backup-Rehearsal-123!'
const initial = ['original-family-one', 'original-family-two']

function bootstrap(storage, event, list, byte) {
  const db = new DatabaseSync(storage.databasePath)
  try {
    db.exec([
      'CREATE TABLE events(id INTEGER PRIMARY KEY, title TEXT NOT NULL,',
      'date TEXT, end_date TEXT, time TEXT, end_time TEXT, repeat_unit TEXT) STRICT;',
      'CREATE TABLE lists(id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;',
    ].join(' '))
    installPrivateEventIdentity(db)
    db.prepare('INSERT INTO events(title,date,time) VALUES (?,?,?)')
      .run(event, '2027-01-15', '12:00')
    db.prepare('INSERT INTO lists(name) VALUES (?)').run(list)
  } finally { db.close() }
  fs.writeFileSync(path.join(storage.uploadFolder, 'private.bin'), Buffer.from([byte, 3, 255]))
}

function fixture(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-three-family-restore-'))
  t.after(() => fs.rmSync(work, { recursive: true, force: true }))
  const serverDirectory = path.join(work, 'checkout', 'Server')
  const sourceRoot = path.join(work, 'offline-source')
  const baselineSnapshotRoot = path.join(work, 'offline-before')
  const expandedSnapshotRoot = path.join(work, 'offline-after')
  fs.mkdirSync(serverDirectory, { recursive: true })
  fs.mkdirSync(path.join(sourceRoot, 'central'), { recursive: true })
  for (const [i, id] of initial.entries()) {
    const storage = provisionEmptyHousehold({
      serverDirectory, storageRoot: sourceRoot, householdId: id,
    })
    bootstrap(storage, 'Old private event ' + i, 'Old list ' + i, i + 1)
  }
  const centralPath = path.join(sourceRoot, 'central', 'identity.db')
  const db = new DatabaseSync(centralPath)
  try {
    createHouseholdMembershipTables(db)
    createIndependentHouseholdInvitationTables(db)
    createPrivateActivationRecords(db)
    createEventShareTables(db)
    createEventShareSyncJournal(db)
    for (const [i, id] of initial.entries()) {
      const username = 'oldowner' + i
      setFamilyAccount(db, username, 'Old Owner ' + i, pwd)
      registerHousehold(db, { householdId: id, displayName: 'Original ' + i })
      grantHouseholdMembership(db, {
        serverVerifiedUserId: db.prepare(
          'SELECT id FROM family_users WHERE username = ?'
        ).get(username).id, householdId: id, role: 'owner',
      })
    }
  } finally { db.close() }
  const capture = destinationRoot => captureDisposableCoordinatedHouseholdSnapshot({
    serverDirectory, sourceRoot, destinationRoot,
  })
  const before = capture(baselineSnapshotRoot)
  let newId
  const identity = new DatabaseSync(centralPath)
  try {
    const operator = identity.prepare(
      "SELECT id FROM family_users WHERE username = 'oldowner0'"
    ).get().id
    const issued = issueIndependentHouseholdInvitation(identity, {
      serverVerifiedAdministratorUserId: operator,
      trustedAdministratorUserIds: [operator],
    })
    const signup = redeemIndependentHouseholdInvitation(identity, {
      token: issued.token, username: 'thirdowner',
      displayName: 'Invited Owner', password: pwd,
      householdName: 'Third private household',
      serverDirectory, storageRoot: sourceRoot,
      trustedAdministratorUserIds: [operator],
    })
    assert.equal(signup.activation, 'pending')
    newId = signup.householdId
    assert.match(newId, /^family-[a-f0-9]{24}$/)
    assert.equal(identity.prepare(
      'SELECT COUNT(*) AS n FROM private_activated_households'
    ).get().n, 0, 'offline rehearsal cannot approve an account')
  } finally { identity.close() }
  bootstrap(resolveHouseholdStorage({
    serverDirectory, storageRoot: sourceRoot, householdId: newId,
  }), 'Third private event', 'Third list', 3)
  const after = capture(expandedSnapshotRoot)
  return {
    work, serverDirectory, sourceRoot,
    baselineSnapshotRoot, baselineAttestation: before.attestation,
    expandedSnapshotRoot, expandedAttestation: after.attestation,
    newlyInvitedHouseholdId: newId,
  }
}

function tenantData(f, root, id) {
  const storage = resolveHouseholdStorage({
    serverDirectory: f.serverDirectory, storageRoot: root, householdId: id,
  })
  const db = new DatabaseSync(storage.databasePath, { readOnly: true })
  try {
    return {
      events: db.prepare('SELECT title FROM events ORDER BY id').all()
        .map(row => ({ title: row.title })),
      lists: db.prepare('SELECT name FROM lists ORDER BY id').all()
        .map(row => ({ name: row.name })),
      picture: fs.readFileSync(path.join(storage.uploadFolder, 'private.bin')).toString('hex'),
    }
  } finally { db.close() }
}

test('two-household baseline and new invited Owner snapshot independently restore without original data changes', t => {
  const f = fixture(t)
  assert.deepEqual(reviewDisposableInvitedHouseholdRollback(f), {
    kind: 'disposable-private-invited-household-rollback-review-v1',
    baselineHouseholdCount: 2, expandedHouseholdCount: 3,
    priorHouseholdAssetsPreserved: true,
    baselineSnapshotVerified: true, expandedSnapshotVerified: true,
    independentlyRestoredInProduction: false, allProductionWritersFenced: false,
    liveOrTestDeploymentAuthorized: false, activationFromBrowserAllowed: false,
  })
  const restoredBefore = path.join(f.work, 'restored-before')
  const restoredAfter = path.join(f.work, 'restored-after')
  for (const [sourceRoot, destinationRoot, approvedAttestation, count] of [
    [f.baselineSnapshotRoot, restoredBefore, f.baselineAttestation, 2],
    [f.expandedSnapshotRoot, restoredAfter, f.expandedAttestation, 3],
  ]) {
    const copied = copyVerifiedPrivateRestoreSet({
      serverDirectory: f.serverDirectory, sourceRoot, destinationRoot,
      approvedAttestation,
    })
    assert.equal(copied.verified, true)
    assert.equal(copied.householdCount, count)
    assert.equal(verifyOfflinePrivateRestoreSet({
      serverDirectory: f.serverDirectory, restoreRoot: destinationRoot,
    }, approvedAttestation).ok, true)
  }
  for (const [i, id] of initial.entries()) {
    assert.deepEqual(tenantData(f, restoredBefore, id), tenantData(f, restoredAfter, id))
    assert.deepEqual(tenantData(f, restoredBefore, id).events,
      [{ title: 'Old private event ' + i }])
    assert.deepEqual(tenantData(f, restoredBefore, id).lists,
      [{ name: 'Old list ' + i }])
  }
  assert.deepEqual(tenantData(f, restoredAfter, f.newlyInvitedHouseholdId).events,
    [{ title: 'Third private event' }])
  assert.deepEqual(tenantData(f, restoredAfter, f.newlyInvitedHouseholdId).lists,
    [{ name: 'Third list' }])
  assert.equal(fs.existsSync(path.join(restoredBefore, 'households',
    f.newlyInvitedHouseholdId)), false, 'original backup excludes added tenant')
  for (const [root, count] of [[restoredBefore, 2], [restoredAfter, 3]]) {
    const db = new DatabaseSync(path.join(root, 'central', 'identity.db'), { readOnly: true })
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM household_registry').get().n, count)
      assert.equal(db.prepare(
        'SELECT COUNT(*) AS n FROM private_activated_households'
      ).get().n, 0, 'no activation authorization was created')
    } finally { db.close() }
  }
})

test('tampered backup data or untrusted edited attestation is rejected without modifying source', t => {
  const f = fixture(t)
  assert.throws(() => reviewDisposableInvitedHouseholdRollback({
    ...f, expandedAttestation: { ...f.expandedAttestation, sha256: '0'.repeat(64) },
  }), /attestation|modified|match/i)
  const photo = path.join(f.expandedSnapshotRoot, 'households',
    f.newlyInvitedHouseholdId, 'uploads', 'private.bin')
  fs.writeFileSync(photo, Buffer.from([0, 7, 8]))
  assert.throws(() => reviewDisposableInvitedHouseholdRollback(f),
    /attestation|restore|match|backup/i)
  assert.equal(fs.readFileSync(photo).toString('hex'), '000708',
    'failed review must not alter or delete the corrupted file')
})

test('a fully re-attested candidate still cannot modify older families or their uploaded media', t => {
  const f = fixture(t)
  const photo = path.join(f.expandedSnapshotRoot, 'households',
    initial[0], 'uploads', 'private.bin')
  fs.writeFileSync(photo, Buffer.from([67, 3, 255]))
  const alteredAttestation = attestOfflinePrivateRestoreSet({
    serverDirectory: f.serverDirectory, restoreRoot: f.expandedSnapshotRoot,
  })
  assert.throws(() => reviewDisposableInvitedHouseholdRollback({
    ...f, expandedAttestation: alteredAttestation,
  }), /existing family SQLite, metadata or uploads changed/)
})

test('wrong family, missing expansion and non-disposable or overlapping snapshots fail closed', t => {
  const f = fixture(t)
  assert.throws(() => reviewDisposableInvitedHouseholdRollback({
    ...f, newlyInvitedHouseholdId: initial[0],
  }), /one generated newly invited household/)
  assert.throws(() => reviewDisposableInvitedHouseholdRollback({
    ...f, newlyInvitedHouseholdId: 'family-' + 'e'.repeat(24),
  }), /exactly the invited family/)
  assert.throws(() => reviewDisposableInvitedHouseholdRollback({
    ...f, baselineSnapshotRoot: f.expandedSnapshotRoot,
  }), /may not overlap/)
  assert.throws(() => reviewDisposableInvitedHouseholdRollback({
    ...f, expandedSnapshotRoot: os.tmpdir(),
  }), /disposable|snapshot/i)
  assert.throws(() => reviewDisposableInvitedHouseholdRollback({
    ...f, expandedSnapshotRoot: path.join(f.work, 'missing'),
  }), /ENOENT/)
})
