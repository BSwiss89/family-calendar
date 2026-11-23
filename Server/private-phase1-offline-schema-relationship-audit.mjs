// Phase 1: schema-only inspection of the independently verified historical
// OFFLINE legacy TEST archive. NEVER reads application rows (except the
// existing verifier's integrity checks / aggregate counts), never prints DDL
// text, credentials, tokens, family names, event titles, or upload names.
// It does not copy rows, mutate the archive, or open running LIVE / TEST.
// Table/column identifiers are restricted to non-sensitive SQL identifier
// syntax; other metadata is counted or hashed, never echoed verbatim.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { inspectPrivatePhase1OfflineLegacyMigration }
  from './private-phase1-offline-legacy-migration-inventory.mjs'
import {
  reviewPrivatePhase1LegacyTableDispositions,
  listPrivatePhase1LegacyDispositionRules,
} from './private-phase1-legacy-table-disposition-review.mjs'

const SAFE_IDENTIFIER=/^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const MAX_INDEXES=128, MAX_COLUMNS=256, MAX_FOREIGN_KEYS=128
const SHA=/^[a-f0-9]{40}$/
const DISPOSITIONS=new Map(
  listPrivatePhase1LegacyDispositionRules().map(x=>[x.table,x.disposition])
)
const ID_COLUMN=/(?:^|_)(?:user|owner|account|session|person|event|list|item|recipe|meal|store|invite|invitation|notification|device|actor|creator|family|household)(?:_id|_ids|id)$|_id$|_ids$/i
function refuse(message) {
  throw new Error('Phase 1 historical TEST schema audit refused: '+message)
}
function checkedIdentifier(value) {
  if(typeof value!=='string'||!SAFE_IDENTIFIER.test(value)) {
    refuse('unrecognized or potentially sensitive SQL identifier.')
  }
  return value
}
function quote(v) { return '"'+checkedIdentifier(v)+'"' }
function columnsFor(db,table) {
  const cols=db.prepare('PRAGMA table_xinfo('+quote(table)+')').all()
  if(!cols.length||cols.length>MAX_COLUMNS)refuse('invalid table column count.')
  const seen=new Set()
  const result=cols.map(c=>{
    const name=checkedIdentifier(c.name)
    const normalized=name.toLowerCase()
    if(seen.has(normalized))refuse('duplicate case-insensitive column.')
    seen.add(normalized)
    if(typeof c.type!=='string'||c.type.length>96||
       !/^[A-Za-z0-9_ (),]*$/.test(c.type)||
       ![0,1].includes(c.notnull)||
       !Number.isSafeInteger(c.pk)||c.pk<0||
       ![0,1,2,3].includes(c.hidden)) {
      refuse('unsafe, malformed or hidden SQLite column structure.')
    }
    return Object.freeze({
      column:name,declaredType:c.type.toUpperCase(),
      required:c.notnull===1,primaryKeyPosition:c.pk,
      generatedOrHidden:c.hidden!==0,
    })
  })
  return Object.freeze(result)
}
function foreignKeysFor(db,table,colset) {
  const fks=db.prepare('PRAGMA foreign_key_list('+quote(table)+')').all()
  if(fks.length>MAX_FOREIGN_KEYS)refuse('excessive foreign-key declarations.')
  const ids=new Map()
  for(const fk of fks) {
    if(!Number.isSafeInteger(fk.id)||fk.id<0||
       !Number.isSafeInteger(fk.seq)||fk.seq<0||
       typeof fk.table!=='string')refuse('malformed foreign-key relationship.')
    const target=checkedIdentifier(fk.table)
    const sourceColumn=checkedIdentifier(fk.from)
    if(!colset.has(sourceColumn.toLowerCase()))refuse('foreign-key source column is missing.')
    const targetColumn=fk.to===null?null:checkedIdentifier(fk.to)
    if(!DISPOSITIONS.has(target))refuse('foreign-key targets a table outside the reviewed 27.')
    const validActions=new Set(['NO ACTION','RESTRICT','SET NULL','SET DEFAULT','CASCADE'])
    if(!validActions.has(fk.on_update)||!validActions.has(fk.on_delete)) {
      refuse('unreviewed foreign-key action.')
    }
    const existing=ids.get(fk.id)
    if(existing && (existing.target!==target||
       existing.onUpdate!==fk.on_update||existing.onDelete!==fk.on_delete)) {
      refuse('inconsistent multicolumn foreign key.')
    }
    const relation=existing??{
      target,disposition:DISPOSITIONS.get(target),
      onUpdate:fk.on_update,onDelete:fk.on_delete,fields:[],
    }
    if(relation.fields.some(x=>x.position===fk.seq))refuse('duplicate composite key position.')
    relation.fields.push({
      position:fk.seq,from:sourceColumn,to:targetColumn,
    })
    ids.set(fk.id,relation)
  }
  return Object.freeze([...ids.entries()].sort((a,b)=>a[0]-b[0])
    .map(([ordinal,ref])=>{
      ref.fields.sort((a,b)=>a.position-b.position)
      if(ref.fields.some((f,i)=>f.position!==i))refuse('broken composite foreign key.')
      return Object.freeze({
        ordinal,referencedTable:ref.target,
        referencedDisposition:ref.disposition,
        onUpdate:ref.onUpdate,onDelete:ref.onDelete,
        columnPairs:Object.freeze(ref.fields.map(f=>Object.freeze({
          from:f.from,to:f.to,implicitPrimaryKey:f.to===null,
        }))),
        crossesCentralOrDeviceBoundary:![
          'household-data-preserve','household-notice-reconciliation',
        ].includes(ref.disposition),
      })
    }))
}
function indexesFor(db,table,colset) {
  const indexes=db.prepare('PRAGMA index_list('+quote(table)+')').all()
  if(indexes.length>MAX_INDEXES)refuse('excessive legacy index count.')
  const validOrigin=new Set(['c','u','pk'])
  const result=[]
  let partialCount=0,expressionCount=0
  for(const index of indexes) {
    if(typeof index.name!=='string'||index.name.length>255||
       ![0,1].includes(index.unique)||![0,1].includes(index.partial)||
       !validOrigin.has(index.origin))refuse('unrecognized SQLite index properties.')
    // Index names are never returned because arbitrary names can contain
    // user text; quote them before using only in a PRAGMA query.
    const quoted='"'+index.name.replaceAll('"','""')+'"'
    const keyInfo=db.prepare('PRAGMA index_xinfo('+quoted+')').all()
    if(keyInfo.length>MAX_COLUMNS)refuse('index has excessive columns.')
    const keys=[]
    for(const part of keyInfo) {
      if(![0,1].includes(part.key))refuse('unrecognized index_xinfo key status.')
      if(part.key!==1)continue
      if(part.cid===-2) {
        keys.push({expression:true});expressionCount++
      } else if(part.cid===-1) {
        keys.push({rowid:true})
      } else {
        const col=checkedIdentifier(part.name)
        if(!colset.has(col.toLowerCase()))refuse('index references missing column.')
        keys.push({column:col})
      }
    }
    if(index.partial===1)partialCount++
    result.push(Object.freeze({
      ordinal:index.seq,unique:index.unique===1,
      origin:index.origin,partial:index.partial===1,
      keyParts:Object.freeze(keys.map(x=>Object.freeze(x))),
      requiresExpressionOrPartialSqlReview:index.partial===1||
        keys.some(x=>x.expression===true),
    }))
  }
  return {
    indexes:Object.freeze(result.sort((a,b)=>a.ordinal-b.ordinal)),
    partialCount,expressionCount,
  }
}
function triggerAndViewCounts(db,table) {
  const triggers=db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name=?"
  ).get(table).n
  if(!Number.isSafeInteger(triggers)||triggers<0||triggers>MAX_INDEXES)
    refuse('unexpected trigger metadata.')
  return triggers
}
/**
 * Requires the exact cold-backup root and SHA enforced by the archive verifier
 * and 27-table inventory. Does not return CREATE TABLE/INDEX/TRIGGER SQL.
 * An index or FK being listed is not proof its business meaning is understood.
 */
