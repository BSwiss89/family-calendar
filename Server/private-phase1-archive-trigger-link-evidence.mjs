// Source-only, read-only historical TEST trigger and implicit-link review.
// Never prints raw trigger SQL, trigger names, family content, tokens or
// upload paths. This report is a migration BLOCKER, not authorization.
import path from 'node:path'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {auditPrivatePhase1OfflineLegacySchema} from './private-phase1-offline-schema-relationship-audit.mjs'

const links=[
 ['assignment_notification_outbox','event_id','events','historical'],
 ['assignment_notification_outbox','person_id','people','historical'],
 ['events','batch_id',null,'opaque-batch'],
 ['family_sessions','selected_person_id','people','quarantine'],
 ['list_items','store_id','shopping_stores','household'],
 ['notification_dirty_event_attribution','person_id','people','historical'],
 ['test_push_subscriptions','user_id','family_users','quarantine'],
 ['test_push_subscriptions','session_id','family_sessions','quarantine'],
 ['test_push_subscriptions','person_id','people','quarantine'],
 ['notification_deleted_event_details','event_id','events','historical'],
 ['notification_dirty_event_attribution','event_id','events','historical'],
 ['notification_dirty_event_fields','event_id','events','historical'],
 ['notification_dirty_events','event_id','events','historical'],
 ['notification_event_baselines','event_id','events','historical'],
 ['test_push_deliveries','notification_id','assignment_notification_outbox','quarantine'],
]
const opaque=[
 ['notification_event_baselines','person_ids_json'],
 ['assignment_notification_outbox','cancelled_details_json'],
 ['events','person'],['people','image'],['recipes','image'],
 ['recipes','source_image'],
]
const deny=message=>{throw new Error('Phase 1 archive trigger review refused: '+message)}
const quote=value=>{
 if(typeof value!=='string'||!/^[a-z][a-z0-9_]*$/.test(value))deny('unsafe identifier')
 return '"'+value+'"'
}
function reviewLinks(db,cols) {
 return links.map(([table,column,target,policy])=>{
  if(!cols.get(table)?.has(column)||(target&&!cols.get(target)?.has('id')))
   deny('source or target column is missing from reviewed archive')
  const from=quote(table),key=quote(column)
  const populated=db.prepare('SELECT COUNT(*) AS n FROM '+from+' WHERE '+key+' IS NOT NULL').get().n
  const missing=target?db.prepare('SELECT COUNT(*) AS n FROM '+from+' x WHERE x.'+key+
   ' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM '+quote(target)+' y WHERE y.id=x.'+key+')').get().n:null
  if(!Number.isSafeInteger(populated)||populated<0||
    (missing!==null&&(!Number.isSafeInteger(missing)||missing<0||missing>populated)))
    deny('invalid aggregate reference count')
  return Object.freeze({
   table,column,target,policy,nonNullReferences:populated,
   unmatchedReferences:missing,historyPreservedEvenIfUnmatched:true,
   referenceRewriteAuthorized:false,
  })
 })
}
export function inspectPrivatePhase1ArchivedTriggerLinks(args) {
 const before=auditPrivatePhase1OfflineLegacySchema(args)
 if(before.tables!==27||before.testDeploymentAuthorized!==false)
  deny('complete verified archive and 27 reviewed tables required')
 const cols=new Map(before.historicalTables.map(t=>[t.table,new Set(t.columns.map(c=>c.column))]))
 for(const [table,col] of opaque)
  if(!cols.get(table)?.has(col))deny('opaque reference field missing')
 const db=new DatabaseSync(path.join(args.snapshotRoot,'calendar.db'),{readOnly:true})
 let report
 try {
  db.exec('PRAGMA query_only=ON')
  const rows=db.prepare("SELECT tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY tbl_name,name").all()
  if(rows.length!==before.totalTriggers||rows.length>128)deny('trigger count mismatch')
  const reviewed=new Set(before.historicalTables.map(t=>t.table))
  const trig=rows.map((row,i)=>{
   if(!reviewed.has(row.tbl_name)||typeof row.sql!=='string'||row.sql.length>100000)
    deny('unreviewed trigger table or definition')
   return Object.freeze({
    ordinal:i+1,table:row.tbl_name,
    definitionSha256:createHash('sha256').update(row.sql).digest('hex'),
    semanticEffectReviewed:false,definitionApprovedForReplay:false,
   })
  })
  const expected=trig.length===14&&
   trig.filter(x=>x.table==='events').length===5&&
   trig.filter(x=>x.table==='event_people').length===3&&
   trig.filter(x=>x.table==='event_exceptions').length===6
  const aggregate=reviewLinks(db,cols)
  report=Object.freeze({
   kind:'phase1-readonly-archived-trigger-link-evidence-v1',
   verifiedHistoricalArchive:true,archiveSchemaSha256:before.schemaSha256,
   triggersObserved:trig.length,expectedHistoricalTriggerLayout:expected,
   triggerFingerprints:Object.freeze(trig),
   nineUnlinkedIdentifierHintsExplicitlyMapped:9,
   otherImplicitOrQuarantinedLinksMapped:aggregate.length-9,
   aggregateReferenceReview:Object.freeze(aggregate),
   opaqueFieldsRequireManualReview:Object.freeze(opaque.map(x=>Object.freeze({table:x[0],column:x[1]}))),
   rawTriggerSqlOrNamesExposed:false,rawCalendarOrAccountRowsExposed:false,
   allTriggerSemanticsApproved:false,allIdentifierLinksApproved:false,
   originalArchiveModified:false,installedCalendarsModified:false,
   realMigrationExecuted:false,backupAuthorized:false,rollbackAuthorized:false,
   testDeploymentAuthorized:false,liveDeploymentAuthorized:false,
  })
 } finally {db.close()}
 const after=auditPrivatePhase1OfflineLegacySchema(args)
 if(after.schemaSha256!==before.schemaSha256||after.totalTriggers!==before.totalTriggers||
    after.totalIndexes!==before.totalIndexes)deny('archive changed while checking trigger/link evidence')
 return report
}
