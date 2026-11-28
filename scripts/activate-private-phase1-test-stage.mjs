// Local Phase 1 activation of the verified inactive migration stage.
// Windows entry requires explicit scoped approval, exact installed source,
// an unchanged fresh cold capture and a still-fenced legacy TEST.
// No task registration, listener, routing, LIVE changes or automatic rollback.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {DatabaseSync} from 'node:sqlite'
import {hashFamilyPassword,verifyFamilyPassword} from '../Server/family-auth.mjs'
import {createIndependentHouseholdInvitationTables} from '../Server/independent-household-invitations.mjs'
import {createPrivateActivationRecords} from '../Server/private-household-activation-records.mjs'
import {getSoleActiveHouseholdOwner} from '../Server/household-memberships.mjs'
import {planReviewedPrivateTestStartup} from '../Server/private-reviewed-test-startup-plan.mjs'
import {reviewInactivePhase1TestStage} from '../Server/private-phase1-inactive-stage-startup-preflight.mjs'
import {assessPrivatePhase1AllFamilyPortproxyDump} from '../Server/private-phase1-portproxy-all-families-review.mjs'
import {verifyOfflineLegacyTestSnapshot} from '../Server/private-phase1-legacy-snapshot-verification.mjs'
import {prepareInactivePhase1TestMigrationStage} from './private-phase1-offline-household-copy-rehearsal.mjs'
import {readHiddenOwnerPassword} from './private-phase1-local-owner-password-proof.mjs'

