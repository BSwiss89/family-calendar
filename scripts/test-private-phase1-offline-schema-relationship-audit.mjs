// Strictly synthetic, disposable test of schema-only audit. Never accesses
// installed LIVE/TEST or the owner's historical backup. Secret fixtures
// prove SQL defaults, row values and trigger bodies never leave the report.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes,createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { listPrivatePhase1LegacyDispositionRules }
  from '../Server/private-phase1-legacy-table-disposition-review.mjs'
import { auditPrivatePhase1OfflineLegacySchema as audit }
  from '../Server/private-phase1-offline-schema-relationship-audit.mjs'

const sha='76caa3e46186c3c5c6408f11b55800eb06779776'
const SECRET='SYNTHETIC_PRIVATE_UPLOAD_USER_TOKEN_EVENT_DO_NOT_ECHO'
const fileHash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const cli=fileURLToPath(new URL('./inspect-private-phase1-offline-schema-relationships.mjs',import.meta.url))
function fixture(t) {
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'fc-phase1-archive-schema-'))
  t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}))
  const parent=path.join(workspace,'family-calendar-phase1-recovery')
  fs.mkdirSync(parent)
  const snap=path.join(parent,'OFFLINE-LEGACY-TEST-20261122-203000-'+
    randomBytes(16).toString('hex'))
  fs.mkdirSync(path.join(snap,'uploads','pictures'),{recursive:true})
  fs.mkdirSync(path.join(snap,'dist'))
  const dbFile=path.join(snap,'calendar.db')
  const db=new DatabaseSync(dbFile)
  try {
    db.exec('PRAGMA foreign_keys=ON')
    for(const {table} of listPrivatePhase1LegacyDispositionRules()) {
      let ddl
      switch(table) {
        case 'family_users':
          ddl='CREATE TABLE family_users(id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT)'
          break
        case 'family_sessions':
          ddl='CREATE TABLE family_sessions(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES family_users(id), revoked_at INTEGER, expires_at INTEGER)'
          break
        case 'events':
          ddl="CREATE TABLE events(id INTEGER PRIMARY KEY, title TEXT DEFAULT '"+SECRET+"', creator_id INTEGER, person_ref INTEGER)"
          break
        case 'people':
          ddl='CREATE TABLE people(id INTEGER PRIMARY KEY, display_name TEXT)'
          break
        case 'emoji_markers':
          ddl='CREATE TABLE emoji_markers(id INTEGER PRIMARY KEY, marker TEXT)'
          break
        case 'emoji_marker_exceptions':
          ddl='CREATE TABLE emoji_marker_exceptions(id INTEGER PRIMARY KEY, marker_id INTEGER REFERENCES emoji_markers(id))'
          break
        case 'shopping_stores':
          ddl='CREATE TABLE shopping_stores(id INTEGER PRIMARY KEY, title TEXT)'
          break
        case 'shopping_store_preferences':
          ddl='CREATE TABLE shopping_store_preferences(id INTEGER PRIMARY KEY, store_id INTEGER REFERENCES shopping_stores(id))'
          break
        case 'test_assignment_acknowledgements':
          ddl='CREATE TABLE test_assignment_acknowledgements(id INTEGER PRIMARY KEY, outbox_id INTEGER REFERENCES assignment_notification_outbox(id))'
          break
        case 'event_people':
          ddl='CREATE TABLE event_people(id INTEGER PRIMARY KEY, event_id INTEGER REFERENCES events(id), person_id INTEGER REFERENCES people(id))'
          break
        case 'event_exceptions':
          ddl='CREATE TABLE event_exceptions(id INTEGER PRIMARY KEY,event_id INTEGER REFERENCES events(id))'
          break
        case 'list_items':
          ddl='CREATE TABLE list_items(id INTEGER PRIMARY KEY,list_id INTEGER REFERENCES lists(id))'
          break
        case 'notification_event_baselines':
          ddl='CREATE TABLE notification_event_baselines(id INTEGER PRIMARY KEY, event_id INTEGER, actor_id INTEGER, secret_data TEXT)'
          break
        default:
          ddl='CREATE TABLE "'+table+'"(id INTEGER PRIMARY KEY, content TEXT)'
      }
      db.exec(ddl)
    }
    db.exec("CREATE UNIQUE INDEX events_title_idx ON events(title)")
    db.exec("CREATE INDEX events_partial_idx ON events(person_ref) WHERE person_ref IS NOT NULL")
    db.exec("CREATE INDEX events_expression_idx ON events(lower(title))")
    db.exec("CREATE TRIGGER secret_event_trigger AFTER INSERT ON events BEGIN SELECT '"+SECRET+"'; END")
    db.exec('CREATE VIEW test_schema_view AS SELECT id FROM events')
    db.prepare('INSERT INTO family_users VALUES(?,?,?)').run(1,SECRET,SECRET)
    db.prepare('INSERT INTO family_sessions VALUES(?,?,?,?)')
      .run(1,1,null,Date.now()+24*60*60*1000)
    db.prepare('INSERT INTO events(id,title,creator_id) VALUES(?,?,?)')
      .run(46,SECRET,1)
    db.prepare('INSERT INTO people VALUES(?,?)').run(7,SECRET)
    db.prepare('INSERT INTO notification_event_baselines VALUES(?,?,?,?)')
      .run(4,46,1,SECRET)
    db.prepare('INSERT INTO assignment_notification_outbox VALUES(?,?)')
      .run(2,SECRET)
    db.prepare('INSERT INTO test_assignment_acknowledgements VALUES(?,?)')
      .run(1,2)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[])
  } finally {db.close()}
  const rel=['calendar.db','uploads/pictures/photo.bin',
    'dist/index.html','start-secure-test-patched.ps1']
  fs.writeFileSync(path.join(snap,'uploads','pictures','photo.bin'),SECRET)
  fs.writeFileSync(path.join(snap,'dist','index.html'),'<html>disposable</html>')
  fs.writeFileSync(path.join(snap,'start-secure-test-patched.ps1'),'# never executed\n')
  const files=rel.map(p=>({path:p,sha256:fileHash(path.join(snap,...p.split('/')))}))
  const m={
    kind:'phase1-offline-legacy-test-snapshot-v1',sourceSha:sha,
    capturedAt:'2026-11-22T20:30:00-06:00',
    databaseSha256:files[0].sha256,supervisorSha256:files[3].sha256,
    uploads:1,dist:1,sqliteIntegrity:'ok',fileCount:files.length,files,
    restoreBootVerified:false,coordinatedCentralAndFamilySnapshot:false,
    safeToCutover:false,testDeploymentAuthorized:false,liveDeploymentAuthorized:false,
  }
  const manifest=path.join(snap,'OFFLINE-LEGACY-REVIEW.json')
  fs.writeFileSync(manifest,JSON.stringify(m))
  return {
    snap,dbFile,manifest,parent,
    args:{recoveryParent:parent,snapshotRoot:snap,expectedInstalledTestSha:sha},
  }
}
test('27-table source schema reports safe columns, FKs, indexes, triggers and implicit identity hints without values',t=>{
  const f=fixture(t)
  const before=fileHash(f.dbFile),manifestBefore=fileHash(f.manifest)
  const result=audit(f.args)
  assert.equal(result.kind,'phase1-archive-schema-relationship-audit-v1')
  assert.equal(result.tables,27)
  assert(result.totalColumns>=54)
  assert(result.totalExplicitForeignKeys>=6)
  assert(result.totalIndexes>=3)
  assert.equal(result.totalViews,1)
  assert.equal(result.totalTriggers,1)
  assert(result.undeclaredIdColumnHints>=2)
  const events=result.historicalTables.find(x=>x.table==='events')
  assert(events.columns.some(x=>x.column==='creator_id'))
  assert(events.indexes.some(x=>x.partial))
  assert(events.indexes.some(x=>x.keyParts.some(p=>p.expression===true)))
  assert(events.unlinkedIdColumnHints.includes('creator_id'))
  assert.equal(events.triggerCount,1)
  const marker=result.historicalTables.find(x=>x.table==='emoji_marker_exceptions')
  assert(marker.foreignKeys.some(x=>x.referencedTable==='emoji_markers'))
  const ack=result.historicalTables.find(x=>x.table==='test_assignment_acknowledgements')
  assert(ack.foreignKeys.some(x=>x.referencedTable==='assignment_notification_outbox'))
  for(const key of ['fullSchemaCompatibilityEstablished','dataCopyAuthorized',
    'sessionMigrationAuthorized','realMigrationExecuted',
    'testDeploymentAuthorized','liveDeploymentAuthorized',
    'installedTestOrLiveAccessed','userValuesExposed','sourceArchiveModified']) {
    assert.equal(result[key],false,key)
  }
  assert.equal(result.requiresFreshWriterFencedCurrentTestBackup,true)
  assert.equal(fileHash(f.dbFile),before)
  assert.equal(fileHash(f.manifest),manifestBefore)
  assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PRIVATE|password_hash.*SYNTHETIC|test_schema_view|secret_event_trigger|events_title_idx/)
  const cmd=spawnSync(process.execPath,[cli,f.snap,sha],{
    encoding:'utf8',timeout:30000,windowsHide:true,
  })
  assert.equal(cmd.status,0,cmd.stderr)
  assert.equal(JSON.parse(cmd.stdout).totalViews,1)
  assert.doesNotMatch(cmd.stdout,/SYNTHETIC_PRIVATE|test_schema_view|secret_event_trigger|events_title_idx/)
})
test('bad SHA or corrupted archive refuses with sanitized CLI failure',t=>{
  const f=fixture(t)
  const cmd=spawnSync(process.execPath,[cli,f.snap,'0'.repeat(40)],{
    encoding:'utf8',windowsHide:true,timeout:30000,
  })
  assert.equal(cmd.status,2)
  assert.equal(cmd.stdout,'')
  assert.match(cmd.stderr,/REFUSED/)
  assert.doesNotMatch(cmd.stderr,/SYNTHETIC_PRIVATE/)
  fs.writeFileSync(path.join(f.snap,'uploads','new-unknown.txt'),SECRET)
  assert.throws(()=>audit(f.args),/inventory|unlisted|unexpected/)
})
test('a changed table or index cannot be laundered through the archived manifest',t=>{
  const f=fixture(t)
  const db=new DatabaseSync(f.dbFile)
  try {db.exec('ALTER TABLE events ADD COLUMN extra_session_id INTEGER')}
  finally {db.close()}
  assert.throws(()=>audit(f.args),/bytes differ/)
})
test('archive path cannot target installed site even with a plausible marker',t=>{
  const f=fixture(t)
  assert.throws(()=>audit({...f.args,recoveryParent:path.dirname(f.parent)}),/refused|recovery/)
  const bad=spawnSync(process.execPath,[cli,'relative-path',sha],{
    encoding:'utf8',windowsHide:true,timeout:30000,
  })
  assert.equal(bad.status,2)
  assert.equal(bad.stdout,'')
})
