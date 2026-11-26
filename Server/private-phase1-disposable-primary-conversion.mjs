// DISPOSABLE synthetic-only Phase 1 offline primary-family conversion rehearsal.
// The saved Nov 22 TEST recovery archive is NOT an accepted input: only
// disposable, explicitly marked OS-temp fixtures. No installed LIVE/TEST,
// scheduled tasks, routes, real household identities or active sessions.
// This IS a real transformation of synthetic fixture BYTES, not an authorized
// migration path for anyone's actual calendar or credentials.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { comparePrivatePhase1SourceTriggerDefinitions } from './private-phase1-archive-trigger-source-parity.mjs'
import { createHouseholdMembershipTables } from './household-memberships.mjs'
import { installPrivateEventIdentity } from './private-event-identity.mjs'
import { reconcileNotificationMutations } from './notification-event-mutation-capture.mjs'
import { listPrivatePhase1LegacyDispositionRules } from './private-phase1-legacy-table-disposition-review.mjs'

const MARKER='.phase1-disposable-legacy-fixture.json'
const HOUSEHOLD='primary-family'
const MAX_RECORDS=250000
const MAX_FILES=20000
const RETAIN=new Set(['household-data-preserve','household-notice-reconciliation'])
const STRIP=new Set([
  'family_sessions','family_users','test_push_deliveries',
  'test_push_subscriptions','capture_inbox',
])

// STRICT source-only synthetic harness allowlist. These are three invented,
// controlled regression triggers, NOT the 14 real archived TEST triggers.
// The separate source-generated synthetic fixture mode below verifies all
// fourteen current installer definitions, never a caller-provided allowlist.
// No real archive, old trigger repair or archived SQL replay is allowed.
// SQLite stores CREATE TRIGGER SQL in sqlite_schema.sql; exact matching
// prevents accepting an unreviewed trigger body, even if names match.
const SYNTHETIC_TRIGGER_SQL=Object.freeze([
  "CREATE TRIGGER phase1_fixture_event_change AFTER UPDATE OF title ON events BEGIN INSERT OR REPLACE INTO notification_dirty_events(id,value) VALUES (NEW.id,'event-updated'); END",
  "CREATE TRIGGER phase1_fixture_person_assignment AFTER INSERT ON event_people BEGIN INSERT OR REPLACE INTO notification_dirty_event_fields(id,value) VALUES (NEW.event_id,'people-changed'); END",
  "CREATE TRIGGER phase1_fixture_exception_change AFTER INSERT ON event_exceptions BEGIN INSERT OR REPLACE INTO notification_dirty_event_attribution(id,value) VALUES (NEW.event_id,'exception-changed'); END",
])
export function listPhase1ApprovedSyntheticFixtureTriggerSql() {
  return SYNTHETIC_TRIGGER_SQL
}
function trustedSyntheticTriggers(db,sourceGenerated=false) {
  const entries=db.prepare(
    "SELECT name,tbl_name,sql,type FROM sqlite_master WHERE type IN ('view','trigger')"
  ).all()
  if(entries.some(row=>row.type==='view')) {
    refuse('unreviewed view cannot be migrated in synthetic rehearsal.')
  }
  if(sourceGenerated) {
    const comparison=comparePrivatePhase1SourceTriggerDefinitions(entries)
    if(comparison.exactSourceMatches!==14||comparison.knownDefinitionDrift!==0||
       comparison.missingKnownSource!==0||comparison.archivedTriggersWithoutCurrentSourceDefinition!==0||
       comparison.eventInsertDriftClassification!=='EXACT_CURRENT_DEFINITION') {
      refuse('source-generated synthetic fixture requires all 14 exact current definitions.')
    }
    return 14
  }
  const seen=new Set()
  for(const row of entries) {
    if(row.type!=='trigger' || typeof row.sql!=='string' ||
       !SYNTHETIC_TRIGGER_SQL.includes(row.sql) || seen.has(row.sql) ||
       !RETAIN.has(listPrivatePhase1LegacyDispositionRules()
         .find(rule=>rule.table===row.tbl_name)?.disposition)) {
      refuse('unreviewed trigger on synthetic source; no real trigger bodies authorized.')
    }
    seen.add(row.sql)
  }
  return seen.size
}
function preservedSchemaObjectFingerprints(db) {
  const retained=new Set(listPrivatePhase1LegacyDispositionRules()
    .filter(rule=>RETAIN.has(rule.disposition)).map(rule=>rule.table))
  return db.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('index','trigger')"
  ).all()
    .filter(row=>retained.has(row.tbl_name))
    .map(row=>createHash('sha256').update(JSON.stringify([
      row.type,row.name,row.tbl_name,row.sql,
    ])).digest('hex')).sort()
}

