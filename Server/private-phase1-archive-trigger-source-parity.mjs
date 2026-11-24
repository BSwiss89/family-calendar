// Read-only comparison of the VERIFIED Nov 22 offline TEST archive to the
// current committed single-household notification trigger installer.
// NEVER executes archived SQL, prints trigger names/SQL, reads row contents,
// accesses installed LIVE/TEST or authorizes data migration or trigger replay.
// The reference triggers are built in an independent :memory: SQLite database
// from our reviewed source, not copied from the archived database.
import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {installNotificationMutationCapture}
  from './notification-event-mutation-capture.mjs'
import {auditPrivatePhase1OfflineLegacySchema}
  from './private-phase1-offline-schema-relationship-audit.mjs'

const LEGACY_TRIGGER_COUNTS=Object.freeze({events:5,event_people:3,event_exceptions:6})
const SOURCE_TRIGGER_COUNTS=Object.freeze({events:4,event_people:3,event_exceptions:6})
const expectSourceNames=Object.freeze([
 'notify_event_insert','notify_event_update','notify_event_delete',
 'notify_people_insert','notify_people_update','notify_people_delete',
 'notify_exception_insert','notify_exception_update','notify_exception_delete',
 'notify_changed_event_fields','notify_changed_exception_insert',
 'notify_changed_exception_update','notify_changed_exception_delete',
])
const digest=s=>createHash('sha256').update(s).digest('hex')
const refuse=reason=>{
 throw new Error('Phase 1 archived trigger-source comparison refused: '+reason)
}
function readTriggerRows(db) {
 return db.prepare(
  "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"
 ).all()
}
function trustedReference() {
 const db=new DatabaseSync(':memory:')
 try {
  db.exec([
   'CREATE TABLE events (',
   'id INTEGER PRIMARY KEY,date TEXT,title TEXT,time TEXT,person TEXT,notes TEXT,',
   'repeat_unit TEXT,repeat_interval INTEGER,repeat_end_type TEXT,',
   'repeat_end_date TEXT,repeat_count INTEGER,end_date TEXT,end_time TEXT,',
   'batch_id TEXT,location TEXT);',
   'CREATE TABLE people(id INTEGER PRIMARY KEY);',
   'CREATE TABLE event_people(event_id INTEGER,person_id INTEGER);',
   'CREATE TABLE event_exceptions(event_id INTEGER,occurrence_date TEXT);',
  ].join(' '))
  installNotificationMutationCapture(db)
  const expected=readTriggerRows(db)
  if(expected.length!==13||
    expectSourceNames.some(name=>expected.filter(t=>t.name===name).length!==1) ||
    Object.entries(SOURCE_TRIGGER_COUNTS).some(([table,n])=>
      expected.filter(t=>t.tbl_name===table).length!==n)) {
   refuse('trusted source no longer generates reviewed 13 notification triggers.')
  }
  return expected
 } finally { db.close() }
}
function safeArchivedTriggerRows(rows) {
 if(!Array.isArray(rows)||rows.length!==14)refuse('expected exactly 14 archived triggers.')
 const seen=new Set()
 for(const x of rows) {
  if(!x||typeof x.name!=='string'||! /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(x.name)||
    typeof x.sql!=='string'||x.sql.length>100000||
    !Object.hasOwn(LEGACY_TRIGGER_COUNTS,x.tbl_name)||seen.has(x.name)){
    refuse('duplicate, unexpected or oversized archived trigger.')
  }
  seen.add(x.name)
 }
 if(Object.entries(LEGACY_TRIGGER_COUNTS).some(([table,n])=>
   rows.filter(x=>x.tbl_name===table).length!==n)){
  refuse('archived trigger distribution no longer matches the verified historical baseline.')
 }
 return rows
}
/**
 * Exported PURE comparison helper for disposable regression cases. Input names
 * and SQL are not returned. Even exact matches have no replay permission.
 */