const need=v=>{if(!v)throw Error('Local Phase 1 TEST activation refused.')}
const sha=/^[a-f0-9]{40}$/
const snapshotPattern=/^OFFLINE-LEGACY-TEST-\d{8}-\d{6}-[a-f0-9]{32}$/
const physical=p=>{const s=fs.lstatSync(p);need(s.isDirectory()&&!s.isSymbolicLink());return fs.realpathSync(p)}
const read=p=>{const s=fs.lstatSync(p);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=12*1024*1024);return fs.readFileSync(p)}
const digest=p=>{const s=fs.lstatSync(p);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1);const h=createHash('sha256'),fd=fs.openSync(p,'r'),b=Buffer.alloc(1024*1024);try{for(;;){const n=fs.readSync(fd,b,0,b.length,null);if(!n)break;h.update(b.subarray(0,n))}}finally{fs.closeSync(fd)}return h.digest('hex')}
const json=p=>JSON.parse(read(p))
function writeNew(p,v){const fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(v,null,2)+'\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
const healthy=db=>db.prepare('PRAGMA integrity_check').get().integrity_check==='ok'&&db.prepare('PRAGMA foreign_key_check').all().length===0
const count=(db,table)=>db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n
const serverDirectory=fileURLToPath(new URL('../Server/',import.meta.url))
const codeDirectory=path.dirname(serverDirectory.replace(/[\\/]$/,''))
function run(exe,args){
 const r=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024})
 need(!r.error&&r.status===0);return r.stdout.trim()
}
function hostFence(options){
 const {destinationParent,expectedCandidateSha,expectedInstalledTestSha,expectedLiveSha,expectedArchiveName,expectedManifestSha256}=options
 need(process.platform==='win32'&&physical(path.join(os.homedir(),'Projects'))===destinationParent&&sha.test(expectedLiveSha))
 const code=physical(path.join(destinationParent,'family-calendar-phase1-test-code'))
 need(code===physical(codeDirectory))
 const legacy=physical(path.join(destinationParent,'family-calendar-test-security-stage'))
 const live=physical(path.join(destinationParent,'family-calendar-live-auth-candidate'))
 for(const [dir,pin] of [[code,expectedCandidateSha],[legacy,expectedInstalledTestSha],[live,expectedLiveSha]])need(run('git',['-C',dir,'rev-parse','HEAD'])===pin)
 need(run('git',['-C',code,'status','--porcelain','--untracked-files=no'])==='')
 const ps=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
 const result=run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(code,'scripts','capture-private-phase1-offline-legacy-test.ps1'),'-ExpectedInstalledTestSha',expectedInstalledTestSha])
 need(result.includes('TASKS=test=Disabled updater=Disabled')&&result.includes('LEGACY_LISTENERS=0 | PRIVATE_LISTENERS=0'))
 const inspect="$ErrorActionPreference='Stop'; $u=[Security.Principal.WindowsIdentity]::GetCurrent(); if(-not ([Security.Principal.WindowsPrincipal]$u).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or $u.User.Value -eq 'S-1-5-18'){exit 1}; foreach($n in @('Family Calendar Auto Deploy','Family Calendar Auto Preview','Family Calendar Secure LIVE Auto Deploy')){if((Get-ScheduledTask -TaskName $n).State -cne 'Disabled'){exit 1}}; if(@(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in @(13002,13004,13005,13006)}).Count){exit 1}; foreach($p in @(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -ne $PID -and $_.Name -in @('node.exe','powershell.exe','pwsh.exe')})){if([string]::IsNullOrWhiteSpace($p.CommandLine) -or $p.CommandLine -match '(?i)family-calendar-test-security-stage|start-secure-test-patched\\.ps1|secure-test-auto-deploy\\.ps1'){exit 1}}; $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 3001); if($listeners.Count -ne 1 -or $listeners[0].LocalAddress -cne '127.0.0.1'){exit 1}; $lp=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$listeners[0].OwningProcess); $liveEntry=Join-Path $env:USERPROFILE 'Projects\\family-calendar-live-auth-candidate\\Server\\index.mjs'; if($lp.Name -cne 'node.exe' -or [string]$lp.CommandLine -notlike ('*'+$liveEntry+'*')){exit 1}; if((Invoke-WebRequest -Uri 'http://127.0.0.1:3001/api/health' -UseBasicParsing -TimeoutSec 5).StatusCode -ne 200){exit 1}; Write-Output 'FENCED'"
 need(run(ps,['-NoProfile','-NonInteractive','-Command',inspect])==='FENCED')
 assessPrivatePhase1AllFamilyPortproxyDump({dump:run('netsh',['interface','portproxy','dump']),showAll:run('netsh',['interface','portproxy','show','all']),installedTestSha:expectedInstalledTestSha,legacyTestAddress:'100.124.58.19',phase:'legacy-fenced'})
 const recoveryParent=physical(path.join(destinationParent,'family-calendar-phase1-recovery'))
 const snapshotRoot=physical(path.join(recoveryParent,expectedArchiveName))
 need(path.dirname(snapshotRoot)===recoveryParent)
 const args={recoveryParent,snapshotRoot,expectedInstalledTestSha}
 need(verifyOfflineLegacyTestSnapshot(args).result==='PASS')
 const manifestFile=path.join(snapshotRoot,'OFFLINE-LEGACY-REVIEW.json')
 need(digest(manifestFile)===expectedManifestSha256)
 const manifest=json(manifestFile),elapsed=Date.now()-Date.parse(manifest.capturedAt)
 need(Number.isFinite(elapsed)&&elapsed>=0&&elapsed<=60*60*1000)
 const preview=physical(path.join(destinationParent,'family-calendar-preview','Server'))
 const data=physical(path.join(preview,'data')),uploads=physical(path.join(preview,'uploads'))
 need(JSON.stringify(fs.readdirSync(data))===JSON.stringify(['calendar.db']))
 need(digest(path.join(data,'calendar.db'))===manifest.databaseSha256)
 // Ensure all current upload bytes and names still match the cold archive.
 const actual=[]
 function walk(dir,rel){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name),key=rel+'/'+e.name;need(!e.isSymbolicLink()&&actual.length<50000);if(e.isDirectory())walk(physical(p),key);else actual.push({path:key,sha256:digest(p)})}}
 walk(uploads,'uploads')
 const expected=manifest.files.filter(x=>x.path.startsWith('uploads/')).map(x=>({path:x.path,sha256:x.sha256}))
 const sort=a=>a.sort((x,y)=>x.path.localeCompare(y.path,'en'))
 need(JSON.stringify(sort(actual))===JSON.stringify(sort(expected)))
 return args
}
function verifyAcl(root){
 const ps=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
 need(run(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(codeDirectory,'scripts','private-phase1-windows-stage-acl.ps1'),'-Mode','Verify','-Scope','windows-inactive-stage','-Directory',root])==='PHASE1_WINDOWS_STAGE_ACL=PASS | PRIVATE_DACL=YES | TASKS_CHANGED=NO | DEPLOYMENT_AUTHORIZED=NO')
}

