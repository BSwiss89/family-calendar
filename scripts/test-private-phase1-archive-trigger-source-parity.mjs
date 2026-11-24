// Purely synthetic in-memory tests. Never accesses real TEST/LIVE or archive.
import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {
  installNotificationMutationCapture,reconcileNotificationMutations,
} from '../Server/notification-event-mutation-capture.mjs'
import {installAssignmentNotificationOutbox}
  from '../Server/event-assignment-notifications.mjs'
import {comparePrivatePhase1SourceTriggerDefinitions as compare}
  from '../Server/private-phase1-archive-trigger-source-parity.mjs'

const testSchema=[
 'PRAGMA foreign_keys=ON;',
 'CREATE TABLE events(',
 'id INTEGER PRIMARY KEY,date TEXT,title TEXT,time TEXT,person TEXT,notes TEXT,',
 'repeat_unit TEXT,repeat_interval INTEGER,repeat_end_type TEXT,',
 'repeat_end_date TEXT,repeat_count INTEGER,end_date TEXT,end_time TEXT,',
 'batch_id TEXT,location TEXT);',
 'CREATE TABLE people(id INTEGER PRIMARY KEY);',
 'CREATE TABLE event_people(event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,',
 'person_id INTEGER REFERENCES people(id) ON DELETE CASCADE);',
 'CREATE TABLE event_exceptions(event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,occurrence_date TEXT);',
].join(' ')

function reference() {
 const db=new DatabaseSync(':memory:')
 try {
  db.exec(testSchema)
  installNotificationMutationCapture(db)
  return db.prepare(
   "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"
  ).all()
 } finally {db.close()}
}
function archive() {return reference()}

test('all 14 source-created triggers match EXACTLY, including deleted-event details; none is auto-approved',()=>{
 const result=compare(archive())
 assert.equal(result.kind,'phase1-historical-trigger-source-parity-v1')
 assert.equal(result.expectedArchivedTriggerCount,14)
 assert.equal(result.reviewedSourceTriggerCount,14)
 assert.equal(result.exactSourceMatches,14)
 assert.equal(result.eventInsertDriftClassification,'EXACT_CURRENT_DEFINITION')
 assert.equal(result.eventInsertNeedsSeparateApproval,false)
 assert.equal(result.archivedTriggersWithoutCurrentSourceDefinition,0)
 assert.equal(result.knownDefinitionDrift,0)
 assert.equal(result.missingKnownSource,0)
 const deleteCapture=result.knownSourceReviews.find(x=>
  x.sourceTrigger==='notify_deleted_event_details')
 assert.equal(deleteCapture.state,'EXACT_SOURCE_MATCH')
 assert.equal(deleteCapture.sourceTable,'events')
 assert.equal(result.unknownTriggerNamesOrSqlExposed,false)
 assert.equal(result.matchingTriggersApprovedToReplay,false)
 assert.equal(result.archivedUnknownTriggersApprovedToReplay,false)
 assert.equal(result.allArchivedTriggerSemanticsReviewed,false)
 for(const flag of ['dataMigrationAuthorized','testDeploymentAuthorized',
  'liveDeploymentAuthorized','rollbackAuthorized'])assert.equal(result[flag],false)
 assert.equal(result.knownSourceReviews.every(x=>
  x.state==='EXACT_SOURCE_MATCH'&&x.replayApproved===false),true)
})
test('changing cancellation details capture or event-insert cleanup is detected despite matching name',()=>{
 for(const trigger of ['notify_deleted_event_details','notify_event_insert']) {
  const altered=archive()
  const entry=altered.find(x=>x.name===trigger)
  assert(entry)
  entry.sql+=' /* old cancellation behavior lost */'
  const result=compare(altered)
  assert.equal(result.knownDefinitionDrift,1)
  assert.equal(result.exactSourceMatches,13)
  assert.equal(result.archivedTriggersWithoutCurrentSourceDefinition,0)
  assert.equal(result.knownSourceReviews.find(x=>
   x.sourceTrigger===trigger).state,'DEFINITION_DRIFT')
  assert.equal(result.dataMigrationAuthorized,false)
 }
})

