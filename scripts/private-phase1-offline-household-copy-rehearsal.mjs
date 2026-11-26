// Offline, nonbootable first-household rehearsal. Only a verified cold
// archive is accepted; only a fresh, internally allocated OS-temp copy is
// writable. No identity migration, routes, services, or activation.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHash,randomBytes} from 'node:crypto'
import {setFamilyAccount} from '../Server/family-auth.mjs'
import {verifyOfflineCentralOwnerPassword} from './private-phase1-offline-central-owner-rehearsal.mjs'
import {createPrivateActivationRecords} from '../Server/private-household-activation-records.mjs'
import {createIndependentHouseholdInvitationTables} from '../Server/independent-household-invitations.mjs'
import {planReviewedPrivateTestStartup} from '../Server/private-reviewed-test-startup-plan.mjs'
import {DatabaseSync} from 'node:sqlite'
import {fileURLToPath} from 'node:url'
import {createHouseholdMembershipTables,getSoleActiveHouseholdOwner,listGrantedHouseholdsForSessionUser} from '../Server/household-memberships.mjs'
import {createEventShareTables} from '../Server/event-only-shares.mjs'
import {createEventShareSyncJournal} from '../Server/event-share-sync-journal.mjs'
import {preparePhase1OfflineArchiveCopyNotices} from '../Server/private-phase1-disposable-primary-conversion.mjs'
import {captureDisposableCoordinatedHouseholdSnapshot} from '../Server/private-disposable-coordinated-snapshot.mjs'
import {copyVerifiedPrivateRestoreSet} from '../Server/private-offline-restore-rehearsal.mjs'
import {verifyOfflinePrivateRestoreSet} from '../Server/private-restore-preflight.mjs'
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
  const query=db.prepare('SELECT * FROM '+q)
  const fingerprints=[]
  query.setReadBigInts(true)
  let n=0
  for(const row of query.iterate()){
   requireOk(++n<=250000)
   fingerprints.push(createHash('sha256').update(JSON.stringify(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?['integer',v.toString()]:v instanceof Uint8Array?['blob',Buffer.from(v).toString('hex')]:[typeof v,v]]))).digest('hex'))
  }
  // VACUUM may renumber implicit rowids. Compare the typed row multiset,
  // including duplicate multiplicities and explicit keys, not page layout.
  for(const fingerprint of fingerprints.sort())h.update(fingerprint+'\n')
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
function rehearse(args,coordinated,startupProof=null){
 const verified=verifyOfflineLegacyTestSnapshot(args)
 const parity=inspectSourceShapedLegacyArchive(args)
 requireOk(parity.structuralMatches===27&&parity.exactExplicitIndexDdlMatches===27&&
  parity.details.every(d=>d.ddlReview.checkExpressionTokensMatch&&['EXACT','LEXICAL_MATCH','DECLARATION_REORDER_ONLY','REVIEWED_REFERENCE_PLACEMENT_ONLY'].includes(d.ddlReview.classification)))
 const manifest=path.join(args.snapshotRoot,'OFFLINE-LEGACY-REVIEW.json'),manifestHash=digest(manifest)
 const source=path.join(args.snapshotRoot,'calendar.db'),sourceHash=digest(source)
 if(startupProof)requireOk(startupProof.manifestHash===manifestHash&&startupProof.sourceHash===sourceHash)
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
   const oldTrigger=initial.exactSourceMatches===13&&initial.knownDefinitionDrift===1&&initial.eventInsertDriftClassification==='EXACT_PRE_REUSE_CLEANUP_DEFINITION'
   const current=initial.exactSourceMatches===14&&initial.knownDefinitionDrift===0&&initial.eventInsertDriftClassification==='EXACT_CURRENT_DEFINITION'
   requireOk(oldTrigger||(coordinated&&current))
   requireOk(initial.missingKnownSource===0&&initial.archivedTriggersWithoutCurrentSourceDefinition===0)
   const rows=retainedRows(db),objects=retainedObjects(db),newSql=currentTrigger()
   requireOk(objects.filter(x=>x.type==='trigger'&&x.name==='notify_event_insert').length===1)
   const expected=objects.map(x=>x.type==='trigger'&&x.name==='notify_event_insert'?{...x,sql:newSql}:x)
   db.exec('PRAGMA secure_delete=ON')
   db.exec('PRAGMA foreign_keys=OFF')
   db.exec('BEGIN IMMEDIATE')
   try{
    if(oldTrigger){db.exec('DROP TRIGGER notify_event_insert');db.exec(newSql)}
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
  if(coordinated){
   result={...result,...rehearseCoordinatedCopy({source,work,uploadList,startupProof})}
  }
  requireOk(digest(source)===sourceHash&&digest(manifest)===manifestHash&&same(uploads(sourceUploads),uploadList))
  requireOk(verifyOfflineLegacyTestSnapshot(args).result==='PASS')
  result.archiveUnchanged=true
 }finally{
  // Only the unique directory allocated by this invocation; no outputs
  // survive for accidental deployment. Deletion is not forensic erasure.
  fs.rmSync(work,{recursive:true,force:true})
 }
 return {...result,temporaryCopyRemoved:!fs.existsSync(work)}
}

