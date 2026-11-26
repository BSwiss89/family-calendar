// Read-only startup preflight for an inactive Phase 1 migration stage.
// No account changes, task installation, route changes or hold removal.
// Local hashes detect drift, not a malicious replacement of all receipts.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {verifyOfflinePrivateRestoreSet} from './private-restore-preflight.mjs'
import {verifyOfflineLegacyTestSnapshot} from './private-phase1-legacy-snapshot-verification.mjs'

const SHA=/^[a-f0-9]{40}$/
const HASH=/^[a-f0-9]{64}$/
const SNAP=/^OFFLINE-LEGACY-TEST-\d{8}-\d{6}-[a-f0-9]{32}$/
function requireOk(v){if(!v)throw Error('Phase 1 inactive stage startup preflight refused.')}
function directory(p){
 requireOk(typeof p==='string'&&path.isAbsolute(p))
 const s=fs.lstatSync(p)
 requireOk(s.isDirectory()&&!s.isSymbolicLink())
 return fs.realpathSync(p)
}
function file(p){
 const s=fs.lstatSync(p)
 requireOk(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1)
 return p
}
function digest(p){
 const fd=fs.openSync(file(p),'r'),h=createHash('sha256'),buf=Buffer.alloc(1024*1024)
 try{for(;;){const n=fs.readSync(fd,buf,0,buf.length,null);if(!n)break;h.update(buf.subarray(0,n))}}
 finally{fs.closeSync(fd)}
 return h.digest('hex')
}
function json(p){
 requireOk(fs.statSync(file(p)).size<=12*1024*1024)
 return JSON.parse(fs.readFileSync(p,'utf8'))
}
function exact(root,names){requireOk(JSON.stringify(fs.readdirSync(root).sort())===JSON.stringify([...names].sort()))}
function under(a,b){const r=path.relative(a,b);return r!==''&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r)}
function checkTree(root,depth=0){
 requireOk(depth<=28)
 for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  const p=path.join(root,entry.name)
  requireOk(!entry.isSymbolicLink()&&under(root,fs.realpathSync(p)))
  if(entry.isDirectory())checkTree(directory(p),depth+1)
  else file(p)
 }
}
export function reviewInactivePhase1TestStage({serverDirectory,destinationParent,scope,expectedCandidateSha,expectedInstalledTestSha,expectedArchiveName,expectedManifestSha256}={}){
 requireOk(SHA.test(expectedCandidateSha??'')&&SHA.test(expectedInstalledTestSha??'')&&SNAP.test(expectedArchiveName??'')&&HASH.test(expectedManifestSha256??''))
 const parent=directory(destinationParent)
 if(scope==='disposable-test-fixture'){
  requireOk(under(directory(os.tmpdir()),parent)&&path.basename(parent).startsWith('fc-phase1-archive-test-'))
 }else requireOk(scope==='windows-inactive-stage'&&process.platform==='win32'&&parent===directory(path.join(os.homedir(),'Projects')))
 const root=directory(path.join(parent,'family-calendar-phase1-test-data'))
 requireOk(path.dirname(root)===parent)
 exact(root,['data','DO-NOT-START.json','INACTIVE-STAGE-REVIEW.json','COORDINATED-BACKUP-ATTESTATION.json'])
 checkTree(root)
 const holdFile=path.join(root,'DO-NOT-START.json'),reviewFile=path.join(root,'INACTIVE-STAGE-REVIEW.json'),attestationFile=path.join(root,'COORDINATED-BACKUP-ATTESTATION.json')
 const original=[holdFile,reviewFile,attestationFile].map(digest)
 const hold=json(holdFile),review=json(reviewFile),attestation=json(attestationFile)
 requireOk(hold.kind==='phase1-inactive-test-stage-hold-v1'&&hold.automaticStartupAllowed===false&&hold.accountActivationAuthorized===false&&hold.testDeploymentAuthorized===false&&hold.liveDeploymentAuthorized===false)
 requireOk(review.kind==='phase1-inactive-test-migration-stage-v1'&&review.scope===scope&&review.candidateSha===expectedCandidateSha&&review.installedTestSha===expectedInstalledTestSha&&review.sourceArchiveName===expectedArchiveName&&review.sourceManifestSha256===expectedManifestSha256&&HASH.test(review.sourceDatabaseSha256??'')&&review.coordinatedAttestationSha256===attestation.sha256&&review.households===1&&review.ownerDisabled===true&&review.sessionsImported===0&&review.hostWriterFenceVerified===false&&review.accountActivationAuthorized===false&&review.testDeploymentAuthorized===false&&review.liveDeploymentAuthorized===false)
 const recoveryParent=directory(path.join(parent,'family-calendar-phase1-recovery'))
 const snapshotRoot=directory(path.join(recoveryParent,expectedArchiveName))
 const args={recoveryParent,snapshotRoot,expectedInstalledTestSha}
 requireOk(verifyOfflineLegacyTestSnapshot(args).result==='PASS')
 requireOk(digest(path.join(snapshotRoot,'OFFLINE-LEGACY-REVIEW.json'))===expectedManifestSha256&&digest(path.join(snapshotRoot,'calendar.db'))===review.sourceDatabaseSha256)
 const data=directory(path.join(root,'data'))
 const checked=verifyOfflinePrivateRestoreSet({serverDirectory,restoreRoot:data},attestation)
 requireOk(checked.ok&&checked.households===1&&checked.files===review.files&&JSON.stringify(attestation.households)===JSON.stringify(['primary-family']))
 const central=new DatabaseSync(path.join(data,'central','identity.db'),{readOnly:true})
 const legacy=new DatabaseSync(path.join(snapshotRoot,'calendar.db'),{readOnly:true})
 try{
  const old=legacy.prepare('SELECT id,username,display_name,password_hash,account_kind,disabled FROM family_users').all()
  const staged=central.prepare('SELECT id,username,display_name,password_hash,account_kind,disabled FROM family_users').all()
  requireOk(old.length===1&&old[0].disabled===0&&staged.length===1&&JSON.stringify(staged[0])===JSON.stringify({...old[0],disabled:1}))
  const homes=central.prepare('SELECT id,storage_id,disabled FROM household_registry').all()
  const memberships=central.prepare('SELECT user_id,household_id,role,disabled FROM household_memberships').all()
  requireOk(homes.length===1&&homes[0].storage_id==='primary-family'&&homes[0].disabled===1&&memberships.length===1&&memberships[0].user_id===old[0].id&&memberships[0].household_id===homes[0].id&&memberships[0].role==='owner'&&memberships[0].disabled===1)
  for(const table of ['family_sessions','household_session_selections'])requireOk(central.prepare('SELECT COUNT(*) AS n FROM '+table).get().n===0)
 }finally{legacy.close();central.close()}
 requireOk(verifyOfflinePrivateRestoreSet({serverDirectory,restoreRoot:data},attestation).ok)
 requireOk(verifyOfflineLegacyTestSnapshot(args).result==='PASS'&&digest(path.join(snapshotRoot,'OFFLINE-LEGACY-REVIEW.json'))===expectedManifestSha256&&digest(path.join(snapshotRoot,'calendar.db'))===review.sourceDatabaseSha256)
 requireOk(JSON.stringify([holdFile,reviewFile,attestationFile].map(digest))===JSON.stringify(original))
 return Object.freeze({kind:'phase1-inactive-stage-startup-preflight-v1',result:'PASS',archiveAndStageVerified:true,ownerCredentialContinuityVerified:true,ownerDisabled:true,oldSessionsImported:0,households:1,files:checked.files,durableStartupHoldPresent:true,windowsAclVerified:false,hostWriterFenceVerified:false,stageFreshnessComparedToInstalledTest:false,accountActivationAuthorized:false,stageStartupAuthorized:false,testDeploymentAuthorized:false,liveDeploymentAuthorized:false,filesOrServicesModified:false})
}
