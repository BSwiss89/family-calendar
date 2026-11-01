import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'
import { createHouseholdMembershipTables, registerHousehold, grantHouseholdMembership } from '../Server/household-memberships.mjs'
import { setFamilyAccount } from '../Server/family-auth.mjs'
import {
  createEventShareTables, inviteSelectedEvents,
  registerTrustedShareConnection, respondToEventInvitation,
  listAcceptedSharedEvents,
} from '../Server/event-only-shares.mjs'
import { createEventShareSyncJournal } from '../Server/event-share-sync-journal.mjs'
import { installPrivateEventIdentity } from '../Server/private-event-identity.mjs'
import {
  attestOfflinePrivateRestoreSet, verifyOfflinePrivateRestoreSet,
} from '../Server/private-restore-preflight.mjs'
import { copyVerifiedPrivateRestoreSet } from '../Server/private-offline-restore-rehearsal.mjs'

const testPassword = 'NonProduction-Restore-Tester-123!'
function fixture(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-offline-rehearsal-'))
  t.after(() => fs.rmSync(work, { recursive: true, force: true }))
  const serverDirectory = path.join(work, 'checkout', 'Server')
  const sourceRoot = path.join(work, 'source-offline')
  fs.mkdirSync(serverDirectory, { recursive: true })
  fs.mkdirSync(sourceRoot)
  fs.writeFileSync(path.join(sourceRoot, '.family-calendar-restore-review.json'),
    JSON.stringify({ kind: 'private-household-offline-restore-review', version: 1 }))
  fs.mkdirSync(path.join(sourceRoot, 'central'))
  const centralPath = path.join(sourceRoot, 'central', 'identity.db')
  const homes = ['family-a','family-b'].map(householdId => provisionEmptyHousehold({
    serverDirectory, storageRoot: sourceRoot, householdId,
  }))
  for (const [i, home] of homes.entries()) {
    const db = new DatabaseSync(home.databasePath)
    try {
      db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY, title TEXT, date TEXT, end_date TEXT, time TEXT, end_time TEXT, repeat_unit TEXT) STRICT')
      db.exec('CREATE TABLE lists(id INTEGER PRIMARY KEY, name TEXT) STRICT')
      installPrivateEventIdentity(db)
      db.prepare('INSERT INTO events(title,date,time) VALUES(?,?,?)')
        .run(i === 0 ? 'Family A secret event' : 'Family B private event',
          '2027-02-02', '18:00')
      db.prepare('INSERT INTO lists(name) VALUES(?)')
        .run(i === 0 ? 'Family A groceries' : 'Family B groceries')
    } finally { db.close() }
    fs.writeFileSync(path.join(home.uploadFolder, 'photo.png'),
      i === 0 ? 'PRIVATE PHOTO A' : 'PRIVATE PHOTO B')
  }
  const central = new DatabaseSync(centralPath)
  let invitationId
  try {
    createHouseholdMembershipTables(central)
    setFamilyAccount(central, 'restorer-a', 'Family A', testPassword)
    setFamilyAccount(central, 'restorer-b', 'Family B', testPassword)
    registerHousehold(central, { householdId: 'family-a', displayName: 'Family A' })
    registerHousehold(central, { householdId: 'family-b', displayName: 'Family B' })
    const a = central.prepare("SELECT id FROM family_users WHERE username='restorer-a'").get().id
    const b = central.prepare("SELECT id FROM family_users WHERE username='restorer-b'").get().id
    grantHouseholdMembership(central, { serverVerifiedUserId:a, householdId:'family-a', role:'owner' })
    grantHouseholdMembership(central, { serverVerifiedUserId:b, householdId:'family-b', role:'owner' })
    createEventShareTables(central)
    createEventShareSyncJournal(central)
    registerTrustedShareConnection(central, {
      sourceHouseholdId:'family-a',recipientHouseholdId:'family-b',
    })
    const source = new DatabaseSync(homes[0].databasePath, { readOnly:true })
    try {
      const [invite] = inviteSelectedEvents(central, {
        serverVerifiedUserId:a, sourceHouseholdId:'family-a',
        eventIds:[1], recipientHouseholdIds:['family-b'],
        sourceDatabase:source,
      })
      invitationId=invite.shareId
    } finally {source.close()}
    respondToEventInvitation(central, {
      serverVerifiedUserId:b, recipientHouseholdId:'family-b',
      shareId:invitationId, decision:'accepted',
    })
  } finally {central.close()}
  return {
    sourceRoot, centralPath, serverDirectory, homes, invitationId,
    options:{serverDirectory,restoreRoot:sourceRoot},
    work,
  }
}