export function rehearseOfflineHouseholdCopy(args){return rehearse(args,false)}

// The ONLY new writable files are descendants of the internally created
// disposable work root. Both coordinated snapshots and restored copies are
// removed with that root. No server starts and no credential is returned.
export function rehearseOfflineCoordinatedPrimaryFamily(args){return rehearse(args,true)}


// A successful password proof must refer to exactly the archive being split.
// No caller-supplied boolean can activate a copy. Only this local wrapper can
// request the disposable startup-plan exercise; no backend or listener starts.
export async function rehearseOfflineCoordinatedPrimaryStartupPlan(args,password){
 const manifest=path.join(args.snapshotRoot,'OFFLINE-LEGACY-REVIEW.json')
 const source=path.join(args.snapshotRoot,'calendar.db')
 verifyOfflineLegacyTestSnapshot(args)
 const startupProof={manifestHash:digest(manifest),sourceHash:digest(source)}
 const proof=await verifyOfflineCentralOwnerPassword(args,password)
 password=undefined
 requireOk(proof.passwordOwnershipVerified&&proof.archiveUnchanged&&!proof.accountActivationAuthorized&&
  digest(manifest)===startupProof.manifestHash&&digest(source)===startupProof.sourceHash)
 return rehearse(args,true,startupProof)
}

