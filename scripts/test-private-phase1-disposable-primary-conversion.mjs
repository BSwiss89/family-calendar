// Only synthetic OS-temp fixture data. No installed LIVE or TEST paths,
// Windows services/tasks, actual backup archive or real credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { installAssignmentNotificationOutbox } from '../Server/event-assignment-notifications.mjs'
import { installNotificationMutationCapture, reconcileNotificationMutations } from '../Server/notification-event-mutation-capture.mjs'
import { hashFamilyPassword } from '../Server/family-auth.mjs'
import { listPrivatePhase1LegacyDispositionRules } from '../Server/private-phase1-legacy-table-disposition-review.mjs'
import {
  stageDisposablePhase1PrimaryFamily as convert,
  listPhase1ApprovedSyntheticFixtureTriggerSql,
} from '../Server/private-phase1-disposable-primary-conversion.mjs'

const secret='THIS_IS_A_SYNTHETIC_PRIVATE_EVENT_AND_USERNAME_DO_NOT_PRINT'
const suffix=()=>randomBytes(8).toString('hex')
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function fixture(t) {
  const codeRoot=fs.mkdtempSync(path.join(os.tmpdir(),'fc-phase1-synthetic-code-'))
  const src=path.join(os.tmpdir(),'fc-phase1-disposable-legacy-'+suffix())
  const dest=path.join(os.tmpdir(),'fc-phase1-disposable-converted-'+suffix())
  t.after(()=>{
    for(const dir of [codeRoot,src,dest]) fs.rmSync(dir,{recursive:true,force:true})
  })
  const serverDirectory=path.join(codeRoot,'Server')
  fs.mkdirSync(serverDirectory)
  fs.mkdirSync(src)
  fs.mkdirSync(path.join(src,'data'))
  fs.mkdirSync(path.join(src,'uploads'))
  fs.mkdirSync(path.join(src,'uploads','people'))
  fs.mkdirSync(path.join(src,'uploads','empty-folder'))
  fs.writeFileSync(path.join(src,'.phase1-disposable-legacy-fixture.json'),
    JSON.stringify({kind:'phase1-disposable-synthetic-legacy-only',
      version:1,realCalendarDataAllowed:false}))
  const avatar=path.join(src,'uploads','people','portrait.bin')
  fs.writeFileSync(avatar,Buffer.from([0,3,255,16]))
  const dbFile=path.join(src,'data','calendar.db')
  const db=new DatabaseSync(dbFile)
  try {
    db.exec('PRAGMA foreign_keys=ON')
    for(const rule of listPrivatePhase1LegacyDispositionRules()){
      let sql
      switch(rule.table) {
        case 'family_users':
          sql='CREATE TABLE family_users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,password_hash TEXT,account_kind TEXT,disabled INTEGER)'
          break
        case 'family_sessions':
          sql='CREATE TABLE family_sessions(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES family_users(id),token_hash TEXT,revoked_at INTEGER,expires_at INTEGER)'
          break
        case 'people':
          sql='CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT)'
          break
        case 'events':
          sql='CREATE TABLE events(id INTEGER PRIMARY KEY,title TEXT,payload BLOB)'
          break
        case 'event_people':
          sql='CREATE TABLE event_people(id INTEGER PRIMARY KEY,event_id INTEGER REFERENCES events(id),person_id INTEGER REFERENCES people(id))'
          break
        case 'lists':
          sql='CREATE TABLE lists(id INTEGER PRIMARY KEY,name TEXT)'
          break
        case 'list_items':
          sql='CREATE TABLE list_items(id INTEGER PRIMARY KEY,list_id INTEGER REFERENCES lists(id),title TEXT)'
          break
        case 'test_event_invitations':
          sql='CREATE TABLE test_event_invitations(id INTEGER PRIMARY KEY,event_id INTEGER REFERENCES events(id),status TEXT)'
          break
        case 'event_exceptions':
          sql='CREATE TABLE event_exceptions(id INTEGER PRIMARY KEY,event_id INTEGER REFERENCES events(id),value TEXT)'
          break
        case 'shopping_stores':
          sql='CREATE TABLE shopping_stores(id INTEGER PRIMARY KEY,title TEXT)'
          break
        case 'shopping_store_preferences':
          sql='CREATE TABLE shopping_store_preferences(id INTEGER PRIMARY KEY,store_id INTEGER REFERENCES shopping_stores(id),value TEXT)'
          break
        case 'assignment_notification_outbox':
          sql='CREATE TABLE assignment_notification_outbox(id INTEGER PRIMARY KEY,value TEXT,event_id INTEGER,person_id INTEGER,cancelled_details_json TEXT)'
          break
        case 'test_assignment_acknowledgements':
          sql='CREATE TABLE test_assignment_acknowledgements(id INTEGER PRIMARY KEY,notification_id INTEGER REFERENCES assignment_notification_outbox(id),value TEXT)'
          break
        default:
          sql='CREATE TABLE "'+rule.table+'"(id INTEGER PRIMARY KEY,value TEXT)'
      }
      db.exec(sql)
    }
    const password=hashFamilyPassword('Synthetic Only Long Example Password 12345!')
    db.prepare('INSERT INTO family_users VALUES(?,?,?,?,?,?)')
      .run(1,'syntheticowner','Synthetic Owner',password,'person',0)
    const now=Date.now()
    db.prepare('INSERT INTO family_sessions VALUES(?,?,?,?,?)')
      .run(1,1,'f'.repeat(64),null,now+3600000)
    db.prepare('INSERT INTO family_sessions VALUES(?,?,?,?,?)')
      .run(2,1,'e'.repeat(64),now-10,now-5)
    db.prepare('INSERT INTO people VALUES (?,?)').run(7,secret)
    db.prepare('INSERT INTO events VALUES (?,?,?)')
      .run(46,secret,new Uint8Array([0,4,255,200]))
    db.prepare('INSERT INTO event_people VALUES (?,?,?)').run(1,46,7)
    db.prepare('INSERT INTO lists VALUES (?,?)').run(2,'Private Groceries')
    db.prepare('INSERT INTO list_items VALUES (?,?,?)').run(23,2,'Milk')
    db.prepare('INSERT INTO shopping_stores VALUES (?,?)').run(3,'H-E-B')
    db.prepare('INSERT INTO shopping_store_preferences VALUES (?,?,?)')
      .run(1,3,'manual-lock')
    db.prepare('INSERT INTO test_event_invitations VALUES (?,?,?)')
      .run(11,46,'accepted')
    for(const table of ['daily_notes','emoji_markers','meal_plans',
      'meal_plan_items','notification_event_baselines',
      'assignment_notification_outbox','test_assignment_acknowledgements',
      'test_push_subscriptions','test_push_deliveries']) {
      db.prepare('INSERT INTO "'+table+'"(id,value) VALUES (?,?)').run(1,secret)
    }
    // Simulate historical TEST notification references: 31 sent notices,
    // 4 references to now-deleted events and 2 to absent People. The missing
    // targets are legitimate archival state, never silently cleaned up.
    db.prepare('UPDATE assignment_notification_outbox SET event_id=?,person_id=?,cancelled_details_json=? WHERE id=1')
      .run(46,7,JSON.stringify({cancelled:'synthetic historical details'}))
    const notice=db.prepare('INSERT INTO assignment_notification_outbox(id,value,event_id,person_id,cancelled_details_json) VALUES(?,?,?,?,?)')
    for(let id=2;id<=31;id++) {
      const eventId=id<=5?1000+id:46
      const personId=id>=6&&id<=7?2000+id:7
      notice.run(id,secret,eventId,personId,
        JSON.stringify({detail:'historical synthetic notification',id}))
    }
    const ack=db.prepare('INSERT INTO test_assignment_acknowledgements(id,notification_id,value) VALUES(?,?,?)')
    for(let id=2;id<=14;id++)ack.run(id,id,secret)
    db.exec('CREATE INDEX phase1_fixture_list_item_store_idx ON list_items(list_id)')
    for(const sql of listPhase1ApprovedSyntheticFixtureTriggerSql())db.exec(sql)
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
  } finally {db.close()}
  return {serverDirectory,sourceRoot:src,destinationRoot:dest,dbFile,avatar}
}
const stage=f=>convert({
  serverDirectory:f.serverDirectory,sourceRoot:f.sourceRoot,
  destinationRoot:f.destinationRoot,
})
test('synthetic first family split preserves all 22 data/history tables while disabling central owner and discarding activated sessions',t=>{
  const f=fixture(t)
  const beforeDb=hash(f.dbFile),beforeAvatar=hash(f.avatar)
  const r=stage(f)
  assert.equal(r.kind,'phase1-disposable-primary-family-split-rehearsal-v1')
  assert.equal(r.sourceFixtureOnly,true)
  assert.equal(r.preservedHouseholdAndNoticeTables,22)
  assert.equal(r.copiedUploadFiles,1)
  assert.equal(r.historicalOutboxRowsPreserved,31)
  assert.equal(r.orphanedEventNoticeReferencesPreserved,4)
  assert.equal(r.orphanedPersonNoticeReferencesPreserved,2)
  assert.equal(r.historicalAcknowledgementRowsPreserved,14)
  assert.equal(r.historicalAcknowledgementOrphansPreserved,0)
  assert.equal(r.deletedEventAndPersonHistoryNeverAutoPruned,true)
  assert.equal(r.approvedSyntheticFixtureTriggersPreserved,3)
  assert.equal(r.retainedIndexAndTriggerFingerprintsEqual,true)
  assert.equal(r.realArchivedTriggerBodiesApproved,false)
  assert.equal(r.stagedOwnersDisabled,1)
  assert.equal(r.centralActiveSessions,0)
  assert.equal(r.archivedLegacySessionsNotActivated,true)
  assert.equal(r.sourceCredentialsNotPlacedInHouseholdDatabase,true)
  assert.equal(r.savedPushDeviceSubscriptionsNotActivated,true)
  assert.equal(r.fullLegacySchemaCompatibilityProven,false)
  for(const key of ['centralGatewayBootProven','activeRealCalendarDataHandled',
    'actualTestMigrationExecuted','automatedReactivationAllowed',
    'backupAuthorized','rollbackAuthorized','testDeploymentAuthorized',
    'liveDeploymentAuthorized'])assert.equal(r[key],false,key)
  const centralPath=path.join(f.destinationRoot,'central','identity.db')
  const familyPath=path.join(f.destinationRoot,'households','primary-family',
    'data','calendar.db')
  const c=new DatabaseSync(centralPath,{readOnly:true})
  const h=new DatabaseSync(familyPath,{readOnly:true})
  try {
    assert.equal(c.prepare('SELECT COUNT(*) AS n FROM family_users').get().n,1)
    assert.equal(c.prepare('SELECT disabled FROM family_users').get().disabled,1)
    assert.equal(c.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n,0)
    assert.equal(c.prepare('SELECT COUNT(*) AS n FROM household_memberships WHERE role=? AND disabled=1').get('owner').n,1)
    assert.equal(c.prepare('SELECT COUNT(*) AS n FROM household_registry WHERE disabled=1').get().n,1)
    const names=new Set(h.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name))
    for(const table of ['family_users','family_sessions','test_push_subscriptions',
      'test_push_deliveries','capture_inbox']) assert.equal(names.has(table),false)
    for(const table of ['events','people','lists','list_items','emoji_markers',
      'meal_plans','assignment_notification_outbox',
      'notification_event_baselines','test_event_invitations',
      'test_assignment_acknowledgements']) assert.equal(names.has(table),true)
    assert.equal(h.prepare('SELECT title FROM events').get().title,secret)
    assert.deepEqual([...h.prepare('SELECT payload FROM events').get().payload],
      [0,4,255,200])
    assert.equal(h.prepare('SELECT name FROM people').get().name,secret)
    assert.equal(h.prepare('SELECT status FROM test_event_invitations').get().status,'accepted')
    assert.equal(h.prepare('PRAGMA foreign_key_check').all().length,0)
  } finally {c.close();h.close()}
  // Exercise only the newly created disposable household DB. The original
  // source and disabled central login must never be activated by this test.
  const altered=new DatabaseSync(familyPath)
  try {
    const triggers=altered.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger'"
    ).all()
    assert.equal(triggers.length,3)
    const indexes=altered.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='list_items'"
    ).all()
    assert(indexes.some(x=>x.name==='phase1_fixture_list_item_store_idx'))
    altered.prepare('UPDATE events SET title=? WHERE id=46').run('synthetic changed event')
    altered.prepare('INSERT INTO event_people(id,event_id,person_id) VALUES(?,?,?)').run(2,46,7)
    altered.prepare('INSERT INTO event_exceptions(id,event_id,value) VALUES(?,?,?)')
      .run(1,46,'synthetic recurrence skip')
    for(const [table,id] of [
      ['notification_dirty_events',46],
      ['notification_dirty_event_fields',46],
      ['notification_dirty_event_attribution',46],
    ]) {
      assert.equal(altered.prepare(
        'SELECT COUNT(*) AS n FROM "'+table+'" WHERE id=?'
      ).get(id).n,1,'expected synthetic '+table+' trigger side effect')
    }
    assert.equal(altered.prepare('PRAGMA foreign_key_check').all().length,0)
  } finally {altered.close()}
  assert.equal(hash(f.dbFile),beforeDb)
  assert.equal(hash(f.avatar),beforeAvatar)
  assert.equal(hash(path.join(f.destinationRoot,'households','primary-family',
    'uploads','people','portrait.bin')),beforeAvatar)
  assert.equal(fs.existsSync(path.join(f.destinationRoot,'households',
    'primary-family','uploads','empty-folder')),true)
  const raw=JSON.stringify(r)
  assert.doesNotMatch(raw,/syntheticowner|Private Groceries|THIS_IS_A_SYNTHETIC/)
  assert.throws(()=>stage(f),/refused/)
})

