// One-time, fixed-path upgrade bridge from the old installed TEST revision.
// Run only after the old supervised backup-stop request has closed all
// writers, the task is disabled, and the reviewed new commit is installed.
// Never stops processes, changes routing, activates households or starts TEST.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {completeLegacyPendingHouseholdTransition} from '../Server/private-phase1-pending-transition.mjs'

const OLD='a533a6ad684524803b0907f269e5f12fe6f5ea8c'
const LIVE='ec0d91f2f54f21d84f6eb50da78b74adaf808c6c'
const LEGACY='76caa3e46186c3c5c6408f11b55800eb06779776'
function need(v){if(!v)throw Error('Legacy transition host refused.')}
try{
 need(process.platform==='win32'&&process.argv.length===4)
 const [candidateSha,expectedRequestId]=process.argv.slice(2)
 need(/^[a-f0-9]{40}$/.test(candidateSha)&&candidateSha!==OLD&&/^[a-f0-9]{32}$/.test(expectedRequestId))
 const projects=fs.realpathSync(path.join(os.homedir(),'Projects'))
 const code=fs.realpathSync(path.join(projects,'family-calendar-phase1-test-code'))
 const root=fs.realpathSync(path.join(projects,'family-calendar-phase1-test-data'))
 need(path.dirname(code)===projects&&path.dirname(root)===projects&&path.dirname(path.dirname(fileURLToPath(import.meta.url)))===code)
 for(const leaf of ['family-calendar-phase1-test-code','family-calendar-phase1-test-data'])need(!fs.lstatSync(path.join(projects,leaf)).isSymbolicLink())
 const reviewPath=path.join(root,'ACTIVE-TEST-REVIEW.json'),stat=fs.lstatSync(reviewPath)
 need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=8192)
 const reviewRaw=fs.readFileSync(reviewPath,'utf8'),review=JSON.parse(reviewRaw)
 need(review.kind==='phase1-windows-active-test-review-v1'&&review.site==='existing-secure-test'&&review.candidateSha===OLD&&review.legacyTestSha===LEGACY&&review.liveSha===LIVE&&review.primaryHouseholdId==='primary-family'&&review.gatewayPort===13004&&review.testStartupApproved===true&&review.liveDeploymentAuthorized===false)
 const ps=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
 const run=args=>spawnSync(ps,args,{encoding:'utf8',timeout:120000,windowsHide:true})
 const checkHost=oldPid=>{
  need(fs.readFileSync(reviewPath,'utf8')===reviewRaw)
  const host=run(['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(code,'scripts','assert-private-phase1-windows-launch-host.ps1'),'-ExpectedCandidateSha',candidateSha,'-ExpectedInstalledTestSha',LEGACY,'-ExpectedLiveSha',LIVE,'-Mode','MaintenanceResume'])
  need(!host.error&&host.status===0&&host.stdout.trim()==='PHASE1_WINDOWS_RESUME_HOST=PASS | TEST_ONLY=YES')
  // Exact old supervisor PID must be absent; every other Node process must
  // have an inspectable command line, and no TEST code/backend may be running.
  // Inspect absolute path and launcher name; never emit process arguments.
  const check=run(['-NoProfile','-NonInteractive','-Command',
   "$ErrorActionPreference='Stop'; $old="+oldPid+"; $self="+process.pid+"; if(Get-CimInstance Win32_Process -Filter ('ProcessId = '+$old)){exit 1}; $p=@(Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'node.exe' -and $_.ProcessId -ne $self}); foreach($x in $p){if([string]::IsNullOrWhiteSpace([string]$x.CommandLine) -or [string]$x.CommandLine -match '(?i)family-calendar-phase1-test-code|start-private-phase1-windows-test\\.mjs'){exit 1}}; exit 0"])
  need(!check.error&&check.status===0)
 }
 const result=await completeLegacyPendingHouseholdTransition({root,storageRoot:path.join(root,'data'),identityDatabasePath:path.join(root,'data','central','identity.db'),serverDirectory:path.join(code,'Server'),primaryHouseholdId:review.primaryHouseholdId,expectedRequestId,gatewayPort:13004,checkHost})
 console.log(JSON.stringify(result))
}catch{
 console.error('LEGACY_PENDING_TRANSITION=REFUSED | MANUAL_REVIEW_REQUIRED=YES | LIVE_CHANGED=NO')
 process.exitCode=1
}
