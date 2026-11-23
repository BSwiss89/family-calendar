// Archive mapping policy tests. All row counts below are synthetic metadata
// fixtures matching the owner's read-only, independently verified historical
// Nov 22 TEST inventory. No installed or saved SQLite is opened in these tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewPrivatePhase1LegacyTableDispositions as review }
  from '../Server/private-phase1-legacy-table-disposition-review.mjs'

const SHA='76caa3e46186c3c5c6408f11b55800eb06779776'
const CENTRAL='central-candidate'
const HOUSE='household-candidate'
const UNKNOWN='needs-explicit-mapping'
// [name, row count, old inventory class, FK->central, FK->household, FK not classified]
const OBSERVED=[
  ['assignment_notification_outbox',31,UNKNOWN,0,0,0],
  ['capture_inbox',0,UNKNOWN,0,0,0],
  ['daily_notes',1,HOUSE,0,0,0],
  ['emoji_marker_exceptions',0,UNKNOWN,0,0,1],
  ['emoji_markers',1,UNKNOWN,0,0,0],
  ['event_exceptions',1,UNKNOWN,0,1,0],
  ['event_people',43,HOUSE,0,2,0],
  ['events',46,HOUSE,0,0,0],
  ['family_sessions',21,CENTRAL,1,0,0],
  ['family_users',1,CENTRAL,0,0,0],
  ['list_items',23,HOUSE,0,1,0],
  ['lists',2,HOUSE,0,0,0],
  ['meal_plan_items',32,UNKNOWN,0,1,0],
  ['meal_plans',3,UNKNOWN,0,0,0],
  ['notification_deleted_event_details',0,UNKNOWN,0,0,0],
  ['notification_dirty_event_attribution',0,UNKNOWN,0,0,0],
  ['notification_dirty_event_fields',0,UNKNOWN,0,0,0],
  ['notification_dirty_events',0,UNKNOWN,0,0,0],
  ['notification_event_baselines',46,UNKNOWN,0,0,0],
  ['people',7,HOUSE,0,0,0],
  ['recipes',3,HOUSE,0,0,0],
  ['shopping_store_preferences',1,UNKNOWN,0,0,1],
  ['shopping_stores',3,UNKNOWN,0,0,0],
  ['test_assignment_acknowledgements',14,UNKNOWN,0,0,1],
  ['test_event_invitations',11,UNKNOWN,0,3,0],
  ['test_push_deliveries',4,UNKNOWN,0,0,0],
  ['test_push_subscriptions',1,UNKNOWN,0,0,0],
]
function inventory() {
  return {
    kind:'phase1-offline-legacy-to-primary-household-inventory-v1',
    legacySnapshotVerified:true,
    sourceSha:SHA,schemaSha256:'a'.repeat(64),
    tableCount:OBSERVED.length,legacyAccounts:1,savedSessions:21,
    activeSessionsAtInspection:2,uploadedFileCount:16,
    missingRequiredTables:[],
    realMigrationExecuted:false,testDeploymentAuthorized:false,
    liveDeploymentAuthorized:false,
    tables:OBSERVED.map(([table,rows,classification,foreignKeysToCentral,
      foreignKeysToHousehold,foreignKeysNeedingReview])=>({
      table,rows,classification,foreignKeysToCentral,
      foreignKeysToHousehold,foreignKeysNeedingReview,
    })),
  }
}
const disposition=(r,name)=>r.tableReview.find(t=>t.table===name).proposedDisposition
test('27 historical tables receive explicit security dispositions but no data movement authorization',()=>{
  const r=review(inventory())
  assert.equal(r.verifiedHistoricalArchive,true)
  assert.equal(r.historicalTablesMappedForReview,27)
  assert.equal(r.previouslyUnmappedTablesNowAssignedProvisionalPolicy,18)
  assert.equal(r.historicalAccountCount,1)
  assert.equal(r.historicalSavedSessions,21)
  assert.equal(r.historicalUnexpiredUnrevokedSessionsAtInspection,2)
  assert.equal(r.historicalUploadedFiles,16)
  assert.equal(r.unresolvedDeclaredForeignKeyEndpoints,3)
  assert.equal(disposition(r,'family_users'),'central-account-review')
  assert.equal(disposition(r,'family_sessions'),'central-sessions-reauth')
  assert.equal(disposition(r,'emoji_markers'),'household-data-preserve')
  assert.equal(disposition(r,'shopping_store_preferences'),'household-data-preserve')
  assert.equal(disposition(r,'test_event_invitations'),'household-notice-reconciliation')
  assert.equal(disposition(r,'test_assignment_acknowledgements'),'household-notice-reconciliation')
  assert.equal(disposition(r,'notification_event_baselines'),'household-notice-reconciliation')
  assert.equal(disposition(r,'test_push_subscriptions'),'device-subscription-reenrollment')
  assert.equal(disposition(r,'capture_inbox'),'retired-table-archive-only')
  const by=new Map(r.dispositionSummary.map(x=>[x.disposition,x]))
  assert.deepEqual([...by.values()].map(x=>x.tableCount).sort((a,b)=>a-b),
    [1,1,1,2,8,14])
  assert.equal(by.get('household-data-preserve').tableCount,14)
  assert.equal(by.get('household-notice-reconciliation').tableCount,8)
  assert.equal(by.get('central-sessions-reauth').recordCount,21)
  assert.equal(by.get('retired-table-archive-only').recordCount,0)
  assert.equal(r.tableReview.every(x=>x.approvedToCopy===false&&
    x.exactColumnMappingReviewed===false&&
    x.householdOwnerMappingVerified===false),true)
  for(const key of [
    'fullSchemaMigrationReviewed','currentRunningTestContentsVerified',
    'centralIdentityMigrationExecuted','householdCopyExecuted',
    'sessionMigrationAuthorized','automaticDataDeletionAuthorized',
    'backupAuthorized','rollbackAuthorized','testDeploymentAuthorized',
    'liveDeploymentAuthorized','userApprovalForActualMigration',
  ])assert.equal(r[key],false,key)
  assert.equal(r.existingBrowserSessionsNeverCopied,true)
  assert.equal(r.oldDevicePushSubscriptionsNeedExplicitReenrollment,true)
  assert.equal(r.preserveNotificationsAndAcknowledgementHistory,true)
  assert(Object.isFrozen(r)&&Object.isFrozen(r.tableReview))
})
test('missing, unknown or duplicated tables refuse and cannot silently omit records',()=>{
  for(const mutate of [
    d=>d.tables.pop(),
    d=>d.tables[2].table='surprise_calendar_internal',
    d=>d.tables[3].table=d.tables[2].table,
    d=>d.tables[4].classification='unexpected',
    d=>d.tables[6].rows=-1,
    d=>d.tables[0].foreignKeysNeedingReview=Infinity,
    d=>d.tableCount=26,
    d=>d.missingRequiredTables=['events'],
  ]) {
    const d=inventory(); mutate(d)
    assert.throws(()=>review(d),/refused/)
  }
})
test('historical identity and session safety must not be downgraded by metadata',()=>{
  for(const mutate of [
    d=>d.legacyAccounts=0,
    d=>d.savedSessions=2,
    d=>d.activeSessionsAtInspection=null,
    d=>d.activeSessionsAtInspection=22,
    d=>d.tables.find(x=>x.table==='family_users').classification=HOUSE,
    d=>d.tables.find(x=>x.table==='family_sessions').classification=UNKNOWN,
    d=>d.tables.find(x=>x.table==='family_sessions').rows=20,
    d=>d.testDeploymentAuthorized=true,
    d=>d.realMigrationExecuted=true,
  ]) {
    const d=inventory();mutate(d)
    assert.throws(()=>review(d),/refused/)
  }
})
test('retired inbox with data and household identity foreign keys refuse',()=>{
  const a=inventory()
  a.tables.find(t=>t.table==='capture_inbox').rows=1
  assert.throws(()=>review(a),/refused/)
  const b=inventory()
  b.tables.find(t=>t.table==='test_event_invitations').foreignKeysToCentral=1
  assert.throws(()=>review(b),/refused/)
})
test('review never exports account, credential, event, upload or device row contents',()=>{
  const r=review(inventory())
  const printed=JSON.stringify(r)
  assert.doesNotMatch(printed,/personal_email|password_hash|token_hash|device_label|family-private-event/)
  assert.equal(printed.includes('tableReview'),true)
})