export function comparePrivatePhase1SourceTriggerDefinitions(rows,referenceRows) {
 const archived=safeArchivedTriggerRows(rows)
 const source=referenceRows??trustedReference()
 if(!Array.isArray(source)||source.length!==13||
   expectSourceNames.some(n=>source.filter(x=>x.name===n).length!==1)){
  refuse('reference trigger roster changed.')
 }
 const byName=new Map(archived.map(x=>[x.name,x]))
 const results=source.map(x=>{
  const actual=byName.get(x.name)
  const state=!actual?'MISSING':
    actual.tbl_name!==x.tbl_name?'SOURCE_TABLE_DRIFT':
    digest(actual.sql)===digest(x.sql)?'EXACT_SOURCE_MATCH':'DEFINITION_DRIFT'
  return Object.freeze({
   // Known source-defined identifiers are safe; never echo an archived-only
   // trigger name or SQL, or any account/event/notification field values.
   sourceTrigger:x.name,sourceTable:x.tbl_name,
   state,
   actualDefinitionSha256:actual?digest(actual.sql):null,
   expectedSourceDefinitionSha256:digest(x.sql),
   replayApproved:false,semanticsApprovedForRealMigration:false,
  })
 })
 const known=new Set(source.map(x=>x.name))
 const unknown=archived.filter(x=>!known.has(x.name))
 const counts=Object.freeze({
  exactSourceMatches:results.filter(x=>x.state==='EXACT_SOURCE_MATCH').length,
  missingKnownSource:results.filter(x=>x.state==='MISSING').length,
  knownDefinitionDrift:results.filter(x=>['DEFINITION_DRIFT','SOURCE_TABLE_DRIFT'].includes(x.state)).length,
  archivedTriggersWithoutCurrentSourceDefinition:unknown.length,
 })
 return Object.freeze({
  kind:'phase1-historical-trigger-source-parity-v1',
  exactSourceComparisonExecuted:true,
  expectedArchivedTriggerCount:14,
  reviewedSourceTriggerCount:13,
  ...counts,
  knownSourceReviews:Object.freeze(results),
  unknownTriggerNamesOrSqlExposed:false,
  currentSourceInstallerReproducedInMemory:true,
  // Exact source DDL alone does not prove correct runtime semantics. The
  // unmatched trigger(s) need separate archived inspection and review.
  allArchivedTriggerSemanticsReviewed:false,
  matchingTriggersApprovedToReplay:false,
  archivedUnknownTriggersApprovedToReplay:false,
  dataMigrationAuthorized:false,
  testDeploymentAuthorized:false,liveDeploymentAuthorized:false,
  rollbackAuthorized:false,
 })
}
/**
 * The existing schema auditor independently re-verifies all backup files and
 * checks SQLITE integrity before/after. The archived SQLite is opened in
 * strict read-only mode; its trigger SQL is NEVER executed or printed.
 */
export function inspectPrivatePhase1ArchivedTriggerSourceParity(args) {
 const before=auditPrivatePhase1OfflineLegacySchema(args)
 if(before.tables!==27||before.totalTriggers!==14||
    before.testDeploymentAuthorized!==false)refuse('complete verified legacy archive required.')
 const db=new DatabaseSync(path.join(args.snapshotRoot,'calendar.db'),{readOnly:true})
 let result
 try {
  db.exec('PRAGMA query_only=ON')
  result=comparePrivatePhase1SourceTriggerDefinitions(readTriggerRows(db))
 } finally {db.close()}
 const after=auditPrivatePhase1OfflineLegacySchema(args)
 if(after.schemaSha256!==before.schemaSha256||
    after.totalIndexes!==before.totalIndexes||
    after.totalTriggers!==before.totalTriggers||
    after.totalColumns!==before.totalColumns)refuse('verified archived schema changed during review.')
 return Object.freeze({
  ...result,verifiedHistoricalArchive:true,archivedSchemaSha256:before.schemaSha256,
  originalArchiveModified:false,installedCalendarsModified:false,
  realMigrationExecuted:false,backupAuthorized:false,
 })
}