function rehearseCoordinatedCopy({source,work,uploadList,startupProof}){
 const serverDirectory=fileURLToPath(new URL('../Server/',import.meta.url))
 const old=new DatabaseSync(source,{readOnly:true})
 let owner,oldSessions
 try{
  old.exec('PRAGMA query_only=ON')
  const rows=old.prepare('SELECT id,username,display_name,password_hash,account_kind,disabled FROM family_users').all()
  requireOk(rows.length===1)
  owner=rows[0]
  requireOk(Number.isSafeInteger(owner.id)&&owner.id>0&&typeof owner.username==='string'&&
   /^[a-z0-9._-]{3,40}$/.test(owner.username)&&typeof owner.display_name==='string'&&
   owner.display_name.trim().length>0&&owner.display_name.length<=80&&
   /^scrypt-v1:[a-f0-9]{32}:[a-f0-9]{128}$/.test(owner.password_hash)&&
   owner.account_kind==='person'&&owner.disabled===0)
  oldSessions=old.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n
 }finally{old.close()}
 const notice=preparePhase1OfflineArchiveCopyNotices(work)
 const staged=path.join(work,'staged'),home=path.join(staged,'households','primary-family')
 fs.mkdirSync(path.join(staged,'central'),{recursive:true,mode:0o700})
 fs.mkdirSync(path.join(home,'data'),{recursive:true,mode:0o700})
 fs.renameSync(path.join(work,'calendar.db'),path.join(home,'data','calendar.db'))
 fs.renameSync(path.join(work,'uploads'),path.join(home,'uploads'))
 fs.writeFileSync(path.join(home,'.family-calendar-household.json'),JSON.stringify({schemaVersion:1,householdId:'primary-family'})+'\n',{flag:'wx',mode:0o600})
 const centralFile=path.join(staged,'central','identity.db')
 const central=new DatabaseSync(centralFile)
 try{
  central.exec('PRAGMA foreign_keys=ON')
  createHouseholdMembershipTables(central)
  createEventShareTables(central)
  createEventShareSyncJournal(central)
  central.exec('BEGIN IMMEDIATE')
  try{
   central.prepare('INSERT INTO family_users(id,username,display_name,password_hash,account_kind,disabled) VALUES(?,?,?,?,?,1)').run(owner.id,owner.username,owner.display_name,owner.password_hash,'person')
   central.prepare("INSERT INTO household_registry(storage_id,display_name,disabled) VALUES('primary-family','Inactive rehearsal household',1)").run()
   const h=central.prepare("SELECT id FROM household_registry WHERE storage_id='primary-family'").get()
   central.prepare("INSERT INTO household_memberships(user_id,household_id,role,disabled) VALUES(?,?,'owner',1)").run(owner.id,h.id)
   check(central)
   central.exec('COMMIT')
  }catch(e){central.exec('ROLLBACK');throw e}
 }finally{central.close()}
 const baseline=captureDisposableCoordinatedHouseholdSnapshot({serverDirectory,sourceRoot:staged,destinationRoot:path.join(work,'snapshot')})
 const restored=path.join(work,'restored')
 copyVerifiedPrivateRestoreSet({serverDirectory,sourceRoot:baseline.snapshotRoot,destinationRoot:restored,approvedAttestation:baseline.attestation})
 requireOk(verifyOfflinePrivateRestoreSet({serverDirectory,restoreRoot:restored},baseline.attestation).ok===true)
 const restoredCentral=new DatabaseSync(path.join(restored,'central','identity.db'),{readOnly:true})
 try{
  check(restoredCentral)
  const stagedOwner=restoredCentral.prepare('SELECT id,username,display_name,password_hash,account_kind,disabled FROM family_users').all()
  requireOk(stagedOwner.length===1&&same(stagedOwner[0],{...owner,disabled:1}))
  requireOk(restoredCentral.prepare('SELECT COUNT(*) AS n FROM household_registry WHERE disabled=1').get().n===1&&
   restoredCentral.prepare("SELECT COUNT(*) AS n FROM household_memberships WHERE role='owner' AND disabled=1").get().n===1&&
   restoredCentral.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n===0&&
   restoredCentral.prepare('SELECT COUNT(*) AS n FROM household_session_selections').get().n===0&&
   getSoleActiveHouseholdOwner(restoredCentral,'primary-family')===null&&
   listGrantedHouseholdsForSessionUser(restoredCentral,{serverVerifiedUserId:owner.id}).length===0)
 }finally{restoredCentral.close();owner=undefined}
 const restoredHome=path.join(restored,'households','primary-family')
 const family=new DatabaseSync(path.join(restoredHome,'data','calendar.db'),{readOnly:true})
 let events
 try{
  check(family)
  const tables=names(family)
  requireOk(strip.every(table=>!tables.includes(table))&&keep.every(table=>tables.includes(table)))
  events=family.prepare('SELECT COUNT(*) AS n FROM events').get().n
  requireOk(family.prepare('SELECT COUNT(*) AS n FROM notification_dirty_events').get().n===0)
  requireOk(family.prepare('SELECT COUNT(*) AS n FROM events WHERE event_uid IS NULL').get().n===0)
 }finally{family.close()}
 requireOk(same(uploads(path.join(restoredHome,'uploads')),uploadList))
 const startup=startupProof?rehearseStartupPlan({work,restored,serverDirectory}):null
 return {...(startup?{startupPlanRehearsal:startup}:{}),coordinatedArchiveCopyVerified:true,coordinatedSnapshotFiles:baseline.fileCount,
  restoredHouseholds:baseline.householdCount,permanentEventIdentities:events,
  oldSessionsNotImported:oldSessions,centralSessions:0,centralSelections:0,
  restoredOwnerDisabled:true,ownerAccessDenied:true,notificationPreparation:notice,
  identityMigrationExecuted:true,persistentIdentityCreated:false,
  installedCalendarsAccessed:false,backendBooted:false,
  actualTestMigrationExecuted:false,testDeploymentAuthorized:false,liveDeploymentAuthorized:false}
}

