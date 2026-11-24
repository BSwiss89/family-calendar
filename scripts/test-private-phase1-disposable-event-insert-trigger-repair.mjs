// All fixtures are disposable :memory: databases. Never use installed
// LIVE/TEST or the user's Nov 22 recovery archive. These checks exercise
// an atomic trigger-only repair and ensure all stored rows/indexes survive.
import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {installNotificationMutationCapture}
  from '../Server/notification-event-mutation-capture.mjs'
import {installAssignmentNotificationOutbox}
  from '../Server/event-assignment-notifications.mjs'
import {rehearsePrivatePhase1EventInsertTriggerRepair as rehearse}
  from '../Server/private-phase1-disposable-event-insert-trigger-repair.mjs'
import {comparePrivatePhase1SourceTriggerDefinitions as compare}
  from '../Server/private-phase1-archive-trigger-source-parity.mjs'

const syntheticSecret='SYNTHETIC_EVENT_OR_ACCOUNT_DATA_NEVER_EXPOSE'
const triggerSql=db=>db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='notify_event_insert'"
).get()?.sql
const triggerRows=db=>db.prepare(
  "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"
).all()

function fixture({outdated=true}={}) {
 const db=new DatabaseSync(':memory:')
 db.exec([
  'PRAGMA foreign_keys=ON;',
  'CREATE TABLE events(',
  'id INTEGER PRIMARY KEY,date TEXT,title TEXT,time TEXT,person TEXT,notes TEXT,',
  'repeat_unit TEXT,repeat_interval INTEGER,repeat_end_type TEXT,',
  'repeat_end_date TEXT,repeat_count INTEGER,end_date TEXT,end_time TEXT,',
  'batch_id TEXT,location TEXT);',
  'CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT);',
  'CREATE TABLE event_people(event_id INTEGER REFERENCES events(id),',
  'person_id INTEGER REFERENCES people(id));',
  'CREATE TABLE event_exceptions(event_id INTEGER REFERENCES events(id),occurrence_date TEXT);',
  "CREATE TABLE phase1_disposable_repair_marker(purpose TEXT NOT NULL);",
  "INSERT INTO phase1_disposable_repair_marker(purpose) VALUES('phase1-disposable-trigger-repair-fixture');",
  'CREATE TABLE test_assignment_acknowledgements(',
  'id INTEGER PRIMARY KEY,notification_id INTEGER,value TEXT);',
 ].join(' '))
 installAssignmentNotificationOutbox(db)
 db.prepare('INSERT INTO people(id,name) VALUES (?,?)').run(7,'Synthetic person')
 db.prepare('INSERT INTO events(id,date,title) VALUES (?,?,?)').run(46,'2026-12-01',syntheticSecret)
 db.prepare('INSERT INTO event_people(event_id,person_id) VALUES (?,?)').run(46,7)
 installNotificationMutationCapture(db)
 db.prepare('INSERT INTO test_assignment_acknowledgements(id,notification_id,value) VALUES(?,?,?)')
  .run(1,999,syntheticSecret)
 db.prepare([
  'INSERT INTO assignment_notification_outbox',
  '(event_id,person_id,kind,created_at,cancelled_details_json)',
  'VALUES(?,?,?,?,?)'
 ].join(' ')).run(901,704,'cancelled',Date.now(),JSON.stringify({title:syntheticSecret}))
 if(outdated) {
  const sql=triggerSql(db)
  const cleanup='DELETE FROM notification_deleted_event_details WHERE event_id=NEW.id;\n'
  assert(sql?.includes(cleanup))
  db.exec('DROP TRIGGER notify_event_insert')
  db.exec(sql.replace(cleanup,''))
 }
 assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
 return db
}