export function auditPrivatePhase1OfflineLegacySchema({
  recoveryParent,snapshotRoot,expectedInstalledTestSha,
}={}) {
  if(!SHA.test(expectedInstalledTestSha))refuse('expected source SHA required.')
  const input={recoveryParent,snapshotRoot,expectedInstalledTestSha}
  const initial=inspectPrivatePhase1OfflineLegacyMigration(input)
  const policy=reviewPrivatePhase1LegacyTableDispositions(initial)
  if(policy.historicalTablesMappedForReview!==27||
     policy.testDeploymentAuthorized!==false)refuse('complete archival table policy required.')
  const dbFilename=path.join(snapshotRoot,'calendar.db')
  if(fs.lstatSync(dbFilename).isSymbolicLink())refuse('linked SQLite is not allowed.')
  const db=new DatabaseSync(dbFilename,{readOnly:true})
  let details,totalColumns=0,totalIndexes=0,totalFks=0,
    totalTriggers=0,implicitReferenceHints=0,crossBoundaryFks=0
  try {
    db.exec('PRAGMA query_only=ON')
    // No emitted schema SQL. Schema hash is useful to compare against the
    // original inventory independently derived from the same archive.
    const raw=db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().filter(x=>!x.name.startsWith('sqlite_'))
    const schemaHash=createHash('sha256').update(
      JSON.stringify(raw.map(x=>[x.name,x.sql]))
    ).digest('hex')
    if(schemaHash!==initial.schemaSha256)refuse('table SQL changed during inspection.')
    const names=new Set(raw.map(x=>x.name))
    const views=db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='view'"
    ).get().n
    if(!Number.isSafeInteger(views)||views<0||views>MAX_INDEXES)
      refuse('unreviewed database view count.')
    details=[...DISPOSITIONS.entries()].sort(([a],[b])=>a.localeCompare(b))
      .map(([table,disposition])=>{
        if(!names.has(table))refuse('a required old table is absent.')
        const columns=columnsFor(db,table)
        const colset=new Set(columns.map(x=>x.column.toLowerCase()))
        const foreignKeys=foreignKeysFor(db,table,colset)
        const indexes=indexesFor(db,table,colset)
        const triggers=triggerAndViewCounts(db,table)
        const referenced=new Set(foreignKeys.flatMap(f=>f.columnPairs
          .map(x=>x.from.toLowerCase())))
        const undeclaredIdColumns=columns.filter(x=>ID_COLUMN.test(x.column) &&
          x.primaryKeyPosition===0&&!referenced.has(x.column.toLowerCase()))
          .map(x=>x.column)
        totalColumns+=columns.length
        totalIndexes+=indexes.indexes.length
        totalFks+=foreignKeys.length
        totalTriggers+=triggers
        implicitReferenceHints+=undeclaredIdColumns.length
        crossBoundaryFks+=foreignKeys.filter(x=>x.crossesCentralOrDeviceBoundary &&
          ['household-data-preserve','household-notice-reconciliation'].includes(disposition)).length
        return Object.freeze({
          table,disposition,columns,indexes:indexes.indexes,foreignKeys,
          triggerCount:triggers,
          expressionIndexParts:indexes.expressionCount,
          partialIndexCount:indexes.partialCount,
          unlinkedIdColumnHints:Object.freeze(undeclaredIdColumns),
          schemaMappingsApproved:false,
          individualRowsRead:false,
          copiedToAnyHousehold:false,
        })
      })
    // Note: sqlite_schema views are counted; their CREATE SQL is never
    // emitted. Any view/trigger is a mandatory semantic migration blocker.
    return Object.freeze({
      kind:'phase1-archive-schema-relationship-audit-v1',
      verifiedHistoricalArchive:true,
      installedTestSha:expectedInstalledTestSha,
      schemaSha256:initial.schemaSha256,
      tables:27,totalColumns,totalIndexes,
      totalExplicitForeignKeys:totalFks,
      totalTriggers,totalViews:views,
      undeclaredIdColumnHints:implicitReferenceHints,
      crossCentralOrDeviceForeignKeys:crossBoundaryFks,
      historicalTables:Object.freeze(details),
      requiresIndexSqlAndTriggerReview:true,
      requiresColumnDefaultsAndCheckConstraintReview:true,
      requiresImplicitIdentifierRelationshipReview:true,
      requiresFreshWriterFencedCurrentTestBackup:true,
      sourceArchiveModified:false,
      installedTestOrLiveAccessed:false,
      userValuesExposed:false,
      fullSchemaCompatibilityEstablished:false,
      realMigrationExecuted:false,
      dataCopyAuthorized:false,
      sessionMigrationAuthorized:false,
      testDeploymentAuthorized:false,
      liveDeploymentAuthorized:false,
    })
  } finally {
    db.close()
    // NOTE: this finally cannot verify when an earlier error happens before
    // the full scan. Before/after archive attestation is done on success
    // below by wrapper rather than from this finally.
  }
}
