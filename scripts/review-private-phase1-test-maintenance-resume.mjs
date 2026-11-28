// No restore, task changes or automatic restart. Explicit local review only.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {reviewLocalMaintenanceResume,archiveCompletedLocalMaintenanceHold} from '../Server/private-phase1-local-maintenance-control.mjs'
function need(v){if(!v)throw Error('Refused')}
function dir(p){const s=fs.lstatSync(p);need(s.isDirectory()&&!s.isSymbolicLink());return fs.realpathSync(p)}
try{
 const [mode,expectedRequestId]=process.argv.slice(2)
 need(process.platform==='win32'&&process.argv.length===4&&['--review','--archive-reviewed-hold'].includes(mode)&&/^[a-f0-9]{32}$/.test(expectedRequestId??''))
 const projects=dir(path.join(os.homedir(),'Projects'))
 const code=dir(path.join(projects,'family-calendar-phase1-test-code'))
 const root=dir(path.join(projects,'family-calendar-phase1-test-data'))
 need(path.dirname(code)===projects&&path.dirname(root)===projects&&path.dirname(path.dirname(fileURLToPath(import.meta.url)))===code)
 const reviewFile=path.join(root,'ACTIVE-TEST-REVIEW.json'),s=fs.lstatSync(reviewFile)
 need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=8192)
 const raw=fs.readFileSync(reviewFile,'utf8'),r=JSON.parse(raw)
 const sha=/^[a-f0-9]{40}$/
 need(r.kind==='phase1-windows-active-test-review-v1'&&r.site==='existing-secure-test'&&r.testStartupApproved===true&&r.liveDeploymentAuthorized===false&&r.primaryHouseholdId==='primary-family'&&r.gatewayPort===13004&&[r.candidateSha,r.legacyTestSha,r.liveSha].every(x=>sha.test(x??'')))
 const ps=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
 function host(){
  const result=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
   path.join(code,'scripts','assert-private-phase1-windows-launch-host.ps1'),'-Mode','MaintenanceResume',
   '-ExpectedCandidateSha',r.candidateSha,'-ExpectedInstalledTestSha',r.legacyTestSha,'-ExpectedLiveSha',r.liveSha],{encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024})
  need(!result.error&&result.status===0&&result.stdout.trim()==='PHASE1_WINDOWS_RESUME_HOST=PASS | TEST_ONLY=YES'&&fs.readFileSync(reviewFile,'utf8')===raw)
 }
 host()
 const storageRoot=dir(path.join(root,'data'))
 const central=dir(path.join(storageRoot,'central'))
 need(path.dirname(storageRoot)===root&&path.dirname(central)===storageRoot)
 const identityDatabasePath=path.join(central,'identity.db')
 const st=fs.lstatSync(identityDatabasePath)
 need(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1)
 const options={root,storageRoot,identityDatabasePath,serverDirectory:dir(path.join(code,'Server')),primaryHouseholdId:r.primaryHouseholdId,expectedRequestId}
 let result=reviewLocalMaintenanceResume(options)
 if(mode==='--archive-reviewed-hold'){
  host()
  result=archiveCompletedLocalMaintenanceHold(options)
 }
 console.log(JSON.stringify({...result,windowsHostVerified:true,taskStarted:false}))
}catch{
 console.error('PHASE1_TEST_MAINTENANCE_RESUME=REFUSED | MANUAL_REVIEW_REQUIRED=YES')
 process.exitCode=1
}
