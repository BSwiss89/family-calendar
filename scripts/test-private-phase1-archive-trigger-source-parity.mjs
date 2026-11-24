// Purely synthetic, in-memory tests. No real calendar or saved archive.
import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {installNotificationMutationCapture}
  from '../Server/notification-event-mutation-capture.mjs'
import {comparePrivatePhase1SourceTriggerDefinitions as compare}
  from '../Server/private-phase1-archive-trigger-source-parity.mjs'

function reference() {
 const db=new DatabaseSync(':memory:')
 try {
  db.exec([
   'CREATE TABLE events(',
   'id INTEGER PRIMARY KEY,date TEXT,title TEXT,time TEXT,person TEXT,notes TEXT,',
   'repeat_unit TEXT,repeat_interval INTEGER,repeat_end_type TEXT,',
   'repeat_end_date TEXT,repeat_count INTEGER,end_date TEXT,end_time TEXT,',
   'batch_id TEXT,location TEXT);',
   'CREATE TABLE people(id INTEGER PRIMARY KEY);',
   'CREATE TABLE event_people(event_id INTEGER,person_id INTEGER);',
   'CREATE TABLE event_exceptions(event_id INTEGER,occurrence_date TEXT);'
  ].join(' '))
  installNotificationMutationCapture(db)
  return db.prepare(
   "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"
  ).all()
 } finally {db.close()}
}
function archive() {
 return [...reference(),{
  name:'archived_custom_trigger_only_for_fixture',
  tbl_name:'events',
  sql:'CREATE TRIGGER archived_custom_trigger_only_for_fixture AFTER DELETE ON events BEGIN SELECT 1; END',
 }]
}
test('thirteen source-created triggers match byte-exactly; the fourteenth remains unapproved',()=>{
 const result=compare(archive())
 assert.equal(result.kind,'phase1-historical-trigger-source-parity-v1')
 assert.equal(result.expectedArchivedTriggerCount,14)
 assert.equal(result.reviewedSourceTriggerCount,13)
 assert.equal(result.exactSourceMatches,13)
 assert.equal(result.archivedTriggersWithoutCurrentSourceDefinition,1)
 assert.equal(result.knownDefinitionDrift,0)
 assert.equal(result.missingKnownSource,0)
 assert.equal(result.unknownTriggerNamesOrSqlExposed,false)
 assert.equal(result.matchingTriggersApprovedToReplay,false)
 assert.equal(result.archivedUnknownTriggersApprovedToReplay,false)
 assert.equal(result.allArchivedTriggerSemanticsReviewed,false)
 for(const flag of ['dataMigrationAuthorized','testDeploymentAuthorized',
  'liveDeploymentAuthorized','rollbackAuthorized'])assert.equal(result[flag],false)
 assert.equal(result.knownSourceReviews.every(x=>
  x.state==='EXACT_SOURCE_MATCH'&&x.replayApproved===false),true)
 assert.doesNotMatch(JSON.stringify(result),/archived_custom_trigger_only_for_fixture|SELECT 1; END/)
})
test('source trigger body drift cannot pass using only the same name',()=>{
 const altered=archive()
 const event=altered.find(x=>x.name==='notify_event_update')
 assert(event)
 event.sql+=' /* intentionally altered body */'
 const result=compare(altered)
 assert.equal(result.knownDefinitionDrift,1)
 assert.equal(result.exactSourceMatches,12)
 assert.equal(result.archivedTriggersWithoutCurrentSourceDefinition,1)
 assert.equal(result.knownSourceReviews.find(x=>
  x.sourceTrigger==='notify_event_update').state,'DEFINITION_DRIFT')
 assert.equal(result.dataMigrationAuthorized,false)
})
test('missing known trigger fails closed to non-parity even with same 14 trigger count',()=>{
 const altered=archive().filter(x=>x.name!=='notify_event_insert')
 altered.push({
  name:'second_custom_fixture_trigger',
  tbl_name:'events',
  sql:'CREATE TRIGGER second_custom_fixture_trigger AFTER INSERT ON events BEGIN SELECT 2; END',
 })
 const result=compare(altered)
 assert.equal(result.missingKnownSource,1)
 assert.equal(result.archivedTriggersWithoutCurrentSourceDefinition,2)
 assert.equal(result.exactSourceMatches,12)
 assert.equal(result.allArchivedTriggerSemanticsReviewed,false)
})
test('duplicate, malformed or unexpected real trigger distributions refuse',()=>{
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