test('batch rehearsal clones and verifies both household SQLite databases, images, accounts and invitation', t => {
  const f=fixture(t)
  const approved=attestOfflinePrivateRestoreSet(f.options)
  const destinationRoot=path.join(f.work,'restored-test-copy')
  const result=copyVerifiedPrivateRestoreSet({
    serverDirectory:f.serverDirectory, sourceRoot:f.sourceRoot,
    destinationRoot,approvedAttestation:approved,
  })
  assert.equal(result.verified,true)
  assert.equal(result.householdCount,2)
  assert.ok(result.fileCount>=6)
  assert.deepEqual(verifyOfflinePrivateRestoreSet({
    serverDirectory:f.serverDirectory,restoreRoot:destinationRoot,
  },approved),{ok:true,households:2,files:approved.files.length})
  const central=new DatabaseSync(path.join(destinationRoot,'central','identity.db'),{readOnly:true})
  try {
    const b=central.prepare("SELECT id FROM family_users WHERE username='restorer-b'").get().id
    const other=central.prepare("SELECT id FROM family_users WHERE username='restorer-a'").get().id
    assert.deepEqual(listAcceptedSharedEvents(central,{
      serverVerifiedUserId:b,recipientHouseholdId:'family-b',
    }).map(x=>x.title),['Family A secret event'])
    assert.throws(()=>listAcceptedSharedEvents(central,{
      serverVerifiedUserId:other,recipientHouseholdId:'family-b',
    }),/authorized/)
    assert.equal(central.prepare('SELECT role FROM household_memberships WHERE user_id=?')
      .get(b).role,'owner')
  }finally{central.close()}
  for (const [i,home] of f.homes.entries()){
    const slug=i===0?'family-a':'family-b'
    const dest=path.join(destinationRoot,'households',slug)
    const db=new DatabaseSync(path.join(dest,'data','calendar.db'),{readOnly:true})
    try{
      assert.equal(db.prepare('SELECT name FROM lists').get().name,
        i===0?'Family A groceries':'Family B groceries')
      assert.match(db.prepare('SELECT event_uid FROM events').get().event_uid,/^[0-9a-f]{32}$/)
    }finally{db.close()}
    assert.equal(fs.readFileSync(path.join(dest,'uploads','photo.png'),'utf8'),
      i===0?'PRIVATE PHOTO A':'PRIVATE PHOTO B')
  }
  assert.equal(fs.existsSync(path.join(f.work,'backup-operator-restore')),false)
})

test('a corrupt backup cannot replace a previous verified rehearsal',t=>{
  const f=fixture(t)
  const approved=attestOfflinePrivateRestoreSet(f.options)
  const safe=path.join(f.work,'already-verified')
  copyVerifiedPrivateRestoreSet({
    serverDirectory:f.serverDirectory,sourceRoot:f.sourceRoot,
    destinationRoot:safe,approvedAttestation:approved,
  })
  fs.writeFileSync(path.join(f.homes[0].uploadFolder,'photo.png'),'CORRUPTED FAMILY A')
  assert.throws(()=>copyVerifiedPrivateRestoreSet({
    serverDirectory:f.serverDirectory,sourceRoot:f.sourceRoot,
    destinationRoot:path.join(f.work,'should-not-exist'),
    approvedAttestation:approved,
  }),/attestation|match/)
  assert.equal(fs.existsSync(path.join(f.work,'should-not-exist')),false)
  assert.equal(fs.readFileSync(path.join(safe,'households','family-a','uploads','photo.png'),'utf8'),
    'PRIVATE PHOTO A')
})

test('existing targets, nested targets and missing independent approval refuse without writes',t=>{
  const f=fixture(t)
  const approved=attestOfflinePrivateRestoreSet(f.options)
  const target=path.join(f.work,'existing-folder')
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target,'sentinel.txt'),'NEVER OVERWRITE')
  const attempt=(destinationRoot,attestation=approved)=>copyVerifiedPrivateRestoreSet({
    serverDirectory:f.serverDirectory,sourceRoot:f.sourceRoot,
    destinationRoot,approvedAttestation:attestation,
  })
  assert.throws(()=>attempt(target),/already exists/)
  assert.equal(fs.readFileSync(path.join(target,'sentinel.txt'),'utf8'),'NEVER OVERWRITE')
  assert.throws(()=>attempt(path.join(f.sourceRoot,'nested')),/overlap/)
  assert.throws(()=>attempt(path.join(f.work,'checkout','forbidden')),/outside application checkout/)
  assert.throws(()=>attempt(path.join(f.work,'unapproved'),null),/independent, trusted/)
  assert.equal(fs.existsSync(path.join(f.work,'unapproved')),false)
})

test('copying a backup after source event reuse is rejected and leaves prior copy untouched',t=>{
  const f=fixture(t)
  const approved=attestOfflinePrivateRestoreSet(f.options)
  const target=path.join(f.work,'verified-prior')
  copyVerifiedPrivateRestoreSet({
    serverDirectory:f.serverDirectory,sourceRoot:f.sourceRoot,
    destinationRoot:target,approvedAttestation:approved,
  })
  const db=new DatabaseSync(f.homes[0].databasePath)
  try{
    db.prepare('DELETE FROM events WHERE id=1').run()
    db.prepare('INSERT INTO events(id,title,date) VALUES(1,?,?)')
      .run('Reused ID secret','2027-02-02')
  }finally{db.close()}
  assert.throws(()=>copyVerifiedPrivateRestoreSet({
    serverDirectory:f.serverDirectory,sourceRoot:f.sourceRoot,
    destinationRoot:path.join(f.work,'unsafe-replacement'),
    approvedAttestation:approved,
  }),/active shared invitation does not match/)
  assert.equal(fs.existsSync(path.join(f.work,'unsafe-replacement')),false)
  assert.equal(fs.readFileSync(path.join(target,'households','family-b','uploads','photo.png'),'utf8'),
    'PRIVATE PHOTO B')
})