test('the exact older INSERT definition without event-ID reuse cleanup is classified, never approved',()=>{
 const source=archive()
 const row=source.find(x=>x.name==='notify_event_insert')
 assert(row)
 const marker='DELETE FROM notification_deleted_event_details WHERE event_id=NEW.id;\n'
 assert.equal(row.sql.split(marker).length,2)
 row.sql=row.sql.replace(marker,'')
 const result=compare(source)
 assert.equal(result.exactSourceMatches,13)
 assert.equal(result.knownDefinitionDrift,1)
 assert.equal(result.eventInsertDriftClassification,'EXACT_PRE_REUSE_CLEANUP_DEFINITION')
 assert.equal(result.eventInsertNeedsSeparateApproval,true)
 assert.equal(result.matchingTriggersApprovedToReplay,false)
 assert.equal(result.unreviewedSourceSqlExecuted,false)
 assert.equal(result.archivedSourceSqlReturned,false)
 const report=JSON.stringify(result)
 assert.doesNotMatch(report,/CREATE TRIGGER|DELETE FROM notification_deleted_event_details/)
})
test('a small unreviewed formatting or text change is not misidentified as the old safe predecessor',()=>{
 const rows=archive()
 rows.find(x=>x.name==='notify_event_insert').sql+=' /* cosmetic but not reviewed */'
 const result=compare(rows)
 assert.equal(result.eventInsertDriftClassification,'UNCLASSIFIED_DEFINITION_DRIFT')
 assert.equal(result.eventInsertNeedsSeparateApproval,true)
})
test('IF NOT EXISTS leaves an old event INSERT trigger unchanged; newer source cannot repair it implicitly',()=>{
 const db=new DatabaseSync(':memory:')
 try {
  db.exec(testSchema)
  installAssignmentNotificationOutbox(db)
  installNotificationMutationCapture(db)
  const current=db.prepare(
   "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='notify_event_insert'"
  ).get().sql
  const marker='DELETE FROM notification_deleted_event_details WHERE event_id=NEW.id;\n'
  assert.equal(current.split(marker).length,2)
  const predecessor=current.replace(marker,'')
  db.exec('DROP TRIGGER notify_event_insert')
  db.exec(predecessor)
  assert.equal(db.prepare(
   "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='notify_event_insert'"
  ).get().sql,predecessor)
  installNotificationMutationCapture(db)
  assert.equal(db.prepare(
   "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='notify_event_insert'"
  ).get().sql,predecessor)
  const state=compare(db.prepare(
   "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"
  ).all())
  assert.equal(state.eventInsertDriftClassification,'EXACT_PRE_REUSE_CLEANUP_DEFINITION')
  assert.equal(state.eventInsertNeedsSeparateApproval,true)
  // Old behavior leaves a transient deleted-event identity row across
  // reuse of the SAME integer event ID until reconciliation. Current
  // source clears it on reinsertion, preventing stale detail state.
  db.prepare('INSERT INTO events(id,date,title) VALUES(?,?,?)')
    .run(8,'2026-12-01','synthetic prior event')
  db.prepare('DELETE FROM events WHERE id=8').run()
  assert.equal(db.prepare(
   'SELECT COUNT(*) AS n FROM notification_deleted_event_details WHERE event_id=8'
  ).get().n,1)
  db.prepare('INSERT INTO events(id,date,title) VALUES(?,?,?)')
    .run(8,'2026-12-02','synthetic replacement event')
  assert.equal(db.prepare(
   'SELECT COUNT(*) AS n FROM notification_deleted_event_details WHERE event_id=8'
  ).get().n,1)
 } finally {db.close()}
})

test('missing cancellation capture cannot pass just because 14 triggers remain',()=>{
 const altered=archive().filter(x=>x.name!=='notify_deleted_event_details')
 altered.push({
  name:'unreviewed_event_trigger',
  tbl_name:'events',
  sql:'CREATE TRIGGER unreviewed_event_trigger BEFORE DELETE ON events BEGIN SELECT 2; END',
 })
 const result=compare(altered)
 assert.equal(result.missingKnownSource,1)
 assert.equal(result.archivedTriggersWithoutCurrentSourceDefinition,1)
 assert.equal(result.exactSourceMatches,13)
 assert.equal(result.allArchivedTriggerSemanticsReviewed,false)
 assert.doesNotMatch(JSON.stringify(result),/unreviewed_event_trigger/)
})
test('duplicate, malformed, or changed historical trigger distributions refuse',()=>{
 for(const mutate of [
  rows=>rows.pop(),
  rows=>rows.push({...rows[0]}),
  rows=>rows[0].tbl_name='family_users',
  rows=>rows[0].sql='x'.repeat(100001),
  rows=>rows[0].name='',
  rows=>rows[0].tbl_name='event_exceptions',
 ]) {
  const rows=archive();mutate(rows)
  assert.throws(()=>compare(rows),/refused/)
 }
})
test('restored installed-source cancellation flow preserves event identity for original recipient only',()=>{
 const db=new DatabaseSync(':memory:')
 try {
  db.exec(testSchema)
  db.prepare('INSERT INTO people(id) VALUES(?)').run(7)
  db.prepare('INSERT INTO events(id,date,title,time,end_date,end_time,location) VALUES(?,?,?,?,?,?,?)')
   .run(46,'2026-12-01','Synthetic deleted-event title','18:30','2026-12-02','19:00','Synthetic location')
  db.prepare('INSERT INTO event_people(event_id,person_id) VALUES(?,?)').run(46,7)
  installAssignmentNotificationOutbox(db)
  installNotificationMutationCapture(db)
  assert.equal(db.prepare(
   "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'"
  ).get().n,14)
  db.prepare('DELETE FROM events WHERE id=?').run(46)
  assert.equal(db.prepare(
   'SELECT COUNT(*) AS n FROM notification_deleted_event_details'
  ).get().n,1)
  const receipt=reconcileNotificationMutations(db,{at:Date.now()})
  assert.equal(receipt.queued,1)
  const notice=db.prepare(
   "SELECT event_id,person_id,kind,cancelled_details_json FROM assignment_notification_outbox"
  ).get()
  assert.equal(notice.event_id,46)
  assert.equal(notice.person_id,7)
  assert.equal(notice.kind,'cancelled')
  assert.deepEqual(JSON.parse(notice.cancelled_details_json),{
   title:'Synthetic deleted-event title',
   date:'2026-12-01',endDate:'2026-12-02',
   time:'18:30',endTime:'19:00',location:'Synthetic location',
  })
  assert.equal(db.prepare(
   'SELECT COUNT(*) AS n FROM notification_deleted_event_details'
  ).get().n,0)
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
 } finally {db.close()}
})
