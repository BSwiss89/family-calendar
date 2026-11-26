// Rehearse central Owner staging only in SQLite memory. No persistent
// identity DB, password entry, login session, account activation, or network.
// Historical credentials never leave the local process or appear in receipts.
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {createHouseholdMembershipTables,getSoleActiveHouseholdOwner,listGrantedHouseholdsForSessionUser,lookupGrantedHouseholdForSessionUser} from '../Server/household-memberships.mjs'
import {verifyOfflineLegacyTestSnapshot} from '../Server/private-phase1-legacy-snapshot-verification.mjs'
import {inspectSourceShapedLegacyArchive} from './private-phase1-source-shaped-schema-parity.mjs'
const requireOk=v=>{if(!v)throw Error('Offline central Owner rehearsal refused')}
const count=(db,table)=>db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n
const healthy=db=>db.prepare('PRAGMA integrity_check').get().integrity_check==='ok'&&db.prepare('PRAGMA foreign_key_check').all().length===0
export function rehearseOfflineCentralOwner(args){
 const first=verifyOfflineLegacyTestSnapshot(args)
 const parity=inspectSourceShapedLegacyArchive(args)
 requireOk(parity.structuralMatches===27&&parity.exactExplicitIndexDdlMatches===27&&
  parity.details.every(d=>d.ddlReview.checkExpressionTokensMatch&&['EXACT','LEXICAL_MATCH','DECLARATION_REORDER_ONLY','REVIEWED_REFERENCE_PLACEMENT_ONLY'].includes(d.ddlReview.classification)))
 const old=new DatabaseSync(path.join(args.snapshotRoot,'calendar.db'),{readOnly:true})
 let central,result
 try{
  old.exec('PRAGMA query_only=ON')
  const owners=old.prepare('SELECT id,username,display_name,password_hash,account_kind,disabled FROM family_users').all()
  requireOk(owners.length===1)
  const owner=owners[0]
  requireOk(Number.isSafeInteger(owner.id)&&owner.id>0&&typeof owner.username==='string'&&
   /^[a-z0-9._-]{3,40}$/.test(owner.username)&&typeof owner.display_name==='string'&&
   owner.display_name.trim().length>0&&owner.display_name.length<=80&&
   /^scrypt-v1:[a-f0-9]{32}:[a-f0-9]{128}$/.test(owner.password_hash)&&
   owner.account_kind==='person'&&owner.disabled===0)
  const savedSessions=count(old,'family_sessions')
  central=new DatabaseSync(':memory:')
  central.exec('PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON')
  createHouseholdMembershipTables(central)
  requireOk(central.prepare('PRAGMA database_list').all().every(x=>x.file===''))
  central.exec('BEGIN IMMEDIATE')
  try{
   central.prepare('INSERT INTO family_users(id,username,display_name,password_hash,account_kind,disabled) VALUES(?,?,?,?,?,1)')
    .run(owner.id,owner.username,owner.display_name,owner.password_hash,'person')
   central.prepare("INSERT INTO household_registry(storage_id,display_name,disabled) VALUES('primary-family','Inactive rehearsal household',1)").run()
   const household=central.prepare("SELECT id FROM household_registry WHERE storage_id='primary-family'").get()
   central.prepare("INSERT INTO household_memberships(user_id,household_id,role,disabled) VALUES(?,?,'owner',1)").run(owner.id,household.id)
   const staged=central.prepare('SELECT id,username,display_name,password_hash,account_kind,disabled FROM family_users').get()
   requireOk(staged.id===owner.id&&staged.username===owner.username&&staged.display_name===owner.display_name&&
    staged.password_hash===owner.password_hash&&staged.account_kind===owner.account_kind&&staged.disabled===1)
   requireOk(count(central,'family_users')===1&&count(central,'household_registry')===1&&count(central,'household_memberships')===1&&
    count(central,'family_sessions')===0&&count(central,'household_session_selections')===0)
   requireOk(getSoleActiveHouseholdOwner(central,'primary-family')===null&&
    listGrantedHouseholdsForSessionUser(central,{serverVerifiedUserId:owner.id}).length===0&&
    lookupGrantedHouseholdForSessionUser(central,{serverVerifiedUserId:owner.id,requestedHouseholdId:'primary-family'})===null&&healthy(central))
   central.exec('COMMIT')
  }catch(e){central.exec('ROLLBACK');throw e}
  result={stagedDisabledOwners:1,stagedDisabledHouseholds:1,stagedDisabledMemberships:1,
   archivedSessionsNotImported:savedSessions,centralSessions:0,centralSelections:0,ownerAccessDenied:true,
   credentialFormatAndExactTransferVerified:true,passwordOwnershipVerified:false,persistentIdentityCreated:false,
   actualTestMigrationExecuted:false,testDeploymentAuthorized:false,liveDeploymentAuthorized:false}
 }finally{if(central)central.close();old.close()}
 const last=verifyOfflineLegacyTestSnapshot(args)
 requireOk(first.fileCount===last.fileCount&&first.sourceSha===last.sourceSha)
 return {...result,archiveUnchanged:true,memoryDatabaseClosed:true}
}