function refuse(reason) { throw new Error('Disposable primary-family conversion refused: '+reason) }
function inside(parent,child) {
  const relative=path.relative(parent,child)
  return relative!=='' && relative!=='..' &&
    !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative)
}
function ordinaryDir(full) {
  const stat=fs.lstatSync(full)
  if(!stat.isDirectory()||stat.isSymbolicLink())refuse('non-physical input folder.')
  return fs.realpathSync(full)
}
function paths(sourceRoot,destinationRoot,serverDirectory) {
  if(![sourceRoot,destinationRoot,serverDirectory].every(
    p=>typeof p==='string'&&path.isAbsolute(p))) {
    refuse('absolute source, fresh output and source checkout required.')
  }
  const temp=ordinaryDir(os.tmpdir())
  const src=ordinaryDir(sourceRoot)
  const out=path.resolve(destinationRoot)
  const checkout=path.dirname(fs.realpathSync(serverDirectory))
  if(path.dirname(src)!==temp ||
     !/^fc-phase1-disposable-legacy-[a-z0-9-]+$/.test(path.basename(src)) ||
     path.dirname(out)!==temp ||
     !/^fc-phase1-disposable-converted-[a-z0-9-]+$/.test(path.basename(out)) ||
     inside(checkout,src)||inside(checkout,out)||
     inside(src,checkout)||inside(out,checkout)||
     src===out||fs.existsSync(out)) {
    refuse('only independent fresh disposable OS-temp roots outside checkout.')
  }
  const required=[MARKER,'data','uploads'].sort()
  if(JSON.stringify(fs.readdirSync(src).sort())!==JSON.stringify(required) ||
     JSON.stringify(fs.readdirSync(path.join(src,'data')).sort())!==
       JSON.stringify(['calendar.db'])) {
    refuse('fixture has unexpected files, SQLite WAL or missing upload folder.')
  }
  const markerPath=path.join(src,MARKER)
  if(!fs.lstatSync(markerPath).isFile() ||
      fs.lstatSync(markerPath).isSymbolicLink()) {
    refuse('fixture marker must be an ordinary file.')
  }
  let marker
  try { marker=JSON.parse(fs.readFileSync(markerPath,'utf8')) }
  catch { refuse('fixture marker is unreadable.') }
  if(marker?.kind!=='phase1-disposable-synthetic-legacy-only'||
     marker?.version!==1||marker?.realCalendarDataAllowed!==false) {
    refuse('explicit synthetic-only input marker required.')
  }
  const dbFile=path.join(src,'data','calendar.db')
  if(!fs.lstatSync(dbFile).isFile()||fs.lstatSync(dbFile).isSymbolicLink()){
    refuse('fixture SQLite must be a physical file.')
  }
  if(marker.notificationSchema!==undefined&&marker.notificationSchema!=='source-generated-v1') {
    refuse('unrecognized synthetic notification schema marker.')
  }
  return {src,out,dbFile,sourceGenerated:marker.notificationSchema==='source-generated-v1'}
}
function digest(filename) {
  const sha=createHash('sha256'),file=fs.openSync(filename,'r')
  const buf=Buffer.allocUnsafe(1024*1024)
  try {for(;;){const n=fs.readSync(file,buf,0,buf.length,null);if(!n)break;sha.update(buf.subarray(0,n))}}
  finally{fs.closeSync(file)}
  return sha.digest('hex')
}
function scanUploads(root) {
  const result=[]
  function visit(folder,rel,depth) {
    if(depth>24)refuse('unbounded upload nesting.')
    const stat=fs.lstatSync(folder)
    if(!stat.isDirectory()||stat.isSymbolicLink())refuse('linked or invalid upload folder.')
    for(const item of fs.readdirSync(folder,{withFileTypes:true})) {
      if(item.name==='.'||item.name==='..')refuse('invalid upload entry.')
      const next=path.join(folder,item.name)
      const relative=rel?rel+'/'+item.name:item.name
      if(item.isDirectory())visit(next,relative,depth+1)
      else if(item.isFile()&&!item.isSymbolicLink()) {
        if(!inside(root,fs.realpathSync(next)))refuse('upload escapes root.')
        result.push({relative,sha256:digest(next)})
      } else refuse('upload links or unexpected file types forbidden.')
      if(result.length>MAX_FILES)refuse('excessive synthetic uploaded files.')
    }
  }
  visit(root,'',0)
  return result.sort((a,b)=>a.relative.localeCompare(b.relative))
}
function copyUploads(source,dest,files) {
  // Preserve directory structure, including empty folders, without following
  // symlinks. A hash inventory detects modifications during source copy.
  function walk(from,to,depth) {
    if(depth>24)refuse('unbounded upload nesting.')
    fs.mkdirSync(to,{recursive:false})
    for(const item of fs.readdirSync(from,{withFileTypes:true})) {
      const input=path.join(from,item.name),target=path.join(to,item.name)
      if(item.isDirectory()&&!item.isSymbolicLink())walk(input,target,depth+1)
      else if(item.isFile()&&!item.isSymbolicLink())
        fs.copyFileSync(input,target,fs.constants.COPYFILE_EXCL)
      else refuse('unsafe upload entry during copy.')
    }
  }
  walk(source,dest,0)
  const after=scanUploads(dest)
  if(JSON.stringify(after)!==JSON.stringify(files) ||
     JSON.stringify(scanUploads(source))!==JSON.stringify(files)) {
    refuse('uploaded file inventory changed while copying.')
  }
}
function check(db) {
  const result=db.prepare('PRAGMA integrity_check').get()?.integrity_check
  if(result!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length) {
    refuse('offline SQLite integrity or foreign keys failed.')
  }
}
function tableNames(db,sourceGenerated) {
  const actual=db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(x=>x.name)
  const expected=listPrivatePhase1LegacyDispositionRules().map(x=>x.table).sort()
  if(JSON.stringify(actual)!==JSON.stringify(expected)) {
    refuse('unexpected, missing, or renamed archived table.')
  }
  trustedSyntheticTriggers(db,sourceGenerated)
  return actual
}
function q(name) {
  if(!/^[a-z][a-z0-9_]*$/.test(name))refuse('unsafe table name.')
  return '"'+name+'"'
}
function snapshot(db,table) {
  const cols=db.prepare('PRAGMA table_info('+q(table)+')').all().map(x=>x.name)
  if(!cols.length)refuse('table has no explicit columns.')
  const schema=db.prepare(
    'SELECT sql FROM sqlite_master WHERE type=? AND name=?'
  ).get('table',table)?.sql
  if(typeof schema!=='string')refuse('missing table schema.')
  const sha=createHash('sha256')
  let rows=0
  for(const row of db.prepare('SELECT * FROM '+q(table)).iterate()) {
    if(++rows>MAX_RECORDS)refuse('table exceeds disposable comparison limit.')
    const cells=cols.map(name=>{
      const v=row[name]
      if(v===null)return ['null']
      if(typeof v==='bigint')return ['bigint',v.toString()]
      if(typeof v==='number')return ['number',v]
      if(typeof v==='string')return ['text',v]
      if(v instanceof Uint8Array)return ['blob',Buffer.from(v).toString('hex')]
      refuse('unsupported database cell type.')
    })
    sha.update(JSON.stringify(cells)+'\n')
  }
  return {schema,columns:cols.join('\u0000'),rows,sha256:sha.digest('hex')}
}
// Notification outbox intentionally can refer to an event/Person that has
// since been deleted. Such records must remain byte-for-byte intact, even
// though a conventional FK cleanup or auto-join would erase history.
// These counts are only gathered from explicitly synthetic disposable DBs.
function historicalNoticeIntegrity(db) {
  const outboxColumns=new Set(db.prepare(
    'PRAGMA table_info("assignment_notification_outbox")'
  ).all().map(c=>c.name))
  const ackColumns=new Set(db.prepare(
    'PRAGMA table_info("test_assignment_acknowledgements")'
  ).all().map(c=>c.name))
  if(['id','event_id','person_id'].some(c=>!outboxColumns.has(c)) ||
     !ackColumns.has('notification_id')) {
    refuse('synthetic notification tables lack reviewed reference columns.')
  }
  const outbox=db.prepare([
    'SELECT COUNT(*) AS n,',
    'COUNT(CASE WHEN o.event_id IS NOT NULL AND NOT EXISTS',
    '(SELECT 1 FROM events e WHERE e.id=o.event_id) THEN 1 END) AS missingEvents,',
    'COUNT(CASE WHEN o.person_id IS NOT NULL AND NOT EXISTS',
    '(SELECT 1 FROM people p WHERE p.id=o.person_id) THEN 1 END) AS missingPeople',
    'FROM assignment_notification_outbox o',
  ].join(' ')).get()
  const ack=db.prepare([
    'SELECT COUNT(*) AS n,',
    'COUNT(CASE WHEN a.notification_id IS NOT NULL AND NOT EXISTS',
    '(SELECT 1 FROM assignment_notification_outbox o',
    'WHERE o.id=a.notification_id) THEN 1 END) AS missingOutbox',
    'FROM test_assignment_acknowledgements a',
  ].join(' ')).get()
  for(const n of [outbox.n,outbox.missingEvents,outbox.missingPeople,
    ack.n,ack.missingOutbox]) {
    if(!Number.isSafeInteger(n)||n<0||n>MAX_RECORDS) {
      refuse('synthetic historical notice counts are invalid.')
    }
  }
  return Object.freeze({
    outboxRows:outbox.n,
    unmatchedEventReferences:outbox.missingEvents,
    unmatchedPersonReferences:outbox.missingPeople,
    acknowledgementRows:ack.n,
    unmatchedAcknowledgementOutbox:ack.missingOutbox,
  })
}

