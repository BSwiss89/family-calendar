// PURE, source-only Phase 1 disposition review for the historical legacy TEST
// cold backup. This is a mapping PROPOSAL, not a schema migration, a tenant
// assignment, a credential transfer, or an assertion that rows can be copied.
// Row values, tokens, names, uploads and account identities are never read.
const SHA=/^[a-f0-9]{40}$/
const HASH=/^[a-f0-9]{64}$/
const CLASS=new Set(['central-candidate','household-candidate','needs-explicit-mapping'])
const MAX_ROWS=10000000
const RULES=Object.freeze({
  family_users:'central-account-review',
  family_sessions:'central-sessions-reauth',
  events:'household-data-preserve',
  event_people:'household-data-preserve',
  people:'household-data-preserve',
  lists:'household-data-preserve',
  list_items:'household-data-preserve',
  daily_notes:'household-data-preserve',
  recipes:'household-data-preserve',
  event_exceptions:'household-data-preserve',
  emoji_markers:'household-data-preserve',
  emoji_marker_exceptions:'household-data-preserve',
  meal_plans:'household-data-preserve',
  meal_plan_items:'household-data-preserve',
  shopping_stores:'household-data-preserve',
  shopping_store_preferences:'household-data-preserve',
  assignment_notification_outbox:'household-notice-reconciliation',
  notification_deleted_event_details:'household-notice-reconciliation',
  notification_dirty_event_attribution:'household-notice-reconciliation',
  notification_dirty_event_fields:'household-notice-reconciliation',
  notification_dirty_events:'household-notice-reconciliation',
  notification_event_baselines:'household-notice-reconciliation',
  test_assignment_acknowledgements:'household-notice-reconciliation',
  test_event_invitations:'household-notice-reconciliation',
  test_push_subscriptions:'device-subscription-reenrollment',
  test_push_deliveries:'device-subscription-reenrollment',
  capture_inbox:'retired-table-archive-only',
})
const EXPECTED=Object.freeze(Object.keys(RULES).sort())
const OPTIONS=new Set(Object.values(RULES))
function refuse(reason) {
  throw new Error('Phase 1 legacy table disposition refused: '+reason)
}
function verifyTable(t) {
  if(!t || typeof t!=='object' || Array.isArray(t) ||
     typeof t.table!=='string' || !Object.hasOwn(RULES,t.table) ||
     !Number.isSafeInteger(t.rows) || t.rows<0 || t.rows>MAX_ROWS ||
     !CLASS.has(t.classification) ||
     ![t.foreignKeysToCentral,t.foreignKeysToHousehold,
       t.foreignKeysNeedingReview].every(x=>Number.isSafeInteger(x)&&x>=0&&x<=128)) {
    refuse('one historical table is unrecognized or has invalid inventory metadata.')
  }
  if ((t.table==='family_users'||t.table==='family_sessions') !==
       (t.classification==='central-candidate')) {
    refuse('central-account table boundary differs from the archived inventory.')
  }
  return Object.freeze({
    table:t.table, savedRows:t.rows, proposedDisposition:RULES[t.table],
    foreignKeysToCentral:t.foreignKeysToCentral,
    foreignKeysToHousehold:t.foreignKeysToHousehold,
    foreignKeysNeedingReview:t.foreignKeysNeedingReview,
    // Even a familiar name can hide profile IDs, embedded event state or
    // device credentials. No table is copy-authorized by this report.
    approvedToCopy:false,
    exactColumnMappingReviewed:false,
    householdOwnerMappingVerified:false,
  })
}
/**
 * Input is the *already verified* archive-only result from
 * inspectPrivatePhase1OfflineLegacyMigration, never browser JSON or a live
 * SQLite database. Every one of the 27 observed tables must be mapped; a
 * changed or missing table refuses instead of silently omitting data.
 */