// The disposable scope is restricted by the existing preflight to isolated
// test fixtures. A fixture never publishes a real Windows startup approval.
export async function activateInactivePhase1TestStage(options,{ownerPassword,operatorUsername,operatorPassword}){
 const windows=options.scope==='windows-inactive-stage'
 need(windows||options.scope==='disposable-test-fixture')
 need(typeof operatorUsername==='string'&&/^[a-z0-9._-]{3,40}$/.test(operatorUsername)&&typeof ownerPassword==='string'&&typeof operatorPassword==='string'&&operatorPassword!==ownerPassword)
 need(sha.test(options.expectedLiveSha??''))
 const root=path.join(options.destinationParent,'family-calendar-phase1-test-data')
 if(windows){hostFence(options);verifyAcl(root)}
 reviewInactivePhase1TestStage(options)
 const storage=path.join(root,'data'),identity=path.join(storage,'central','identity.db')
 const ro=new DatabaseSync(identity,{readOnly:true})
 let owner
 try{owner=ro.prepare('SELECT id,username,password_hash FROM family_users WHERE disabled=1').get();need(owner&&operatorUsername!==owner.username)}
 finally{ro.close()}
 need(await verifyFamilyPassword(ownerPassword,owner.password_hash))
 const operatorHash=hashFamilyPassword(operatorPassword)
 ownerPassword=undefined;operatorPassword=undefined
 if(windows){hostFence(options);verifyAcl(root)}
 reviewInactivePhase1TestStage(options)
 const before= digest(identity)
 const progress=path.join(root,'ACTIVATION-IN-PROGRESS.json'),hold=path.join(root,'DO-NOT-START.json')
 writeNew(progress,{kind:'phase1-activation-in-progress-v1',candidateSha:options.expectedCandidateSha,originalIdentitySha256:before})
 const state=path.join(root,'supervisor-state')
 fs.mkdirSync(state,{mode:0o700})
 const db=new DatabaseSync(identity)
 let operatorId
 try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE')
  need(digest(identity)===before)
  db.exec('BEGIN IMMEDIATE')
  try{
   createIndependentHouseholdInvitationTables(db)
   createPrivateActivationRecords(db)
   need(count(db,'family_users')===1&&count(db,'household_registry')===1&&count(db,'household_memberships')===1)
   const current=db.prepare('SELECT id,username,password_hash FROM family_users WHERE disabled=1').get()
   need(current&&current.id===owner.id&&current.username===owner.username&&current.password_hash===owner.password_hash)
   operatorId=Number(db.prepare("INSERT INTO family_users(username,display_name,password_hash,account_kind,disabled) VALUES(?,?,?,'person',0)").run(operatorUsername,'Platform operator',operatorHash).lastInsertRowid)
   need(db.prepare('UPDATE family_users SET disabled=0 WHERE id=? AND disabled=1').run(owner.id).changes===1)
   need(db.prepare("UPDATE household_registry SET disabled=0 WHERE storage_id='primary-family' AND disabled=1").run().changes===1)
   need(db.prepare("UPDATE household_memberships SET disabled=0 WHERE user_id=? AND role='owner' AND disabled=1").run(owner.id).changes===1)
   need(getSoleActiveHouseholdOwner(db,'primary-family')===owner.id&&db.prepare('SELECT COUNT(*) AS n FROM household_memberships WHERE user_id=?').get(operatorId).n===0)
   need(count(db,'family_sessions')===0&&count(db,'household_session_selections')===0&&healthy(db))
   const plan=planReviewedPrivateTestStartup({identityDatabase:db,serverDirectory:options.serverDirectory,storageRoot:storage,stateDirectory:state,primaryHouseholdId:'primary-family'})
   need(plan.householdCount===1&&plan.householdIds[0]==='primary-family')
   db.exec('COMMIT')
  }catch(e){db.exec('ROLLBACK');throw e}
 }finally{db.close()}
 if(windows){hostFence(options);verifyAcl(root)}
 const review={kind:'phase1-windows-active-test-review-v1',site:'existing-secure-test',candidateSha:options.expectedCandidateSha,legacyTestSha:options.expectedInstalledTestSha,liveSha:options.expectedLiveSha,primaryHouseholdId:'primary-family',operatorUserId:operatorId,testStartupApproved:windows,liveDeploymentAuthorized:false,gatewayPort:13004,sourceArchiveName:options.expectedArchiveName,sourceManifestSha256:options.expectedManifestSha256}
 writeNew(path.join(root,windows?'ACTIVE-TEST-REVIEW.json':'FIXTURE-ACTIVATION-REVIEW.json'),review)
 // Preserve original hold and journal as evidence. Any interruption prior to
 // the last rename leaves a startup-blocking marker.
 fs.renameSync(hold,path.join(root,'INACTIVE-DO-NOT-START-ARCHIVED.json'))
 fs.renameSync(progress,path.join(root,'ACTIVATION-COMPLETED.json'))
 return {result:'PASS',ownerActivated:true,separateOperator:true,oldSessionsImported:0,households:1,testStartupApproved:windows,taskStarted:false,routeChanged:false,liveDeploymentAuthorized:false}
}
let phase='arguments'
async function main(){
 const [approval,expectedCandidateSha,expectedInstalledTestSha,expectedLiveSha,expectedArchiveName,operatorUsername]=process.argv.slice(2)
 need(process.argv.length===8&&approval==='APPROVE-EXISTING-TEST-ONLY'&&[expectedCandidateSha,expectedInstalledTestSha,expectedLiveSha].every(x=>sha.test(x??''))&&snapshotPattern.test(expectedArchiveName??'')&&/^[a-z0-9._-]{3,40}$/.test(operatorUsername??'')&&process.stdin.isTTY&&process.stdout.isTTY&&process.platform==='win32')
 const destinationParent=physical(path.join(os.homedir(),'Projects')),recoveryParent=physical(path.join(destinationParent,'family-calendar-phase1-recovery'))
 const snapshotRoot=physical(path.join(recoveryParent,expectedArchiveName))
 need(path.dirname(snapshotRoot)===recoveryParent)
 const expectedManifestSha256=digest(path.join(snapshotRoot,'OFFLINE-LEGACY-REVIEW.json'))
 const options={serverDirectory,destinationParent,scope:'windows-inactive-stage',expectedCandidateSha,expectedInstalledTestSha,expectedLiveSha,expectedArchiveName,expectedManifestSha256}
 phase='host-fence'
 const args=hostFence(options)
 phase='credential-input'
 let ownerPassword=await readHiddenOwnerPassword(process.stdin,process.stdout)
 let operatorPassword=await readHiddenOwnerPassword(process.stdin,process.stdout,{promptKind:'operator'})
 let confirmation=await readHiddenOwnerPassword(process.stdin,process.stdout,{promptKind:'operator-confirm'})
 try{
  need(operatorPassword===confirmation&&operatorPassword.length>=8&&operatorPassword!==ownerPassword)
  confirmation=undefined
  phase='owner-proof'
  await (async()=>{const {verifyOfflineCentralOwnerPassword}=await import('./private-phase1-offline-central-owner-rehearsal.mjs');need((await verifyOfflineCentralOwnerPassword(args,ownerPassword)).passwordOwnershipVerified)})()
  phase='pre-stage-fence'
  hostFence(options)
  phase='inactive-stage'
  prepareInactivePhase1TestMigrationStage(args,{candidateSha:expectedCandidateSha,destinationParent,scope:options.scope})
  phase='activation'
  const receipt=await activateInactivePhase1TestStage(options,{ownerPassword,operatorUsername,operatorPassword})
  console.log(JSON.stringify(receipt))
 }finally{ownerPassword=undefined;operatorPassword=undefined;confirmation=undefined}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{await main()}catch{console.error('PHASE1_TEST_ACTIVATION=REFUSED | PHASE='+phase+' | DO_NOT_START_OR_CLEAR_HOLDS | LIVE_CHANGED=NO');process.exitCode=1}
}