test('31 archived synthetic notices retain four missing-event and two missing-Person references with all acknowledgements',t=>{
  const f=fixture(t)
  const sourceDigest=hash(f.dbFile)
  const receipt=stage(f)
  assert.equal(receipt.historicalOutboxRowsPreserved,31)
  assert.equal(receipt.orphanedEventNoticeReferencesPreserved,4)
  assert.equal(receipt.orphanedPersonNoticeReferencesPreserved,2)
  assert.equal(receipt.historicalAcknowledgementRowsPreserved,14)
  assert.equal(receipt.historicalAcknowledgementOrphansPreserved,0)
  const dest=path.join(f.destinationRoot,'households','primary-family','data','calendar.db')
  const result=new DatabaseSync(dest,{readOnly:true})
  try {
    const count=result.prepare('SELECT COUNT(*) AS n FROM assignment_notification_outbox').get().n
    const eventOrphans=result.prepare(
      'SELECT COUNT(*) AS n FROM assignment_notification_outbox o WHERE NOT EXISTS(SELECT 1 FROM events e WHERE e.id=o.event_id)'
    ).get().n
    const personOrphans=result.prepare(
      'SELECT COUNT(*) AS n FROM assignment_notification_outbox o WHERE NOT EXISTS(SELECT 1 FROM people p WHERE p.id=o.person_id)'
    ).get().n
    const ack=result.prepare(
      'SELECT COUNT(*) AS n FROM test_assignment_acknowledgements'
    ).get().n
    assert.deepEqual([count,eventOrphans,personOrphans,ack],[31,4,2,14])
    const details=result.prepare(
      'SELECT cancelled_details_json FROM assignment_notification_outbox WHERE id=2'
    ).get().cancelled_details_json
    assert.deepEqual(JSON.parse(details),{
      detail:'historical synthetic notification',id:2,
    })
    assert.equal(result.prepare('PRAGMA foreign_key_check').all().length,0)
  } finally {result.close()}
  assert.equal(hash(f.dbFile),sourceDigest)
  const raw=JSON.stringify(receipt)
  assert.doesNotMatch(raw,/syntheticowner|THIS_IS_A_SYNTHETIC|historical synthetic notification/)
  for(const key of [
    'actualTestMigrationExecuted','testDeploymentAuthorized',
    'liveDeploymentAuthorized','backupAuthorized','rollbackAuthorized'
  ])assert.equal(receipt[key],false,key)
})

