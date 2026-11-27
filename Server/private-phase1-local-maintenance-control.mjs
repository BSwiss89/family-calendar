// Trusted filesystem-only maintenance channel. No HTTP route, scheduler
// mutation, arbitrary destination, force-kill or automatic restart.
import fs from 'node:fs'
import path from 'node:path'
import {createHash,randomBytes} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {verifyOfflinePrivateRestoreSet} from './private-restore-preflight.mjs'
import {digestClosedPhase1Source} from './private-phase1-supervised-backup.mjs'
import {planReviewedPrivateTestStartup} from './private-reviewed-test-startup-plan.mjs'
const INSTANCE='.family-calendar-reviewed-supervisor-instance.lock'
const HOLD='MAINTENANCE-REVIEW'
const sha=x=>createHash('sha256').update(x).digest('hex')
function need(v){if(!v)throw Error('Phase 1 local maintenance control refused.')}
function physical(p){const s=fs.lstatSync(p);need(s.isDirectory()&&!s.isSymbolicLink());return fs.realpathSync(p)}
function present(p){try{fs.lstatSync(p);return true}catch(e){if(e.code==='ENOENT')return false;throw e}}
function read(p){const s=fs.lstatSync(p);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=16384);return fs.readFileSync(p,'utf8')}
function instance(root){
 const state=physical(path.join(root,'supervisor-state'));need(path.dirname(state)===root)
 const raw=read(path.join(state,INSTANCE)),r=JSON.parse(raw)
 need(r.schemaVersion===1&&r.type==='reviewed-multifamily-supervisor-instance'&&/^[a-f0-9]{64}$/.test(r.nonce??'')&&Number.isSafeInteger(r.pid)&&r.pid>0)
 return {digest:sha(raw),pid:r.pid}
}
function write(p,r){const fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(r)+'\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
export function assertLocalMaintenanceClear(root){
 root=physical(root)
 need(!present(path.join(root,HOLD)))
}
export function createLocalBackupStopRequest(root){
 root=physical(root)
 const i=instance(root)
 const hold=path.join(root,HOLD)
 // Exclusive reservation is itself a durable startup block. If publishing
 // the request fails, leave the reservation for manual review.
 fs.mkdirSync(hold,{mode:0o700})
 const request={kind:'phase1-backup-stop-request-v1',id:randomBytes(16).toString('hex'),instanceSha256:i.digest,createdAt:Date.now()}
 write(path.join(hold,'request.tmp'),request)
 fs.renameSync(path.join(hold,'request.tmp'),path.join(hold,'REQUEST.json'))
 need(instance(root).digest===i.digest)
 return Object.freeze({requestId:request.id,backupStopRequested:true,restartBlocked:true,testDeploymentAuthorized:false})
}
export function readLocalBackupStopRequest(root){
 root=physical(root)
 const hold=path.join(root,HOLD)
 if(!present(hold))return null
 need(physical(hold)===hold)
 const file=path.join(hold,'REQUEST.json')
 if(!present(file))return null // reservation not yet published
 need(!present(path.join(hold,'RECEIPT.json'))&&!present(path.join(hold,'IN-PROGRESS.json')))
 const raw=read(file),r=JSON.parse(raw),i=instance(root)
 need(r.kind==='phase1-backup-stop-request-v1'&&/^[a-f0-9]{32}$/.test(r.id??'')&&r.instanceSha256===i.digest&&i.pid===process.pid&&Number.isSafeInteger(r.createdAt)&&r.createdAt<=Date.now()+5000&&Date.now()-r.createdAt<=300000)
 write(path.join(hold,'IN-PROGRESS.json'),{kind:'phase1-backup-stop-in-progress-v1',requestId:r.id})
 return Object.freeze({requestId:r.id,requestHash:sha(raw)})
}
export function completeLocalBackupStopRequest(root,request,receipt){
 root=physical(root)
 const hold=path.join(root,HOLD)
 need(physical(hold)===hold)
 need(!present(path.join(hold,'RECEIPT.json'))&&!present(path.join(hold,'RECEIPT.tmp')))
 const raw=read(path.join(hold,'REQUEST.json')),r=JSON.parse(raw)
 const progress=JSON.parse(read(path.join(hold,'IN-PROGRESS.json')))
 need(sha(raw)===request.requestHash&&r.id===request.requestId&&progress.requestId===r.id&&receipt.coordinatedBackupVerified===true&&receipt.allChildrenExited===true&&receipt.gatewayClosed===true&&receipt.ownerInstanceReleased===true&&receipt.restoreAuthorized===false&&receipt.automaticRestartAllowed===false&&/^backup-[0-9]{14}-[a-f0-9]{32}$/.test(receipt.backupName??'')&&Number.isSafeInteger(receipt.households)&&receipt.households>0&&Number.isSafeInteger(receipt.files)&&receipt.files>0)
 need(/^[a-f0-9]{64}$/.test(receipt.sourceDigest??'')&&/^[a-f0-9]{64}$/.test(receipt.attestationSha256??''))
 const state=physical(path.join(root,'supervisor-state'))
 need(!present(path.join(state,INSTANCE)))
 write(path.join(hold,'RECEIPT.tmp'),{kind:'phase1-backup-stop-receipt-v1',requestId:r.id,backupName:receipt.backupName,households:receipt.households,files:receipt.files,sourceDigest:receipt.sourceDigest,attestationSha256:receipt.attestationSha256,result:'PASS',restartBlocked:true,testDeploymentAuthorized:false})
 fs.renameSync(path.join(hold,'RECEIPT.tmp'),path.join(hold,'RECEIPT.json'))
 // Deliberately retain the complete maintenance hold. A separate reviewed
 // resume must check the backup, task state, route and all writer locks.
}


// Read-only review of the completed local backup and original stopped
// databases. No recovery/restore, automatic release or task authority.
export function reviewLocalMaintenanceResume({root,storageRoot,identityDatabasePath,serverDirectory,primaryHouseholdId,expectedRequestId}){
 root=physical(root)
 const hold=physical(path.join(root,HOLD))
 need(path.dirname(hold)===root)
 need(JSON.stringify(fs.readdirSync(hold).sort())===JSON.stringify(['IN-PROGRESS.json','RECEIPT.json','REQUEST.json']))
 const request=JSON.parse(read(path.join(hold,'REQUEST.json')))
 const progress=JSON.parse(read(path.join(hold,'IN-PROGRESS.json')))
 const receipt=JSON.parse(read(path.join(hold,'RECEIPT.json')))
 need(/^[a-f0-9]{32}$/.test(expectedRequestId??'')&&request.kind==='phase1-backup-stop-request-v1'&&request.id===expectedRequestId&&progress.kind==='phase1-backup-stop-in-progress-v1'&&progress.requestId===request.id&&receipt.kind==='phase1-backup-stop-receipt-v1'&&receipt.requestId===request.id&&receipt.result==='PASS'&&receipt.restartBlocked===true&&receipt.testDeploymentAuthorized===false)
 need(/^backup-[0-9]{14}-[a-f0-9]{32}$/.test(receipt.backupName??'')&&/^[a-f0-9]{64}$/.test(receipt.sourceDigest??'')&&/^[a-f0-9]{64}$/.test(receipt.attestationSha256??''))
 const state=physical(path.join(root,'supervisor-state'))
 need(path.dirname(state)===root&&!present(path.join(state,INSTANCE))&&!present(path.join(state,'.family-calendar-private-supervisor-REQUIRES-REVIEW.json')))
 const backups=physical(path.join(root,'coordinated-backups')),bundle=physical(path.join(backups,receipt.backupName))
 need(path.dirname(backups)===root&&path.dirname(bundle)===backups)
 need(JSON.stringify(fs.readdirSync(bundle).sort())===JSON.stringify(['ATTESTATION.json','BACKUP-REVIEW.json','snapshot']))
 const review=JSON.parse(read(path.join(bundle,'BACKUP-REVIEW.json')))
 const attPath=path.join(bundle,'ATTESTATION.json')
 const attStat=fs.lstatSync(attPath)
 need(attStat.isFile()&&!attStat.isSymbolicLink()&&attStat.nlink===1&&attStat.size<=12*1024*1024)
 const attestation=JSON.parse(fs.readFileSync(attPath,'utf8'))
 need(review.kind==='phase1-supervised-coordinated-backup-v1'&&review.households===receipt.households&&review.files===receipt.files&&review.sourceDigest===receipt.sourceDigest&&review.attestationSha256===receipt.attestationSha256&&attestation.sha256===receipt.attestationSha256&&review.sourceFilesUnchanged===true&&review.sourceSessionsUnchanged===true&&review.restoreAuthorized===false&&review.automaticRestartAllowed===false)
 const checked=verifyOfflinePrivateRestoreSet({serverDirectory,restoreRoot:path.join(bundle,'snapshot')},attestation)
 need(checked.ok&&checked.households===receipt.households&&checked.files===receipt.files)
 const central=new DatabaseSync(identityDatabasePath,{readOnly:true})
 let plan
 try{plan=planReviewedPrivateTestStartup({identityDatabase:central,serverDirectory,storageRoot,stateDirectory:state,primaryHouseholdId})}
 finally{central.close()}
 need(JSON.stringify([...plan.registeredHouseholdIds].sort())===JSON.stringify(attestation.households))
 const paths={root,storage:storageRoot,identity:identityDatabasePath}
 need(digestClosedPhase1Source(paths,plan.registeredHouseholdIds)===receipt.sourceDigest)
 return Object.freeze({kind:'phase1-local-maintenance-resume-review-v1',requestId:request.id,backupName:receipt.backupName,verifiedBackup:true,originalDataUnchanged:true,writerLocksClear:true,households:checked.households,files:checked.files,windowsHostVerified:false,holdReleased:false,automaticRestartAllowed:false,testDeploymentAuthorized:false})
}

// Only the separately reviewed fixed-path Windows CLI may call this after
// its host gate. Preserve every receipt, never delete any recovery evidence.
export function archiveCompletedLocalMaintenanceHold(options){
 const reviewed=reviewLocalMaintenanceResume(options)
 const root=physical(options.root)
 const archive=path.join(root,'MAINTENANCE-COMPLETED-'+reviewed.requestId)
 need(!present(archive))
 fs.renameSync(path.join(root,HOLD),archive)
 assertLocalMaintenanceClear(root)
 return Object.freeze({...reviewed,holdReleased:true,archivePreserved:true,taskStarted:false})
}