function requireNoCrossBoundaryFks(db) {
  for(const rule of listPrivatePhase1LegacyDispositionRules()) {
    if(!RETAIN.has(rule.disposition))continue
    const foreign=db.prepare('PRAGMA foreign_key_list('+q(rule.table)+')').all()
    if(foreign.some(x=>STRIP.has(x.table))) {
      refuse('household table references central account or quarantined device data.')
    }
  }
}
function readLegacyOwner(db) {
  const required=['id','username','display_name','password_hash','account_kind','disabled']
  const cols=new Set(db.prepare('PRAGMA table_info("family_users")').all().map(x=>x.name))
  if(required.some(c=>!cols.has(c)))refuse('unreviewed legacy Owner account schema.')
  const accounts=db.prepare('SELECT * FROM family_users').all()
  if(accounts.length!==1)refuse('exactly one legacy family account required.')
  const owner=accounts[0]
  if(!Number.isSafeInteger(owner.id)||owner.id<1||
     typeof owner.username!=='string'||!/^[a-zA-Z0-9._-]{3,40}$/.test(owner.username)||
     typeof owner.display_name!=='string'||owner.display_name.length<1||
     typeof owner.password_hash!=='string'||
     !/^scrypt-v1:[a-f0-9]{32}:[a-f0-9]{128}$/.test(owner.password_hash)||
     owner.account_kind!=='person'||owner.disabled!==0) {
    refuse('single supported, enabled legacy Owner account needed for synthetic rehearsal.')
  }
  return owner
}
function centralIdentity(file,owner) {
  const db=new DatabaseSync(file)
  try {
    db.exec('PRAGMA foreign_keys=ON')
    createHouseholdMembershipTables(db)
    db.prepare([
      'INSERT INTO family_users',
      '(id,username,display_name,password_hash,account_kind,disabled)',
      'VALUES(?,?,?,?,?,1)',
    ].join(' ')).run(owner.id,owner.username,owner.display_name,
      owner.password_hash,'person')
    db.prepare([
      'INSERT INTO household_registry',
      '(storage_id,display_name,disabled) VALUES(?,?,1)',
    ].join(' ')).run(HOUSEHOLD,'Synthetic Primary Family - inactive')
    const householdId=db.prepare(
      'SELECT id FROM household_registry WHERE storage_id=?'
    ).get(HOUSEHOLD).id
    db.prepare([
      'INSERT INTO household_memberships',
      '(user_id,household_id,role,disabled) VALUES(?,?,?,1)',
    ].join(' ')).run(owner.id,householdId,'owner')
    check(db)
    const sessions=db.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n
    const user=db.prepare('SELECT disabled FROM family_users').get()
    if(sessions!==0||user.disabled!==1)refuse('staged central login was accidentally activated.')
  } finally {db.close()}
}
function scrubHousehold(file,originals,originalSchemaObjects,originalHistoricalNotices,sourceGenerated) {
  const db=new DatabaseSync(file)
  try {
    // Only on the fresh synthetic output database; original never altered.
    // Scrub deleted identity/session/device data from the disposable copy,
    // not just its logical table roster. Never change the source fixture.
    db.exec('PRAGMA secure_delete=ON')
    db.exec('PRAGMA foreign_keys=OFF')
    db.exec('BEGIN IMMEDIATE')
    try {
      for(const table of ['family_sessions','family_users',
        'test_push_deliveries','test_push_subscriptions','capture_inbox']) {
        db.exec('DROP TABLE '+q(table))
      }
      db.exec('COMMIT')
    } catch(error) {db.exec('ROLLBACK');throw error}
    db.exec('PRAGMA foreign_keys=ON')
    db.exec('VACUUM')
    if(db.prepare('PRAGMA freelist_count').get().freelist_count!==0) {
      refuse('disposable household database still contains free pages.')
    }
    check(db)
    const actual=db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all().map(x=>x.name).sort()
    if(JSON.stringify(actual)!==JSON.stringify([...originals.keys()].sort())) {
      refuse('synthetic household output contains an unexpected table.')
    }
    for(const [name,expected] of originals) {
      if(JSON.stringify(snapshot(db,name))!==JSON.stringify(expected)) {
        refuse('a household, notification, or invitation row changed during split.')
      }
    }
    if(JSON.stringify(preservedSchemaObjectFingerprints(db)) !==
       JSON.stringify(originalSchemaObjects)) {
      refuse('a retained trigger/index changed or disappeared during synthetic split.')
    }
    trustedSyntheticTriggers(db,sourceGenerated)
    if(JSON.stringify(historicalNoticeIntegrity(db)) !==
       JSON.stringify(originalHistoricalNotices)) {
      refuse('deleted-event or missing-Person notice history changed during synthetic split.')
    }
    return {preservedTables:originals.size,
      preservedRows:[...originals.values()].reduce((n,x)=>n+x.rows,0)}
  } finally {db.close()}
}
// Runs only inside the guarded fresh disposable output, after the exact
// legacy split has been verified. Any failure discards that entire output.
function prepareDisposableEventIdentityAndNotices(file) {
  const db=new DatabaseSync(file)
  try {
    db.exec('PRAGMA foreign_keys=ON')
    const count=table=>db.prepare('SELECT COUNT(*) AS n FROM '+q(table)).get().n
    const transient=['notification_dirty_event_fields','notification_dirty_event_attribution','notification_deleted_event_details']
    function requireLinkedTransientRows() {
      for(const table of transient) {
        if(db.prepare('SELECT 1 FROM '+q(table)+' t WHERE NOT EXISTS (SELECT 1 FROM notification_dirty_events d WHERE d.event_id=t.event_id) LIMIT 1').get()) {
          refuse('unlinked notification transient state needs review.')
        }
      }
    }
    function drain(at) {
      const initial=count('notification_dirty_events')
      if(initial>MAX_RECORDS)refuse('notification work exceeds disposable limit.')
      let processed=0,queued=0
      while(processed<initial) {
        const r=reconcileNotificationMutations(db,{limit:1000,at})
        if(r.processed<1||processed+r.processed>initial||
           r.remaining!==initial-processed-r.processed)refuse('unexpected notification queue drift.')
        processed+=r.processed
        queued+=r.queued
        if(queued>MAX_RECORDS)refuse('notification intent count exceeds disposable limit.')
      }
      if(count('notification_dirty_events')!==0||transient.some(table=>count(table)!==0)) {
        refuse('notification reconciliation left transient rows.')
      }
      return {processed,queued}
    }
    function outboxPrefix(maxId) {
      const sha=createHash('sha256')
      for(const row of db.prepare('SELECT * FROM assignment_notification_outbox WHERE id<=? ORDER BY id').iterate(maxId)) {
        sha.update(JSON.stringify(row)+'\n')
      }
      return sha.digest('hex')
    }
    requireLinkedTransientRows()
    const originalCount=count('assignment_notification_outbox')
    const maxId=db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM assignment_notification_outbox').get().n
    const originalHistory=outboxPrefix(maxId)
    const acks=JSON.stringify(snapshot(db,'test_assignment_acknowledgements'))
    const at=Date.now()
    // Preserve exact actor attribution before a UID-only SQL UPDATE advances
    // the dirty revision. No push transport or browser access is involved.
    const prior=drain(at)
    if(count('assignment_notification_outbox')!==originalCount+prior.queued||
       outboxPrefix(maxId)!==originalHistory||
       JSON.stringify(snapshot(db,'test_assignment_acknowledgements'))!==acks) {
      refuse('historical notification or acknowledgement changed.')
    }
    const baseline=JSON.stringify(snapshot(db,'notification_event_baselines'))
    const allNotices=JSON.stringify(snapshot(db,'assignment_notification_outbox'))
    installPrivateEventIdentity(db)
    const uidOnly=drain(at)
    if(uidOnly.queued!==0||
       JSON.stringify(snapshot(db,'assignment_notification_outbox'))!==allNotices||
       JSON.stringify(snapshot(db,'notification_event_baselines'))!==baseline||
       JSON.stringify(snapshot(db,'test_assignment_acknowledgements'))!==acks) {
      refuse('UID-only backfill changed notification history or material baselines.')
    }
    if(db.prepare('SELECT 1 FROM events WHERE event_uid IS NULL LIMIT 1').get()) {
      refuse('event identity backfill incomplete.')
    }
    check(db)
    return Object.freeze({legacyDirtyEventsProcessed:prior.processed,
      legitimateLegacyIntentsQueued:prior.queued,uidDirtyEventsProcessed:uidOnly.processed,
      uidOnlyIntentsQueued:0,historyAndAcknowledgementsPreserved:true,
      pendingMutationQueueDrained:true,pushTransmitted:false})
  }finally{db.close()}
}

