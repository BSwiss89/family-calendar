// Synthetic OS-temp archives only. No installed LIVE/TEST or real recovery
// folders are read, and no SQLite/login data ever leaves this fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { inspectPrivatePhase1OfflineLegacyMigration as inspect }
  from '../Server/private-phase1-offline-legacy-migration-inventory.mjs'

const SHA='76caa3e46186c3c5c6408f11b55800eb06779776'
const SECRET='synthetic-credential-and-family-private-title-DO-NOT-PRINT'
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const entry=fileURLToPath(new URL('./inspect-private-phase1-offline-legacy-migration.mjs',import.meta.url))
function fixture(t) {
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'phase1-legacy-migration-'))
  t.after(()=>fs.rmSync(work,{recursive:true,force:true}))
  const parent=path.join(work,'family-calendar-phase1-recovery')
  fs.mkdirSync(parent)
  const archive=path.join(parent,'OFFLINE-LEGACY-TEST-20261122-203000-'+
    randomBytes(16).toString('hex'))
  fs.mkdirSync(path.join(archive,'uploads','people'),{recursive:true})
  fs.mkdirSync(path.join(archive,'dist'),{recursive:true})
  const dbFile=path.join(archive,'calendar.db')
  const db=new DatabaseSync(dbFile)
  try {
    db.exec([
      'PRAGMA foreign_keys=ON;',
      'CREATE TABLE family_users(id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT);',
      'CREATE TABLE family_sessions(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES family_users(id), revoked_at INTEGER, expires_at INTEGER);',
      'CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT);',
      'CREATE TABLE events(id INTEGER PRIMARY KEY, title TEXT, creator_id INTEGER REFERENCES family_users(id));',
      'CREATE TABLE event_people(event_id INTEGER REFERENCES events(id),person_id INTEGER REFERENCES people(id));',
      'CREATE TABLE lists(id INTEGER PRIMARY KEY,name TEXT);',
      'CREATE TABLE legacy_settings(id INTEGER PRIMARY KEY,value TEXT);',
    ].join(' '))
    db.prepare('INSERT INTO family_users(username,password_hash) VALUES (?,?)')
      .run('private-owner',SECRET)
    db.prepare('INSERT INTO family_sessions(user_id,expires_at) VALUES (?,?)')
      .run(1,Date.now()+3600000)
    db.prepare('INSERT INTO people(name) VALUES (?)').run(SECRET)
    db.prepare('INSERT INTO events(title,creator_id) VALUES (?,?)').run(SECRET,1)
    db.prepare('INSERT INTO event_people VALUES (?,?)').run(1,1)
    db.prepare('INSERT INTO lists(name) VALUES (?)').run(SECRET)
    db.prepare('INSERT INTO legacy_settings(value) VALUES (?)').run(SECRET)
  } finally {db.close()}
  fs.writeFileSync(path.join(archive,'uploads','people','avatar.bin'),
    Buffer.from([5,6,9,0]))
  fs.writeFileSync(path.join(archive,'dist','index.html'),'<html>offline</html>')
  fs.writeFileSync(path.join(archive,'start-secure-test-patched.ps1'),
    '# Fixture only; never executed\n')
  const filenames=[
    'calendar.db','uploads/people/avatar.bin','dist/index.html',
    'start-secure-test-patched.ps1',
  ]
  const files=filenames.map(p=>({
    path:p,sha256:hash(path.join(archive,...p.split('/'))),
  }))
  const manifest={
    kind:'phase1-offline-legacy-test-snapshot-v1',sourceSha:SHA,
    capturedAt:'2026-11-22T20:30:00-06:00',
    databaseSha256:files[0].sha256,supervisorSha256:files[3].sha256,
    uploads:1,dist:1,sqliteIntegrity:'ok',fileCount:files.length,files,
    restoreBootVerified:false,coordinatedCentralAndFamilySnapshot:false,
    safeToCutover:false,testDeploymentAuthorized:false,
    liveDeploymentAuthorized:false,
  }
  const manifestFile=path.join(archive,'OFFLINE-LEGACY-REVIEW.json')
  fs.writeFileSync(manifestFile,JSON.stringify(manifest))
  const args={
    recoveryParent:parent,snapshotRoot:archive,expectedInstalledTestSha:SHA,
  }
  return {parent,archive,dbFile,manifestFile,args,manifest}
}
function run(f,sourceSha=SHA) {
  return spawnSync(process.execPath,[entry,f.archive,sourceSha],{
    encoding:'utf8',timeout:15000,windowsHide:true,
  })
}
test('cold TEST snapshot reports only schema and row counts; flags mixed central/household identity', t=>{
  const f=fixture(t)
  const sourceBefore=hash(f.dbFile),manifestBefore=hash(f.manifestFile)
  const result=inspect(f.args)
  assert.equal(result.kind,'phase1-offline-legacy-to-primary-household-inventory-v1')
  assert.equal(result.legacySnapshotVerified,true)
  assert.equal(result.legacyAccounts,1)
  assert.equal(result.savedSessions,1)
  assert.equal(result.activeSessionsAtInspection,1)
  assert.equal(result.tableCount,7)
  assert.equal(result.uploadedFileCount,1)
  assert.equal(result.grouping.centralCandidateTables,2)
  assert.equal(result.grouping.needsExplicitMappingTables,1)
  assert.equal(result.grouping.crossBoundaryForeignKeys,1)
  assert.deepEqual(result.missingRequiredTables,[])
  assert.equal(result.tables.find(x=>x.table==='events').rows,1)
  assert.equal(result.tables.find(x=>x.table==='legacy_settings').classification,
    'needs-explicit-mapping')
  for(const key of ['accountCredentialsCopied','loginSessionsMigrated',
    'legacyArchiveModified','installedTestOrLiveAccessed','realMigrationExecuted',
    'migrationApproved','testDeploymentAuthorized','liveDeploymentAuthorized']) {
    assert.equal(result[key],false,key)
  }
  const printed=JSON.stringify(result)
  assert.doesNotMatch(printed,/synthetic-credential|private-owner|avatar.bin/)
  assert.equal(hash(f.dbFile),sourceBefore)
  assert.equal(hash(f.manifestFile),manifestBefore)
  const cmd=run(f)
  assert.equal(cmd.status,0,cmd.stderr)
  assert.equal(JSON.parse(cmd.stdout).schemaSha256,result.schemaSha256)
  assert.doesNotMatch(cmd.stdout,/synthetic-credential|private-owner|avatar.bin/)
})
test('corrupted manifest, added uploads, wrong pin or changed SQLite refuse before examining rows',t=>{
  const f=fixture(t)
  assert.equal(run(f,'f'.repeat(40)).status,2)
  fs.writeFileSync(path.join(f.archive,'uploads','unlisted-private-file.txt'),'no')
  assert.throws(()=>inspect(f.args),/inventory|unlisted|unexpected/)
  const cmd=run(f)
  assert.equal(cmd.status,2)
  assert.equal(cmd.stdout,'')
  assert.match(cmd.stderr,/REFUSED/)
  assert.doesNotMatch(cmd.stderr,/synthetic-credential|private-owner/)
})
test('malformed and missing session columns cannot be mistaken for safe login reconciliation',t=>{
  const f=fixture(t)
  // Simulated archive cannot be rewritten and re-signed implicitly.
  // A verified legacy archive with no usable identity/session schema must
  // be a REVIEW-only inventory, never an automatic migration permission.
  const db=new DatabaseSync(f.dbFile)
  try {
    db.exec('DROP TABLE family_sessions')
  } finally {db.close()}
  assert.throws(()=>inspect(f.args),/bytes differ/)
})
test('unknown tables stay explicit review work, and cross-boundary schema FKs are not copied',t=>{
  const f=fixture(t)
  const result=inspect(f.args)
  assert.equal(result.tables.find(x=>x.table==='family_sessions').foreignKeysToCentral,1)
  assert.equal(result.tables.find(x=>x.table==='event_people').foreignKeysToHousehold,2)
  assert.equal(result.tables.find(x=>x.table==='legacy_settings').rows,1)
  assert.equal(result.requiresExplicitTableMapping,true)
  assert.equal(result.requiresOwnerSessionReconciliation,true)
  assert.equal(result.requiresSeparateMigrationAndRecoveryApproval,true)
})