// Only inside the unique work directory allocated by rehearse(). The
// independently verified inactive backup stays unchanged. This is a
// temporary planning copy, not persistent account activation.
function rehearseStartupPlan({work,restored,serverDirectory}){
 const centralDir=path.join(restored,'central')
 const identity=path.join(work,'startup-identity.db')
 const state=path.join(work,'startup-state')
 fs.copyFileSync(path.join(centralDir,'identity.db'),identity,fs.constants.COPYFILE_EXCL)
 fs.mkdirSync(state,{mode:0o700})
 const db=new DatabaseSync(identity)
 try{
  db.exec('PRAGMA foreign_keys=ON')
  createIndependentHouseholdInvitationTables(db)
  createPrivateActivationRecords(db)
  const options={identityDatabase:db,serverDirectory,storageRoot:restored,stateDirectory:state,primaryHouseholdId:'primary-family'}
  let denied=false
  try{planReviewedPrivateTestStartup(options)}catch{denied=true}
  requireOk(denied)
  const owner=db.prepare('SELECT id,username FROM family_users WHERE disabled=1').get()
  requireOk(owner&&db.prepare('SELECT COUNT(*) AS n FROM family_users').get().n===1)
  const op='rehearsal-'+randomBytes(10).toString('hex')
  requireOk(op!==owner.username)
  db.exec('BEGIN IMMEDIATE')
  try{
   setFamilyAccount(db,op,'Temporary rehearsal operator',randomBytes(32).toString('hex'))
   const operator=db.prepare('SELECT id FROM family_users WHERE username=?').get(op)
   requireOk(operator.id!==owner.id)
   requireOk(db.prepare('UPDATE family_users SET disabled=0 WHERE id=? AND disabled=1').run(owner.id).changes===1)
   requireOk(db.prepare("UPDATE household_registry SET disabled=0 WHERE storage_id='primary-family' AND disabled=1").run().changes===1)
   requireOk(db.prepare("UPDATE household_memberships SET disabled=0 WHERE user_id=? AND role='owner' AND disabled=1").run(owner.id).changes===1)
   requireOk(getSoleActiveHouseholdOwner(db,'primary-family')===owner.id)
   requireOk(db.prepare('SELECT COUNT(*) AS n FROM household_memberships WHERE user_id=?').get(operator.id).n===0)
   check(db)
   db.exec('COMMIT')
  }catch(e){db.exec('ROLLBACK');throw e}
  const plan=planReviewedPrivateTestStartup(options)
  requireOk(plan.householdCount===1&&same(plan.householdIds,['primary-family'])&&plan.planVerifiedReadOnly&&!plan.deploymentAuthorized)
  requireOk(db.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n===0&&
    db.prepare('SELECT COUNT(*) AS n FROM household_session_selections').get().n===0)
  const original=new DatabaseSync(path.join(centralDir,'identity.db'),{readOnly:true})
  try{requireOk(original.prepare('SELECT COUNT(*) AS n FROM family_users WHERE disabled=1').get().n===1&&
    getSoleActiveHouseholdOwner(original,'primary-family')===null)}finally{original.close()}
  return {archivedOwnerPasswordVerified:true,inactiveStartupDenied:true,
    disposableOwnerActivationRehearsed:true,separateTemporaryOperator:true,
    plannedHouseholds:1,centralSessions:0,centralSelections:0,
    originalRestoredOwnerStillDisabled:true,backendBooted:false,
    persistentAccountActivated:false,testDeploymentAuthorized:false}
 }finally{db.close()}
}
