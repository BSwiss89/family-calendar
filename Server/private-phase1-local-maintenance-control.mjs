// Trusted filesystem-only maintenance channel. No HTTP route, scheduler
// mutation, arbitrary destination, force-kill or automatic restart.
import fs from 'node:fs'
import path from 'node:path'
import {createHash,randomBytes} from 'node:crypto'
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
 const raw=read(path.join(hold,'REQUEST.json')),r=JSON.parse(raw)
 const progress=JSON.parse(read(path.join(hold,'IN-PROGRESS.json')))
 need(sha(raw)===request.requestHash&&r.id===request.requestId&&progress.requestId===r.id&&receipt.coordinatedBackupVerified===true&&receipt.allChildrenExited===true&&receipt.gatewayClosed===true&&receipt.ownerInstanceReleased===true&&receipt.restoreAuthorized===false&&receipt.automaticRestartAllowed===false&&/^backup-[0-9]{14}-[a-f0-9]{32}$/.test(receipt.backupName??'')&&Number.isSafeInteger(receipt.households)&&receipt.households>0&&Number.isSafeInteger(receipt.files)&&receipt.files>0)
 const state=physical(path.join(root,'supervisor-state'))
 need(!present(path.join(state,INSTANCE)))
 write(path.join(hold,'RECEIPT.tmp'),{kind:'phase1-backup-stop-receipt-v1',requestId:r.id,backupName:receipt.backupName,households:receipt.households,files:receipt.files,result:'PASS',restartBlocked:true,testDeploymentAuthorized:false})
 fs.renameSync(path.join(hold,'RECEIPT.tmp'),path.join(hold,'RECEIPT.json'))
 // Deliberately retain the complete maintenance hold. A separate reviewed
 // resume must check the backup, task state, route and all writer locks.
}
