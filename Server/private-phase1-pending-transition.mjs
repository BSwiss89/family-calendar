// Local-only recovery of the exact legacy backup-stop failure caused by a
// registered, unactivated invitation. Never called by the browser or service.
// Windows host and deployment pins are checked by the fixed-path CLI.
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {planReviewedPrivateTestStartup} from './private-reviewed-test-startup-plan.mjs'
import {captureVerifiedClosedPhase1Files,digestClosedPhase1Source} from './private-phase1-supervised-backup.mjs'

const INSTANCE='.family-calendar-reviewed-supervisor-instance.lock'
const HOLD='MAINTENANCE-REVIEW'
const hash=raw=>createHash('sha256').update(raw).digest('hex')
function need(v){if(!v)throw Error('Legacy pending-household transition refused; preserve all evidence for review.')}
function directory(p){const s=fs.lstatSync(p);need(s.isDirectory()&&!s.isSymbolicLink());return fs.realpathSync(p)}
function read(p){const s=fs.lstatSync(p);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=16384);return fs.readFileSync(p,'utf8')}
function exact(p,names){need(JSON.stringify(fs.readdirSync(p).sort())===JSON.stringify([...names].sort()))}
function write(p,r){const fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(r)+'\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
export async function completeLegacyPendingHouseholdTransition({root,storageRoot,identityDatabasePath,serverDirectory,primaryHouseholdId,expectedRequestId,gatewayPort,checkHost}){
 need(typeof checkHost==='function'&&/^[a-f0-9]{32}$/.test(expectedRequestId??''))
 root=directory(root)
 const state=directory(path.join(root,'supervisor-state')),hold=directory(path.join(root,HOLD))
 need(path.dirname(state)===root&&path.dirname(hold)===root)
 const instanceFile=path.join(state,INSTANCE),requestFile=path.join(hold,'REQUEST.json'),progressFile=path.join(hold,'IN-PROGRESS.json')
 exact(hold,['REQUEST.json','IN-PROGRESS.json'])
 const instanceRaw=read(instanceFile),requestRaw=read(requestFile),progressRaw=read(progressFile)
 const instance=JSON.parse(instanceRaw),request=JSON.parse(requestRaw),progress=JSON.parse(progressRaw)
 need(instance.schemaVersion===1&&instance.type==='reviewed-multifamily-supervisor-instance'&&Number.isSafeInteger(instance.pid)&&instance.pid>0&&Number.isSafeInteger(instance.householdCount)&&instance.householdCount>0&&/^[a-f0-9]{64}$/.test(instance.nonce??''))
 need(request.kind==='phase1-backup-stop-request-v1'&&request.id===expectedRequestId&&request.instanceSha256===hash(instanceRaw)&&progress.kind==='phase1-backup-stop-in-progress-v1'&&progress.requestId===expectedRequestId)
 const archive=path.join(root,'LEGACY-PENDING-TRANSITION-'+expectedRequestId)
 need(!fs.existsSync(archive))
 function plan(){
  const central=new DatabaseSync(identityDatabasePath,{readOnly:true})
  try{return planReviewedPrivateTestStartup({identityDatabase:central,serverDirectory,storageRoot,stateDirectory:state,primaryHouseholdId})}finally{central.close()}
 }
 const initial=plan()
 need(initial.pendingHouseholdIds.length>0&&initial.householdCount===instance.householdCount)
 const checkExclusive=()=>{
  checkHost(instance.pid)
  exact(hold,['REQUEST.json','IN-PROGRESS.json'])
  need(read(instanceFile)===instanceRaw&&read(requestFile)===requestRaw&&read(progressFile)===progressRaw)
  const current=plan()
  need(JSON.stringify(current)===JSON.stringify(initial))
 }
 checkExclusive()
 const paths={root,storage:storageRoot,identity:identityDatabasePath,server:serverDirectory}
 const receipt=await captureVerifiedClosedPhase1Files({paths,ids:initial.registeredHouseholdIds,ports:[gatewayPort],checkExclusive})
 checkExclusive()
 need(receipt.coordinatedBackupVerified===true&&receipt.supervisorHeldDuringCapture===false&&receipt.households===initial.registeredHouseholdIds.length&&digestClosedPhase1Source(paths,initial.registeredHouseholdIds)===receipt.sourceDigest)
 // Preserve the original failed request and abandoned instance; never claim
 // that the old supervisor itself completed its backup or released ownership.
 write(path.join(hold,'TRANSITION.json'),{kind:'phase1-legacy-pending-transition-v1',requestId:expectedRequestId,originalInstanceSha256:hash(instanceRaw),backupName:receipt.backupName,households:receipt.households,pendingHouseholds:initial.pendingHouseholdIds.length,sourceDigest:receipt.sourceDigest,attestationSha256:receipt.attestationSha256,files:receipt.files,originalMaintenanceCompleted:false,manualBackupVerified:true,testDeploymentAuthorized:false})
 fs.renameSync(instanceFile,path.join(hold,'LEGACY-SUPERVISOR-INSTANCE.json'))
 fs.renameSync(hold,archive)
 return Object.freeze({result:'PASS',backupName:receipt.backupName,households:receipt.households,pendingHouseholds:initial.pendingHouseholdIds.length,files:receipt.files,originalEvidenceArchived:true,originalSourceUnchanged:true,taskStarted:false,liveDeploymentAuthorized:false})
}
