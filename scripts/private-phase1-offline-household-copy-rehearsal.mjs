// Offline, nonbootable first-household rehearsal. Only a verified cold
// archive is accepted; only a fresh, internally allocated OS-temp copy is
// writable. No identity migration, routes, services, or activation.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {verifyOfflineLegacyTestSnapshot} from '../Server/private-phase1-legacy-snapshot-verification.mjs'
import {listPrivatePhase1LegacyDispositionRules} from '../Server/private-phase1-legacy-table-disposition-review.mjs'
import {comparePrivatePhase1SourceTriggerDefinitions} from '../Server/private-phase1-archive-trigger-source-parity.mjs'
import {inspectSourceShapedLegacyArchive} from './private-phase1-source-shaped-schema-parity.mjs'
import {installSourceShapedSyntheticLegacyBase,installSourceShapedSyntheticLegacyNotifications} from './private-phase1-source-shaped-legacy-schema.mjs'

const rules=listPrivatePhase1LegacyDispositionRules()
const keep=rules.filter(x=>x.disposition.startsWith('household-')).map(x=>x.table).sort()
const strip=['family_sessions','family_users','test_push_deliveries','test_push_subscriptions','capture_inbox']
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
const requireOk=(condition)=>{if(!condition)throw Error('Offline household rehearsal refused')}
const quote=n=>{requireOk(/^[a-z][a-z0-9_]*$/.test(n));return '"'+n+'"'}
const triggers=db=>db.prepare("SELECT name,tbl_name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all()
const names=db=>db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name)
const digest=file=>{
 const fd=fs.openSync(file,'r'), h=createHash('sha256'), buffer=Buffer.alloc(1024*1024)
 try{for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;h.update(buffer.subarray(0,n))}}
 finally{fs.closeSync(fd)}
 return h.digest('hex')
}
function check(db){
 requireOk(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok')
 requireOk(db.prepare('PRAGMA foreign_key_check').all().length===0)
}
function retainedRows(db){
 return keep.map(table=>{
  const h=createHash('sha256'),q=quote(table)
  const ddl=db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table).sql
  const query=db.prepare('SELECT rowid AS _phase1_rowid_, * FROM '+q+' ORDER BY rowid')
  query.setReadBigInts(true)
  let n=0
  for(const row of query.iterate()){
   requireOk(++n<=250000)
   h.update(JSON.stringify(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?['integer',v.toString()]:v instanceof Uint8Array?['blob',Buffer.from(v).toString('hex')]:[typeof v,v]]))+'\n')
  }
  return {table,ddl,n,digest:h.digest('hex')}
 })
}
function retainedObjects(db){
 return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('index','trigger','view') ORDER BY type,name").all().filter(x=>keep.includes(x.tbl_name))
}
function currentTrigger(){
 const ref=new DatabaseSync(':memory:')
 try{
  installSourceShapedSyntheticLegacyBase(ref)
  installSourceShapedSyntheticLegacyNotifications(ref)
  const rows=triggers(ref)
  requireOk(comparePrivatePhase1SourceTriggerDefinitions(rows).exactSourceMatches===14)
  return rows.find(x=>x.name==='notify_event_insert').sql
 }finally{ref.close()}
}
function uploads(root){
 const result=[]
 function walk(dir,relative,depth){
  requireOk(depth<=24)
  for(const x of fs.readdirSync(dir,{withFileTypes:true})){
   requireOk(!x.isSymbolicLink())
   const file=path.join(dir,x.name), rel=relative?relative+'/'+x.name:x.name
   if(x.isDirectory())walk(file,rel,depth+1)
   else{requireOk(x.isFile()&&result.length<20000);result.push([rel,digest(file)])}
  }
 }
 requireOk(fs.lstatSync(root).isDirectory()&&!fs.lstatSync(root).isSymbolicLink())
 walk(root,'',0)
 return result.sort((a,b)=>a[0].localeCompare(b[0],'en'))
}
function copyUploads(source,target,expected){
 fs.mkdirSync(target,{mode:0o700})
 for(const [relative] of expected){
  const from=path.join(source,...relative.split('/')),to=path.join(target,...relative.split('/'))
  fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o700})
  fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL)
 }
 requireOk(same(uploads(target),expected)&&same(uploads(source),expected))
}
export function rehearseOfflineHouseholdCopy(args){
 const verified=verifyOfflineLegacyTestSnapshot(args)
 const parity=inspectSourceShapedLegacyArchive(args)
 requireOk(parity.structuralMatches===27&&parity.exactExplicitIndexDdlMatches===27&&
  parity.details.every(d=>d.ddlReview.checkExpressionTokensMatch&&['EXACT','LEXICAL_MATCH','DECLARATION_REORDER_ONLY','REVIEWED_REFERENCE_PLACEMENT_ONLY'].includes(d.ddlReview.classification)))
 const source=path.join(args.snapshotRoot,'calendar.db'),sourceHash=digest(source)
 const sourceUploads=path.join(args.snapshotRoot,'uploads'),uploadList=uploads(sourceUploads)
 requireOk(uploadList.length===verified.uploadFiles)
 const temp=fs.realpathSync(os.tmpdir()),work=fs.mkdtempSync(path.join(temp,'fc-phase1-offline-rehearsal-'))
 let result
 try{
  const dest=path.join(work,'calendar.db')
  fs.copyFileSync(source,dest,fs.constants.COPYFILE_EXCL)
  requireOk(digest(dest)===sourceHash)
  const db=new DatabaseSync(dest)
  try{
   db.exec('PRAGMA foreign_keys=ON')
   check(db)
   requireOk(same(names(db),rules.map(x=>x.table).sort()))
   requireOk(db.prepare('SELECT COUNT(*) AS n FROM family_users').get().n===1)
   requireOk(db.prepare('SELECT COUNT(*) AS n FROM capture_inbox').get().n===0)
   requireOk(keep.length===22)
   for(const table of keep)requireOk(db.prepare('PRAGMA foreign_key_list('+quote(table)+')').all().every(f=>keep.includes(f.table)))
   const initial=comparePrivatePhase1SourceTriggerDefinitions(triggers(db))
   requireOk(initial.exactSourceMatches===13&&initial.knownDefinitionDrift===1&&initial.eventInsertDriftClassification==='EXACT_PRE_REUSE_CLEANUP_DEFINITION')
   const rows=retainedRows(db),objects=retainedObjects(db),newSql=currentTrigger()
   requireOk(objects.filter(x=>x.type==='trigger'&&x.name==='notify_event_insert').length===1)
   const expected=objects.map(x=>x.type==='trigger'&&x.name==='notify_event_insert'?{...x,sql:newSql}:x)
   db.exec('PRAGMA secure_delete=ON')
   db.exec('PRAGMA foreign_keys=OFF')
   db.exec('BEGIN IMMEDIATE')
   try{
    db.exec('DROP TRIGGER notify_event_insert')
    db.exec(newSql)
    for(const table of strip)db.exec('DROP TABLE '+quote(table))
    requireOk(same(names(db),keep)&&same(retainedRows(db),rows)&&same(retainedObjects(db),expected))
    db.exec('COMMIT')
   }catch(e){db.exec('ROLLBACK');throw e}
   db.exec('PRAGMA foreign_keys=ON')
   db.exec('VACUUM')
   check(db)
   requireOk(db.prepare('PRAGMA freelist_count').get().freelist_count===0)
   requireOk(same(names(db),keep)&&same(retainedRows(db),rows)&&same(retainedObjects(db),expected))
   requireOk(comparePrivatePhase1SourceTriggerDefinitions(triggers(db)).exactSourceMatches===14)
   result={preservedTables:rows.length,preservedRows:rows.reduce((n,x)=>n+x.n,0),currentTriggers:14,
    excludedTables:strip.length,uploads:uploadList.length,
    notices:db.prepare('SELECT COUNT(*) AS n FROM assignment_notification_outbox').get().n,
    acknowledgements:db.prepare('SELECT COUNT(*) AS n FROM test_assignment_acknowledgements').get().n,
    archiveUnchanged:false,temporaryCopyRemoved:false,identityMigrationExecuted:false,
    actualTestMigrationExecuted:false,testDeploymentAuthorized:false,liveDeploymentAuthorized:false}
  }finally{db.close()}
  copyUploads(sourceUploads,path.join(work,'uploads'),uploadList)
  requireOk(digest(source)===sourceHash&&same(uploads(sourceUploads),uploadList))
  requireOk(verifyOfflineLegacyTestSnapshot(args).result==='PASS')
  result.archiveUnchanged=true
 }finally{
  // Only the unique directory allocated by this invocation; no outputs
  // survive for accidental deployment. Deletion is not forensic erasure.
  fs.rmSync(work,{recursive:true,force:true})
 }
 return {...result,temporaryCopyRemoved:!fs.existsSync(work)}
}
