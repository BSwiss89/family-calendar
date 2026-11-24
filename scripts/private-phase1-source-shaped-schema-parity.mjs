// Read-only schema metadata comparison. Never executes or prints archived SQL.
// A matching structure is evidence, not semantic equivalence or migration approval.
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
import {auditPrivatePhase1OfflineLegacySchema} from '../Server/private-phase1-offline-schema-relationship-audit.mjs'
import {listPrivatePhase1LegacyDispositionRules} from '../Server/private-phase1-legacy-table-disposition-review.mjs'
import {installSourceShapedSyntheticLegacyBase,installSourceShapedSyntheticLegacyNotifications} from './private-phase1-source-shaped-legacy-schema.mjs'
const tables=listPrivatePhase1LegacyDispositionRules().map(x=>x.table).sort()
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const q=x=>'"'+x.replaceAll('"','""')+'"'
const sorted=xs=>xs.map(x=>JSON.stringify(x)).sort()
const refuse=()=>{throw new Error('Legacy structural comparison refused.')}
function tableMetadata(db,table) {
 const row=db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)
 const flags=db.prepare("SELECT strict,wr FROM pragma_table_list WHERE schema='main' AND name=? AND type='table'").get(table)
 if(!row||!flags||typeof row.sql!=='string')refuse()
 const columns=db.prepare('PRAGMA table_xinfo('+q(table)+')').all()
 const fk=db.prepare('PRAGMA foreign_key_list('+q(table)+')').all()
 const groups=new Map()
 for(const x of fk){
  if(!groups.has(x.id))groups.set(x.id,[])
  groups.get(x.id).push([x.seq,x.table,x.from,x.to,x.on_update,x.on_delete,x.match])
 }
 const indexes=db.prepare('PRAGMA index_list('+q(table)+')').all().map(x=>{
  const parts=db.prepare('PRAGMA index_xinfo('+q(x.name)+')').all()
   .filter(p=>p.key===1).map(p=>[p.cid<0?p.cid:p.name,p.desc,p.coll])
  const sql=db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(x.name)?.sql
  return {shape:[x.origin,x.unique,x.partial,parts],definition:sql==null?null:hash(sql)}
 })
 return {
  order:columns.map(c=>c.name),
  columns:sorted(columns.map(c=>[c.name,c.type.toUpperCase(),c.notnull,c.pk,c.hidden])),
  defaults:sorted(columns.map(c=>[c.name,c.dflt_value])),
  flags:[flags.strict,flags.wr],
  foreignKeys:sorted([...groups.values()].map(g=>g.sort((a,b)=>a[0]-b[0]))),
  indexes:sorted(indexes.map(x=>x.shape)),
  explicitIndexDefinitions:sorted(indexes.filter(x=>x.definition!==null).map(x=>[x.shape,x.definition])),
  tableDefinition:hash(row.sql)
 }
}
export function compareSourceShapedLegacyMetadata(db) {
 const ref=new DatabaseSync(':memory:')
 try {
  ref.exec('PRAGMA foreign_keys=ON')
  installSourceShapedSyntheticLegacyBase(ref)
  installSourceShapedSyntheticLegacyNotifications(ref)
  const actual=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name)
  if(JSON.stringify(actual)!==JSON.stringify(tables))refuse()
  const details=tables.map(table=>{
   const a=tableMetadata(db,table),b=tableMetadata(ref,table)
   const differences=Object.keys(b).filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]))
   return {table,differences,structuralMatch:differences.every(k=>['tableDefinition','explicitIndexDefinitions','order'].includes(k)),
    exactTableDdlMatch:!differences.includes('tableDefinition'),
    exactExplicitIndexDdlMatch:!differences.includes('explicitIndexDefinitions')}
  })
  return {kind:'phase1-source-shaped-legacy-structure-comparison-v1',tables:details.length,
   structuralMatches:details.filter(x=>x.structuralMatch).length,
   columnOrderMatches:details.filter(x=>!x.differences.includes('order')).length,
   exactTableDdlMatches:details.filter(x=>x.exactTableDdlMatch).length,
   exactExplicitIndexDdlMatches:details.filter(x=>x.exactExplicitIndexDdlMatch).length,
   details,rawArchivedSqlExposed:false,fullSchemaCompatibilityProven:false,
   realMigrationExecuted:false,testDeploymentAuthorized:false,liveDeploymentAuthorized:false}
 } finally {ref.close()}
}
export function inspectSourceShapedLegacyArchive(args) {
 const before=auditPrivatePhase1OfflineLegacySchema(args)
 if(before.tables!==27||before.totalTriggers!==14||before.testDeploymentAuthorized!==false)refuse()
 const db=new DatabaseSync(path.join(args.snapshotRoot,'calendar.db'),{readOnly:true})
 let result
 try {
  db.exec('PRAGMA query_only=ON')
  result=compareSourceShapedLegacyMetadata(db)
 } finally {db.close()}
 const after=auditPrivatePhase1OfflineLegacySchema(args)
 if(before.schemaSha256!==after.schemaSha256||before.totalColumns!==after.totalColumns||
    before.totalIndexes!==after.totalIndexes||before.totalExplicitForeignKeys!==after.totalExplicitForeignKeys)refuse()
 return {...result,verifiedHistoricalArchive:true,archiveUnchanged:true,runningCalendarsAccessed:false}
}
