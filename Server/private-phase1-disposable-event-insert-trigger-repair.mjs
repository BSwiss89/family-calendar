// Phase 1: exact, narrowly scoped trigger repair rehearsal.
// CRITICAL: accepts ONLY a caller-owned, explicitly marked SQLite :memory:
// fixture; it cannot open a disk DB, the Nov 22 recovery archive, or a
// running calendar. The sole change is one synthetically outdated trigger,
// wrapped in a rollback-able SQLite transaction. No real repair authorization.
import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
import {installNotificationMutationCapture}
  from './notification-event-mutation-capture.mjs'
import {comparePrivatePhase1SourceTriggerDefinitions}
  from './private-phase1-archive-trigger-source-parity.mjs'

const MARKER='phase1-disposable-trigger-repair-fixture'
const TEMPLATE=String.raw`
  CREATE TABLE events(
    id INTEGER PRIMARY KEY,date TEXT,title TEXT,time TEXT,person TEXT,notes TEXT,
    repeat_unit TEXT,repeat_interval INTEGER,repeat_end_type TEXT,
    repeat_end_date TEXT,repeat_count INTEGER,end_date TEXT,end_time TEXT,
    batch_id TEXT,location TEXT);
  CREATE TABLE people(id INTEGER PRIMARY KEY);
  CREATE TABLE event_people(event_id INTEGER,person_id INTEGER);
  CREATE TABLE event_exceptions(event_id INTEGER,occurrence_date TEXT);
`
const namePattern=/^[a-z][a-z0-9_]{0,127}$/
const checksum=s=>createHash('sha256').update(s).digest('hex')
function refuse(message) {
  throw new Error('Phase 1 disposable trigger repair refused: '+message)
}
function referenceTriggerSql() {
  const db=new DatabaseSync(':memory:')
  try {
    db.exec(TEMPLATE)
    installNotificationMutationCapture(db)
    const rows=db.prepare(
      "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"
    ).all()
    const check=comparePrivatePhase1SourceTriggerDefinitions(rows,rows)
    if(rows.length!==14||check.exactSourceMatches!==14 ||
       check.eventInsertDriftClassification!=='EXACT_CURRENT_DEFINITION') {
      refuse('source reference trigger installer has changed.')
    }
    const current=rows.find(x=>x.name==='notify_event_insert')
    if(!current||current.tbl_name!=='events'||
       !current.sql.includes(
         'DELETE FROM notification_deleted_event_details WHERE event_id=NEW.id;\n'
       )) {
      refuse('trusted new event ID reuse cleanup is absent.')
    }
    return current.sql
  } finally {db.close()}
}
function verifyOnlySyntheticMemory(db) {
  if(!(db instanceof DatabaseSync))refuse('SQLite DatabaseSync handle required.')
  const databases=db.prepare('PRAGMA database_list').all()
  if(databases.length!==1||databases[0].name!=='main'||
     databases[0].file!==''||db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1) {
    refuse('an isolated :memory: database with foreign key checks required.')
  }
  const marker=db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='phase1_disposable_repair_marker'"
  ).get()
  if(!marker)refuse('synthetic-only fixture marker table missing.')
  const markerRows=db.prepare(
    'SELECT purpose FROM phase1_disposable_repair_marker'
  ).all()
  if(markerRows.length!==1||markerRows[0].purpose!==MARKER) {
    refuse('explicit synthetic marker invalid.')
  }
  if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||
     db.prepare('PRAGMA foreign_key_check').all().length) {
    refuse('synthetic input is not a consistent SQLite database.')
  }
}
function triggerRows(db) {
  return db.prepare(
    "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"
  ).all()
}
function protectedSchemaObjects(db) {
  return db.prepare([
    'SELECT type,name,tbl_name,sql FROM sqlite_master',
    "WHERE type IN ('index','trigger','view')",
    'ORDER BY type,name',
  ].join(' ')).all()
}
function safeRowCell(v) {
  if(v===null)return ['null']
  if(typeof v==='string')return ['text',v]
  if(typeof v==='number')return ['number',v]
  if(typeof v==='bigint')return ['bigint',v.toString()]
  if(v instanceof Uint8Array)return ['blob',Buffer.from(v).toString('hex')]
  refuse('unsupported synthetic SQLite cell type.')
}
function rowFingerprints(db) {
  const tables=db.prepare([
    "SELECT name,sql FROM sqlite_master WHERE type='table'",
    "AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ].join(' ')).all()
  if(tables.length<6||tables.length>64)refuse('unexpected fixture table roster.')
  const digest=createHash('sha256')
  let total=0
  for(const table of tables) {
    if(!namePattern.test(table.name)||
       typeof table.sql!=='string'||
       /WITHOUT\s+ROWID/i.test(table.sql)) {
      refuse('unreviewed synthetic fixture table structure.')
    }
    digest.update(JSON.stringify([table.name,table.sql])+'\n')
    for(const row of db.prepare('SELECT * FROM "'+table.name+'" ORDER BY rowid').iterate()) {
      if(++total>100000)refuse('disposable fixture exceeds bounded row count.')
      digest.update(JSON.stringify(
        Object.entries(row).map(([key,value])=>[key,safeRowCell(value)])
      )+'\n')
    }
  }
  return Object.freeze({tableCount:tables.length,rowCount:total,
    sha256:digest.digest('hex')})
}
/**
 * Tests only on a synthetic memory database. The optional failure injection
 * exists solely to verify transactional rollback in disposable unit tests.
 * Even a passing receipt is NOT approval to modify any real SQLite file.
 */
export function rehearsePrivatePhase1EventInsertTriggerRepair(db,{
  injectSyntheticFailureAfterDrop=false,
}={}) {
  verifyOnlySyntheticMemory(db)
  if(typeof injectSyntheticFailureAfterDrop!=='boolean')refuse('invalid fixture test control.')
  const sourceSql=referenceTriggerSql()
  const before=comparePrivatePhase1SourceTriggerDefinitions(triggerRows(db))
  if(before.exactSourceMatches!==13||before.knownDefinitionDrift!==1||
     before.missingKnownSource!==0||before.archivedTriggersWithoutCurrentSourceDefinition!==0||
     before.eventInsertDriftClassification!=='EXACT_PRE_REUSE_CLEANUP_DEFINITION') {
    refuse('only the uniquely attested old event-insert definition may be rehearsed.')
  }
  const rowsBefore=rowFingerprints(db)
  const protectedBefore=protectedSchemaObjects(db)
  let began=false
  try {
    db.exec('BEGIN IMMEDIATE');began=true
    db.exec('DROP TRIGGER notify_event_insert')
    if(injectSyntheticFailureAfterDrop)refuse('synthetic failure after trigger drop.')
    db.exec(sourceSql)
    const after=comparePrivatePhase1SourceTriggerDefinitions(triggerRows(db))
    if(after.exactSourceMatches!==14||after.knownDefinitionDrift!==0||
       after.eventInsertDriftClassification!=='EXACT_CURRENT_DEFINITION'||
       after.archivedTriggersWithoutCurrentSourceDefinition!==0) {
      refuse('post-rehearsal trigger roster is not an exact trusted 14/14 match.')
    }
    const current=protectedSchemaObjects(db)
    if(JSON.stringify(current.map(x=>[x.type,x.name,x.tbl_name]))!==
       JSON.stringify(protectedBefore.map(x=>[x.type,x.name,x.tbl_name]))) {
      refuse('unrelated indexes, views or triggers changed during rehearsal.')
    }
    for(let i=0;i<current.length;i++) {
      if(current[i].name!=='notify_event_insert' &&
         JSON.stringify(current[i])!==JSON.stringify(protectedBefore[i])) {
        refuse('unrelated SQL schema definition changed.')
      }
    }
    const rowsAfter=rowFingerprints(db)
    if(JSON.stringify(rowsBefore)!==JSON.stringify(rowsAfter)||
       db.prepare('PRAGMA foreign_key_check').all().length||
       db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok') {
      refuse('synthetic source row content or constraints changed.')
    }
    db.exec('COMMIT');began=false
    return Object.freeze({
      kind:'phase1-disposable-event-insert-trigger-repair-rehearsal-v1',
      onlySyntheticMemoryDatabase:true,
      originalLegacyTriggerMatchedExactly:true,
      targetedTrigger:'notify_event_insert',
      originalExactSourceMatches:13,
      postRepairExactSourceMatches:14,
      otherThirteenDefinitionsUnchanged:true,
      allStoredRowValuesUnchanged:true,
      syntheticTableCount:rowsAfter.tableCount,
      syntheticRowCount:rowsAfter.rowCount,
      indexesAndViewsUnchanged:true,
      legacyArchiveOpened:false,
      realInstalledTestOrLiveOpened:false,
      realDatabaseFileModified:false,
      realTriggerReplayAuthorized:false,
      actualTestMigrationExecuted:false,
      backupAuthorized:false,rollbackAuthorized:false,
      testDeploymentAuthorized:false,liveDeploymentAuthorized:false,
    })
  } catch(error) {
    if(began) {
      try {db.exec('ROLLBACK')}
      catch {refuse('synthetic transaction rollback failed.')}
    }
    // Avoid exporting raw database or trigger error messages from test fixtures.
    refuse('transaction rolled back without any approved real database changes.')
  }
}