test('real recovery layout and unmarked source are never eligible for conversion',t=>{
  const f=fixture(t)
  fs.writeFileSync(path.join(f.sourceRoot,'.phase1-disposable-legacy-fixture.json'),
    '{"kind":"phase1-offline-legacy-test-snapshot-v1"}')
  assert.throws(()=>stage(f),/refused/)
  assert.equal(fs.existsSync(f.destinationRoot),false)
  const other=fixture(t)
  const replacement=path.join(os.tmpdir(),'family-calendar-phase1-recovery')
  assert.throws(()=>convert({...other,sourceRoot:replacement}),/refused|ENOENT/)
})
test('new table, WAL, excluded foreign key or retired inbox content fail closed and leave no staged output',t=>{
  for(const change of [
    f=>fs.writeFileSync(f.dbFile+'-wal','unsafe'),
    f=>{
      const db=new DatabaseSync(f.dbFile)
      try{db.exec('CREATE TABLE leaked_sensitivity(id INTEGER PRIMARY KEY)')}
      finally{db.close()}
    },
    f=>{
      const db=new DatabaseSync(f.dbFile)
      try{db.prepare('INSERT INTO capture_inbox(id,value) VALUES(1,?)').run(secret)}
      finally{db.close()}
    },
    f=>{
      const db=new DatabaseSync(f.dbFile)
      try{
        db.exec('ALTER TABLE daily_notes ADD COLUMN owner_id INTEGER REFERENCES family_users(id)')
      }finally{db.close()}
    },
    f=>{
      const db=new DatabaseSync(f.dbFile)
      try{db.exec('CREATE VIEW unsafe_view AS SELECT * FROM family_users')}
      finally{db.close()}
    },
    f=>{
      const db=new DatabaseSync(f.dbFile)
      try{db.exec(
        'CREATE TRIGGER unreviewed_login_trigger AFTER UPDATE ON events BEGIN SELECT password_hash FROM family_users; END'
      )}
      finally{db.close()}
    },
  ]) {
    const f=fixture(t);change(f)
    assert.throws(()=>stage(f),/refused/)
    assert.equal(fs.existsSync(f.destinationRoot),false)
  }
})
test('untrusted destination collision, linked uploads, unsupported owner and separate code/source boundaries fail closed',t=>{
  const f=fixture(t)
  fs.mkdirSync(f.destinationRoot)
  assert.throws(()=>stage(f),/refused/)
  fs.rmdirSync(f.destinationRoot)
  const sym=path.join(f.sourceRoot,'uploads','unsafe-link')
  // Windows CI runners may not grant unprivileged symlink creation.
  let linked=false
  try {fs.symlinkSync(f.avatar,sym,'file');linked=true}
  catch(error) {
    if(process.platform!=='win32'||!['EPERM','EACCES','ENOSYS'].includes(error.code))throw error
  }
  if(linked) {
    assert.throws(()=>stage(f),/refused/)
    fs.rmSync(sym)
  }
  const db=new DatabaseSync(f.dbFile)
  try{
    db.exec("UPDATE family_users SET account_kind='hub'")
  } finally {db.close()}
  assert.throws(()=>stage(f),/refused/)
  assert.equal(fs.existsSync(f.destinationRoot),false)
})