// Shared reconciliation for a previously verified offline archive split.
// Only the internal rehearsal's fresh temporary copy is accepted here;
// never point it at the recovery archive or installed TEST/LIVE.
export function preparePhase1OfflineArchiveCopyNotices(workRoot) {
  const temp=fs.realpathSync(os.tmpdir())
  const work=ordinaryDir(workRoot)
  if(path.dirname(work)!==temp||!/^fc-phase1-offline-rehearsal-[a-zA-Z0-9]+$/.test(path.basename(work))) {
    refuse('verified offline rehearsal temporary root required.')
  }
  const file=path.join(work,'calendar.db')
  const stat=fs.lstatSync(file)
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||fs.realpathSync(file)!==file||
     ['-wal','-shm','-journal'].some(s=>fs.existsSync(file+s))) {
    refuse('standalone physical offline archive copy required.')
  }
  const db=new DatabaseSync(file,{readOnly:true})
  try{
    check(db)
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name)
    const expected=listPrivatePhase1LegacyDispositionRules().filter(x=>RETAIN.has(x.disposition)).map(x=>x.table).sort()
    if(JSON.stringify(names)!==JSON.stringify(expected))refuse('exact split household table roster required.')
    trustedSyntheticTriggers(db,true)
  }finally{db.close()}
  return prepareDisposableEventIdentityAndNotices(file)
}