test('exact older event INSERT trigger is transactionally corrected in synthetic memory with every row and other trigger preserved',()=>{
 const db=fixture()
 try {
  const original=triggerRows(db)
  const oldSql=triggerSql(db)
  assert.equal(compare(original).eventInsertDriftClassification,'EXACT_PRE_REUSE_CLEANUP_DEFINITION')
  const originalNotice=db.prepare(
   'SELECT event_id,person_id,kind,cancelled_details_json FROM assignment_notification_outbox'
  ).get()
  const r=rehearse(db)
  assert.equal(r.kind,'phase1-disposable-event-insert-trigger-repair-rehearsal-v1')
  assert.equal(r.onlySyntheticMemoryDatabase,true)
  assert.equal(r.originalLegacyTriggerMatchedExactly,true)
  assert.equal(r.originalExactSourceMatches,13)
  assert.equal(r.postRepairExactSourceMatches,14)
  assert.equal(r.otherThirteenDefinitionsUnchanged,true)
  assert.equal(r.allStoredRowValuesUnchanged,true)
  assert.equal(r.indexesAndViewsUnchanged,true)
  assert.equal(r.legacyArchiveOpened,false)
  for(const flag of ['realDatabaseFileModified','realTriggerReplayAuthorized',
    'actualTestMigrationExecuted','backupAuthorized','rollbackAuthorized',
    'testDeploymentAuthorized','liveDeploymentAuthorized'])assert.equal(r[flag],false,flag)
  const now=triggerRows(db)
  assert.equal(now.length,14)
  assert.equal(compare(now).exactSourceMatches,14)
  for(const old of original.filter(x=>x.name!=='notify_event_insert')) {
   assert.deepEqual(now.find(x=>x.name===old.name),old)
  }
  assert.notEqual(oldSql,triggerSql(db))
  assert.deepEqual(db.prepare(
   'SELECT event_id,person_id,kind,cancelled_details_json FROM assignment_notification_outbox'
  ).get(),originalNotice)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM test_assignment_acknowledgements').get().n,1)
  assert.equal(db.prepare('SELECT title FROM events WHERE id=46').get().title,syntheticSecret)
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
  assert.doesNotMatch(JSON.stringify(r),/SYNTHETIC_EVENT_OR_ACCOUNT_DATA_NEVER_EXPOSE|CREATE TRIGGER/)
 } finally {db.close()}
})

test('the corrected trigger actually clears stale deletion details when a synthetic event ID is reused',()=>{
 const db=fixture()
 try {
  rehearse(db)
  db.prepare('INSERT INTO events(id,date,title) VALUES(?,?,?)')
   .run(8,'2026-12-03','synthetic past event')
  db.prepare('DELETE FROM events WHERE id=?').run(8)
  assert.equal(db.prepare(
   'SELECT COUNT(*) AS n FROM notification_deleted_event_details WHERE event_id=8'
  ).get().n,1)
  db.prepare('INSERT INTO events(id,date,title) VALUES(?,?,?)')
   .run(8,'2026-12-04','synthetic replacement event')
  assert.equal(db.prepare(
   'SELECT COUNT(*) AS n FROM notification_deleted_event_details WHERE event_id=8'
  ).get().n,0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assignment_notification_outbox').get().n,1)
 } finally {db.close()}
})

test('a synthetic injected failure after DROP TRIGGER rolls back the original trigger and every notification record',()=>{
 const db=fixture()
 try {
  const oldSql=triggerSql(db)
  const oldNotice=db.prepare('SELECT * FROM assignment_notification_outbox').all()
  assert.throws(()=>rehearse(db,{injectSyntheticFailureAfterDrop:true}),/refused/)
  assert.equal(triggerSql(db),oldSql)
  assert.equal(compare(triggerRows(db)).eventInsertDriftClassification,'EXACT_PRE_REUSE_CLEANUP_DEFINITION')
  assert.deepEqual(db.prepare('SELECT * FROM assignment_notification_outbox').all(),oldNotice)
  const good=rehearse(db)
  assert.equal(good.postRepairExactSourceMatches,14)
 } finally {db.close()}
})
test('already corrected, tampered, or missing notification triggers cannot be silently rewritten',()=>{
 for(const mutate of [
  db=>db.exec('DROP TRIGGER notify_people_update'),
  db=>{
   const old=triggerSql(db)
   db.exec('DROP TRIGGER notify_event_insert')
   db.exec(old.replace(
    'INSERT INTO notification_dirty_events',
    'INSERT INTO notification_dirty_events'
   )+' /* unreviewed trailing SQL text */')
  },
 ]) {
  const db=fixture()
  try {
   mutate(db)
   assert.throws(()=>rehearse(db),/refused/)
  } finally {db.close()}
 }
 const db=fixture({outdated:false})
 try {assert.throws(()=>rehearse(db),/refused/)}
 finally {db.close()}
})
test('unmarked memory, disabled FK checks, and attached databases refuse before writing',()=>{
 for(const change of [
  db=>db.exec('DELETE FROM phase1_disposable_repair_marker'),
  db=>db.exec('PRAGMA foreign_keys=OFF'),
  db=>db.exec("ATTACH DATABASE ':memory:' AS extra"),
 ]) {
  const db=fixture()
  try {
   const before=triggerSql(db)
   change(db)
   assert.throws(()=>rehearse(db),/refused/)
   assert.equal(triggerSql(db),before)
  } finally {db.close()}
 }
})
