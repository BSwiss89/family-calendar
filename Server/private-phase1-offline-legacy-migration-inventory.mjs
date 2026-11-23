// Read-only migration inventory for a VERIFIED, OFFLINE legacy TEST snapshot.
// Never reads an installed calendar, moves databases, creates household data,
// alters authentication, starts services, or authorizes any deployment.
// A saved legacy database mixes calendar tables with central login tables;
// this inventory exposes schema and aggregate counts, NEVER row contents,
// people/account names, upload filenames, hashes of credentials, or tokens.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { verifyOfflineLegacyTestSnapshot }
  from './private-phase1-legacy-snapshot-verification.mjs'

const CENTRAL=new Set([
  'family_users', 'family_sessions', 'household_registry',
  'household_memberships', 'household_session_selections',
])
const HOUSEHOLD=new Set([
  'events','event_people','people','lists','list_items','daily_notes',
  'recurring_event_exceptions','recipes','recipe_ingredients','meals',
])
const NAME=/^[A-Za-z][A-Za-z0-9_]*$/
const MAX_TABLES=256
const MAX_ROWS=10000000
const REQUIRED=['family_users','family_sessions','events','people','lists']

function refuse(message) {
  throw new Error('Phase 1 offline legacy migration inventory refused: '+message)
}
function category(table) {
  if(CENTRAL.has(table)) return 'central-candidate'
  if(HOUSEHOLD.has(table)) return 'household-candidate'
  return 'needs-explicit-mapping'
}
function verifyRequiredColumns(db,name,columns) {
  const cols=new Set(db.prepare('PRAGMA table_info("'+name+'")').all().map(x=>x.name))
  return columns.every(x=>cols.has(x))
}

/**
 * Analyze only the pinned, existing November 22 cold snapshot format.
 * Before/after independent inventory verification refuses changed bytes,
 * unexpected uploaded files, extra SQLite sidecars, corrupted DB and
 * unreviewed input roots. No credential or calendar row is ever returned.
 * Table grouping is a PROPOSAL, never an automatic migration mapping.
 */