// Source-backed notification schema layered on the existing marked synthetic
// fixture. The event columns needed by the installed source are present, and
// all notification capture/outbox SQL comes from the real reviewed installers.
// Other legacy table shapes remain synthetic, so this is NOT full 162-column
// archive compatibility or a real repair/migration runner.
function sourceNotificationFixture(t) {
  const f=fixture(t)
  fs.writeFileSync(path.join(f.sourceRoot,'.phase1-disposable-legacy-fixture.json'),
    JSON.stringify({kind:'phase1-disposable-synthetic-legacy-only',
      version:1,realCalendarDataAllowed:false,notificationSchema:'source-generated-v1'}))
  const db=new DatabaseSync(f.dbFile)
  try {
    for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) {
      assert.match(name,/^phase1_fixture_[a-z_]+$/)
      db.exec('DROP TRIGGER "'+name+'"')
    }
    for(const name of ['date','end_date','time','end_time','person','notes','batch_id',
      'location','repeat_unit','repeat_end_type','repeat_end_date']) {
      db.exec('ALTER TABLE events ADD COLUMN '+name+' TEXT')
    }
    for(const name of ['repeat_interval','repeat_count']) {
      db.exec('ALTER TABLE events ADD COLUMN '+name+' INTEGER')
    }
    db.exec('ALTER TABLE event_exceptions ADD COLUMN occurrence_date TEXT')
    db.exec("UPDATE events SET date='2026-11-24',location='Synthetic venue'")
    for(const name of ['test_assignment_acknowledgements','assignment_notification_outbox',
      'notification_event_baselines','notification_dirty_events',
      'notification_dirty_event_attribution','notification_dirty_event_fields',
      'notification_deleted_event_details']) {
      db.exec('DROP TABLE '+name)
    }
    installAssignmentNotificationOutbox(db)
    installNotificationMutationCapture(db)
    // Exact source DDL from test-notification-inbox-pilot.mjs, without routes.
    db.exec('CREATE TABLE test_assignment_acknowledgements('+
      'notification_id INTEGER PRIMARY KEY REFERENCES assignment_notification_outbox(id),'+
      'acknowledged_at INTEGER NOT NULL CHECK(acknowledged_at > 0)) STRICT')
    const insert=db.prepare('INSERT INTO assignment_notification_outbox'+
      '(id,event_id,person_id,kind,created_at,delivered_at,cancelled_details_json) VALUES(?,?,?,?,?,?,?)')
    for(let id=1;id<=31;id++) {
      insert.run(id,id<=4?1000+id:46,id===5||id===6?2000+id:7,
        'cancelled',1000+id,2000+id,JSON.stringify({title:'Synthetic cancelled '+id,date:'2026-11-24'}))
    }
    const ack=db.prepare('INSERT INTO test_assignment_acknowledgements VALUES(?,?)')
    for(let id=1;id<=14;id++)ack.run(id,3000+id)
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
  } finally {db.close()}
  return f
}