/**
 * Does NOT accept the real cold backup path. The destination is an isolated
 * OS-temp rehearsal, not a service data root. Neither output is bootable.
 * Saved old sessions and device push endpoints remain ONLY in the unchanged
 * disposable source; disabled central Owner is not authorized to log in.
 */
export function stageDisposablePhase1PrimaryFamily({
  serverDirectory,sourceRoot,destinationRoot,prepareEventIdentityAndNotices=false,
}={}) {
  const {src,out,dbFile,sourceGenerated}=paths(sourceRoot,destinationRoot,serverDirectory)
  if(typeof prepareEventIdentityAndNotices!=='boolean'||(prepareEventIdentityAndNotices&&!sourceGenerated)) {
    refuse('event identity preparation requires explicit source-shaped synthetic fixture.')
  }
  const sourceBefore=digest(dbFile)
  const uploadsBefore=scanUploads(path.join(src,'uploads'))
  const original=new DatabaseSync(dbFile,{readOnly:true})
  const preserved=new Map()
  let owner,retainedRows=0,originalSchemaObjects,approvedFixtureTriggers,originalHistoricalNotices
  try {
    original.exec('PRAGMA query_only=ON')
    check(original)
    tableNames(original,sourceGenerated)
    approvedFixtureTriggers=trustedSyntheticTriggers(original,sourceGenerated)
    originalSchemaObjects=preservedSchemaObjectFingerprints(original)
    requireNoCrossBoundaryFks(original)
    owner=readLegacyOwner(original)
    originalHistoricalNotices=historicalNoticeIntegrity(original)
    for(const rule of listPrivatePhase1LegacyDispositionRules()) {
      const value=snapshot(original,rule.table)
      if(RETAIN.has(rule.disposition)) {
        preserved.set(rule.table,value);retainedRows+=value.rows
      } else if(rule.table==='capture_inbox'&&value.rows!==0) {
        refuse('retired capture Inbox has unexpected data.')
      }
    }
    if(preserved.size!==22)refuse('not all 22 family/notification tables were preserved.')
  } finally {original.close()}
  let created=false
  try {
    fs.mkdirSync(out,{recursive:false,mode:0o700});created=true
    const centralDir=path.join(out,'central')
    const home=path.join(out,'households',HOUSEHOLD)
    const familyData=path.join(home,'data')
    fs.mkdirSync(centralDir)
    fs.mkdirSync(path.join(out,'households'))
    fs.mkdirSync(home)
    fs.mkdirSync(familyData)
    const destDb=path.join(familyData,'calendar.db')
    fs.copyFileSync(dbFile,destDb,fs.constants.COPYFILE_EXCL)
    const split=scrubHousehold(destDb,preserved,originalSchemaObjects,originalHistoricalNotices,sourceGenerated)
    const noticePreparation=prepareEventIdentityAndNotices?prepareDisposableEventIdentityAndNotices(destDb):null
    const centralDb=path.join(centralDir,'identity.db')
    centralIdentity(centralDb,owner)
    copyUploads(path.join(src,'uploads'),path.join(home,'uploads'),uploadsBefore)
    fs.writeFileSync(path.join(home,'.family-calendar-household.json'),
      JSON.stringify({schemaVersion:1,householdId:HOUSEHOLD})+'\n',
      {flag:'wx',mode:0o600})
    if(digest(dbFile)!==sourceBefore ||
       JSON.stringify(scanUploads(path.join(src,'uploads'))) !==
       JSON.stringify(uploadsBefore)) {
      refuse('source synthetic database or uploads changed during rehearsal.')
    }
    return Object.freeze({
      kind:'phase1-disposable-primary-family-split-rehearsal-v1',
      sourceFixtureOnly:true,
      sourceBytesUnchanged:true,
      preservedHouseholdAndNoticeTables:split.preservedTables,
      preservedHouseholdAndNoticeRows:retainedRows,
      copiedUploadFiles:uploadsBefore.length,
      eventIdentityAndNoticePreparation:noticePreparation,
      historicalOutboxRowsPreserved:originalHistoricalNotices.outboxRows,
      orphanedEventNoticeReferencesPreserved:originalHistoricalNotices.unmatchedEventReferences,
      orphanedPersonNoticeReferencesPreserved:originalHistoricalNotices.unmatchedPersonReferences,
      historicalAcknowledgementRowsPreserved:originalHistoricalNotices.acknowledgementRows,
      historicalAcknowledgementOrphansPreserved:originalHistoricalNotices.unmatchedAcknowledgementOutbox,
      deletedEventAndPersonHistoryNeverAutoPruned:true,
      approvedSyntheticFixtureTriggersPreserved:approvedFixtureTriggers,
      sourceGeneratedCurrentNotificationTriggersPreserved:sourceGenerated?approvedFixtureTriggers:0,
      syntheticHouseholdOutputCompacted:true,
      retainedIndexAndTriggerFingerprintsEqual:true,
      realArchivedTriggerBodiesApproved:false,
      stagedOwnersDisabled:1,
      centralActiveSessions:0,
      centralSelectedHouseholds:0,
      archivedLegacySessionsNotActivated:true,
      savedPushDeviceSubscriptionsNotActivated:true,
      sourceCredentialsNotPlacedInHouseholdDatabase:true,
      centralGatewayBootProven:false,
      fullLegacySchemaCompatibilityProven:false,
      activeRealCalendarDataHandled:false,
      actualTestMigrationExecuted:false,
      automatedReactivationAllowed:false,
      backupAuthorized:false,
      rollbackAuthorized:false,
      testDeploymentAuthorized:false,
      liveDeploymentAuthorized:false,
    })
  } catch(error) {
    // Only remove an output THIS invocation exclusively created under OS
    // temp. Neither the original input nor any installed path is touched.
    if(created)fs.rmSync(out,{recursive:true,force:true})
    throw error
  }
}