export function reviewPrivatePhase1LegacyTableDispositions(inventory) {
  if(!inventory||typeof inventory!=='object'||Array.isArray(inventory)||
     inventory.kind!=='phase1-offline-legacy-to-primary-household-inventory-v1'||
     inventory.legacySnapshotVerified!==true ||
     !SHA.test(inventory.sourceSha)||!HASH.test(inventory.schemaSha256)||
     !Array.isArray(inventory.tables) || inventory.tables.length!==EXPECTED.length ||
     inventory.tableCount!==EXPECTED.length ||
     !Array.isArray(inventory.missingRequiredTables) ||
     inventory.missingRequiredTables.length!==0 ||
     !Number.isSafeInteger(inventory.legacyAccounts) ||
     inventory.legacyAccounts!==1 ||
     !Number.isSafeInteger(inventory.savedSessions) ||
     inventory.savedSessions<0 ||
     inventory.activeSessionsAtInspection===null ||
     !Number.isSafeInteger(inventory.activeSessionsAtInspection) ||
     inventory.activeSessionsAtInspection<0 ||
     inventory.activeSessionsAtInspection>inventory.savedSessions ||
     !Number.isSafeInteger(inventory.uploadedFileCount) ||
     inventory.uploadedFileCount<0 ||
     inventory.realMigrationExecuted!==false ||
     inventory.testDeploymentAuthorized!==false ||
     inventory.liveDeploymentAuthorized!==false) {
    refuse('exact, complete and immutable-permission historical archive inventory required.')
  }
  const seen=new Set()
  const tableReview=inventory.tables.map(t=>{
    const checked=verifyTable(t)
    if(seen.has(t.table))refuse('duplicate archived table.')
    seen.add(t.table)
    return checked
  }).sort((a,b)=>a.table.localeCompare(b.table))
  if(EXPECTED.some(x=>!seen.has(x)))refuse('an archived table is missing.')
  const rows=new Map([...OPTIONS].map(x=>[x,0]))
  const tableCounts=new Map([...OPTIONS].map(x=>[x,0]))
  let unknownForeignKeys=0
  let centralForeignKeysOutsideIdentity=0
  for(const t of tableReview) {
    rows.set(t.proposedDisposition,rows.get(t.proposedDisposition)+t.savedRows)
    tableCounts.set(t.proposedDisposition,tableCounts.get(t.proposedDisposition)+1)
    unknownForeignKeys+=t.foreignKeysNeedingReview
    if(t.proposedDisposition!=='central-account-review'&&
       t.proposedDisposition!=='central-sessions-reauth') {
      centralForeignKeysOutsideIdentity+=t.foreignKeysToCentral
    }
  }
  if(tableReview.find(x=>x.table==='family_users').savedRows!==inventory.legacyAccounts ||
     tableReview.find(x=>x.table==='family_sessions').savedRows!==inventory.savedSessions ||
     tableReview.find(x=>x.table==='capture_inbox').savedRows!==0) {
    refuse('archived account/session counts changed or retired inbox holds data.')
  }
  // A cross-boundary FK needs explicit semantic identity translation, never
  // a raw row-copy. Throw to avoid advertising any cohort as mapped.
  if(centralForeignKeysOutsideIdentity>0) {
    refuse('household candidate declares a central-identity foreign-key dependency.')
  }
  const byDisposition=Object.freeze([...rows.entries()].sort(([a],[b])=>a.localeCompare(b))
    .map(([disposition,recordCount])=>Object.freeze({
      disposition,tableCount:tableCounts.get(disposition),recordCount,
    })))
  return Object.freeze({
    kind:'phase1-legacy-table-disposition-proposal-v1',
    exactSourceSha:inventory.sourceSha,
    historicalSchemaSha256:inventory.schemaSha256,
    verifiedHistoricalArchive:true,
    historicalTablesMappedForReview:EXPECTED.length,
    previouslyUnmappedTablesNowAssignedProvisionalPolicy:
      tableReview.filter(t=>inventory.tables.find(x=>x.table===t.table)
        .classification==='needs-explicit-mapping').length,
    dispositionSummary:byDisposition,
    tableReview:Object.freeze(tableReview),
    unresolvedDeclaredForeignKeyEndpoints:unknownForeignKeys,
    historicalAccountCount:inventory.legacyAccounts,
    historicalSavedSessions:inventory.savedSessions,
    historicalUnexpiredUnrevokedSessionsAtInspection:
      inventory.activeSessionsAtInspection,
    historicalUploadedFiles:inventory.uploadedFileCount,
    originalArchiveMustBeRetained:true,
    preserveAllHouseholdRowsUntilVerifiedMigration:true,
    preserveNotificationsAndAcknowledgementHistory:true,
    retiredCaptureInboxNotReactivate:true,
    ownerCredentialsNeedIdentityStepUpAndNewSessionPolicy:true,
    existingBrowserSessionsNeverCopied:true,
    oldDevicePushSubscriptionsNeedExplicitReenrollment:true,
    checkAllColumnSchemasAndUndeclaredRelationships:true,
    reconcileCrossFamilyInvitationsAndNotificationAttribution:true,
    verifyUploadFilesAndRelativePaths:true,
    needFreshLiveTestBaselineBeforeActualMigration:true,
    needCoordinatedCurrentWriterFencedBackup:true,
    fullSchemaMigrationReviewed:false,
    currentRunningTestContentsVerified:false,
    centralIdentityMigrationExecuted:false,
    householdCopyExecuted:false,
    sessionMigrationAuthorized:false,
    automaticDataDeletionAuthorized:false,
    backupAuthorized:false,
    rollbackAuthorized:false,
    testDeploymentAuthorized:false,
    liveDeploymentAuthorized:false,
    userApprovalForActualMigration:false,
  })
}