export function inspectPrivatePhase1OfflineLegacyMigration({
  recoveryParent,snapshotRoot,expectedInstalledTestSha,
}={}) {
  // Never treat an installed TEST/LIVE checkout or a browser-chosen folder
  // as a recovery archive, even if someone forges a plausible manifest.
  if(typeof recoveryParent!=='string'||!path.isAbsolute(recoveryParent)||
     path.basename(path.resolve(recoveryParent)).toLowerCase()!==
       'family-calendar-phase1-recovery'||
     path.resolve(recoveryParent).split(path.sep).some(part=>
       ['family-calendar','family-calendar-preview',
         'family-calendar-test-security-stage'].includes(part.toLowerCase()))) {
    refuse('only the separately protected legacy recovery root may be inspected.')
  }
  const args={recoveryParent,snapshotRoot,expectedInstalledTestSha}
  const initial=verifyOfflineLegacyTestSnapshot(args)
  if(initial.result!=='PASS') refuse('legacy TEST cold backup must verify.')
  const dbFile=path.join(snapshotRoot,'calendar.db')
  const stat=fs.lstatSync(dbFile)
  if(!stat.isFile()||stat.isSymbolicLink()) refuse('expected ordinary offline SQLite file.')
  const db=new DatabaseSync(dbFile,{readOnly:true})
  let tables,activeSessions=null,accountCount=0,tableSchemaDigest
  try {
    db.exec('PRAGMA query_only = ON')
    const raw=db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().filter(row=>!row.name.startsWith('sqlite_'))
    if(raw.length<1||raw.length>MAX_TABLES||
      raw.some(x=>typeof x.name!=='string'||!NAME.test(x.name)||
        typeof x.sql!=='string'||/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(x.sql))) {
      refuse('unrecognized, virtual, or excessive legacy SQLite tables.')
    }
    const names=new Set(raw.map(x=>x.name))
    if(names.size!==raw.length) refuse('duplicate table names in snapshot.')
    tableSchemaDigest=createHash('sha256').update(
      JSON.stringify(raw.map(x=>[x.name,x.sql]))
    ).digest('hex')
    const categories=new Map(raw.map(x=>[x.name,category(x.name)]))
    tables=raw.map(x=>{
      const name=x.name
      const count=db.prepare('SELECT COUNT(*) AS n FROM "'+name+'"').get().n
      if(!Number.isSafeInteger(count)||count<0||count>MAX_ROWS) {
        refuse('a legacy table exceeds the bounded inventory limit.')
      }
      const fks=db.prepare('PRAGMA foreign_key_list("'+name+'")').all()
      if(fks.length>128||fks.some(f=>typeof f.table!=='string')) {
        refuse('unreviewed foreign-key dependency structure.')
      }
      const toCentral=fks.filter(f=>categories.get(f.table)==='central-candidate').length
      const toHousehold=fks.filter(f=>categories.get(f.table)==='household-candidate').length
      const toUnknown=fks.filter(f=>!categories.has(f.table)||
        categories.get(f.table)==='needs-explicit-mapping').length
      return Object.freeze({
        table:name, rows:count, classification:categories.get(name),
        foreignKeysToCentral:toCentral,foreignKeysToHousehold:toHousehold,
        foreignKeysNeedingReview:toUnknown,
      })
    })
    if(names.has('family_users')) {
      accountCount=tables.find(x=>x.table==='family_users').rows
    }
    if(names.has('family_sessions')&&verifyRequiredColumns(
      db,'family_sessions',['revoked_at','expires_at'])) {
      activeSessions=db.prepare([
        'SELECT COUNT(*) AS n FROM family_sessions',
        'WHERE revoked_at IS NULL AND expires_at > ?',
      ].join(' ')).get(Date.now()).n
    }
  } finally {
    db.close()
  }
  const final=verifyOfflineLegacyTestSnapshot(args)
  if(final.fileCount!==initial.fileCount||
     final.sourceSha!==initial.sourceSha||
     final.uploadFiles!==initial.uploadFiles||
     final.buildFiles!==initial.buildFiles||
     final.sqliteTablesChecked!==initial.sqliteTablesChecked) {
    refuse('verified legacy cold snapshot changed during schema inventory.')
  }
  const byClass=Object.freeze({
    centralCandidateTables:tables.filter(t=>t.classification==='central-candidate').length,
    householdCandidateTables:tables.filter(t=>t.classification==='household-candidate').length,
    needsExplicitMappingTables:tables.filter(t=>t.classification==='needs-explicit-mapping').length,
    crossBoundaryForeignKeys:tables.filter(t=>t.classification==='household-candidate')
      .reduce((n,t)=>n+t.foreignKeysToCentral,0),
  })
  const missingRequiredTables=REQUIRED.filter(name=>!tables.some(x=>x.table===name))
  // Every existing table must be explicitly mapped, and existing sessions
  // must be safely reconciled before splitting central identity from events.
  return Object.freeze({
    kind:'phase1-offline-legacy-to-primary-household-inventory-v1',
    legacySnapshotVerified:true,
    sourceSha:initial.sourceSha,
    tableCount:tables.length,
    schemaSha256:tableSchemaDigest,
    uploadedFileCount:initial.uploadFiles,
    archivedBuildFileCount:initial.buildFiles,
    legacyAccounts:accountCount,
    savedSessions:tables.find(x=>x.table==='family_sessions')?.rows??0,
    activeSessionsAtInspection:activeSessions,
    missingRequiredTables:Object.freeze(missingRequiredTables),
    grouping:byClass,
    tables:Object.freeze(tables),
    unmappedTableNamesAreSchemaOnly:true,
    accountCredentialsCopied:false,
    loginSessionsMigrated:false,
    legacyArchiveModified:false,
    installedTestOrLiveAccessed:false,
    realMigrationExecuted:false,
    migrationApproved:false,
    testDeploymentAuthorized:false,
    liveDeploymentAuthorized:false,
    requiresExplicitTableMapping:true,
    requiresOwnerSessionReconciliation:true,
    requiresSeparateMigrationAndRecoveryApproval:true,
  })
}