test('source-generated fourteen-trigger notification schema survives first household split and actual reconciliation',t=>{
  const f=sourceNotificationFixture(t)
  const before=hash(f.dbFile)
  const legacy=new DatabaseSync(f.dbFile,{readOnly:true})
  let passwordHash
  try {passwordHash=legacy.prepare('SELECT password_hash FROM family_users').get().password_hash}
  finally {legacy.close()}
  const receipt=stage(f)
  assert.equal(receipt.sourceGeneratedCurrentNotificationTriggersPreserved,14)
  assert.equal(receipt.preservedHouseholdAndNoticeTables,22)
  assert.equal(receipt.historicalOutboxRowsPreserved,31)
  assert.equal(receipt.orphanedEventNoticeReferencesPreserved,4)
  assert.equal(receipt.orphanedPersonNoticeReferencesPreserved,2)
  assert.equal(receipt.historicalAcknowledgementRowsPreserved,14)
  assert.equal(receipt.syntheticHouseholdOutputCompacted,true)
  assert.equal(receipt.fullLegacySchemaCompatibilityProven,false)
  assert.equal(receipt.actualTestMigrationExecuted,false)
  const filename=path.join(f.destinationRoot,'households','primary-family','data','calendar.db')
  const bytes=fs.readFileSync(filename)
  assert.equal(bytes.includes(Buffer.from(passwordHash)),false)
  assert.equal(bytes.includes(Buffer.from('f'.repeat(64))),false)
  assert.equal(bytes.includes(Buffer.from('e'.repeat(64))),false)
  assert.equal(bytes.includes(Buffer.from('syntheticowner')),false)
  const db=new DatabaseSync(filename)
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'").get().n,14)
    assert.equal(db.prepare('PRAGMA freelist_count').get().freelist_count,0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM test_assignment_acknowledgements').get().n,14)
    assert.equal(JSON.parse(db.prepare('SELECT cancelled_details_json FROM assignment_notification_outbox WHERE id=1').get().cancelled_details_json).title,'Synthetic cancelled 1')
    db.prepare('INSERT INTO events(id,title,date,time,location) VALUES(?,?,?,?,?)').run(99,'Synthetic appointment','2026-11-24','12:00','Synthetic room')
    db.prepare('INSERT INTO event_people(id,event_id,person_id) VALUES(?,?,?)').run(99,99,7)
    reconcileNotificationMutations(db,{at:4000})
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assignment_notification_outbox WHERE event_id=99 AND kind='assigned'").get().n,1)
    db.prepare('UPDATE events SET title=? WHERE id=99').run('Synthetic changed appointment')
    db.prepare('INSERT INTO event_exceptions(id,event_id,occurrence_date) VALUES(?,?,?)').run(99,99,'2026-11-25')
    reconcileNotificationMutations(db,{at:5000})
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assignment_notification_outbox WHERE event_id=99 AND kind='changed'").get().n,1)
    db.exec('BEGIN IMMEDIATE; DELETE FROM event_exceptions WHERE event_id=99; DELETE FROM event_people WHERE event_id=99; DELETE FROM events WHERE id=99; COMMIT')
    reconcileNotificationMutations(db,{at:6000})
    const cancelled=db.prepare("SELECT cancelled_details_json FROM assignment_notification_outbox WHERE event_id=99 AND kind='cancelled'").get()
    assert.equal(JSON.parse(cancelled.cancelled_details_json).title,'Synthetic changed appointment')
    // The exact repaired event-insert trigger clears an old deletion snapshot.
    db.exec("INSERT INTO events(id,title,date) VALUES(100,'Old','2026-11-24'); DELETE FROM events WHERE id=100")
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_deleted_event_details WHERE event_id=100').get().n,1)
    db.exec("INSERT INTO events(id,title,date) VALUES(100,'New','2026-11-25')")
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_deleted_event_details WHERE event_id=100').get().n,0)
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
  } finally {db.close()}
  assert.equal(hash(f.dbFile),before)
})

test('source-generated conversion refuses historical predecessor, unexpected trigger, or wrong fixture mode',t=>{
  for(const change of [
    f=>{
      const db=new DatabaseSync(f.dbFile)
      try {
        const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='notify_event_insert'").get().sql
        const old=sql.replace('DELETE FROM notification_deleted_event_details WHERE event_id=NEW.id;\n','')
        assert.notEqual(old,sql)
        db.exec('DROP TRIGGER notify_event_insert');db.exec(old)
      } finally {db.close()}
    },
    f=>{
      const db=new DatabaseSync(f.dbFile)
      try {db.exec('CREATE TRIGGER unexpected_fixture AFTER INSERT ON events BEGIN SELECT 1; END')}
      finally {db.close()}
    },
    f=>fs.writeFileSync(path.join(f.sourceRoot,'.phase1-disposable-legacy-fixture.json'),
      JSON.stringify({kind:'phase1-disposable-synthetic-legacy-only',version:1,realCalendarDataAllowed:false})),
  ]) {
    const f=sourceNotificationFixture(t);change(f)
    const before=hash(f.dbFile)
    assert.throws(()=>stage(f),/refused/)
    assert.equal(fs.existsSync(f.destinationRoot),false)
    assert.equal(hash(f.dbFile),before)
  }
})
