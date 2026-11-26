// Only from the installed, reviewed TEST checkout. No stop-process, task
// changes or restart. A future approved scheduled wrapper may call this.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {createLocalBackupStopRequest} from '../Server/private-phase1-local-maintenance-control.mjs'
function need(v){if(!v)throw Error('Refused')}
try{
 need(process.platform==='win32'&&process.argv.length===2)
 const projects=fs.realpathSync(path.join(os.homedir(),'Projects'))
 const code=fs.realpathSync(path.join(projects,'family-calendar-phase1-test-code'))
 const root=fs.realpathSync(path.join(projects,'family-calendar-phase1-test-data'))
 need(path.dirname(code)===projects&&path.dirname(root)===projects&&
  !fs.lstatSync(path.join(projects,'family-calendar-phase1-test-code')).isSymbolicLink()&&
  !fs.lstatSync(path.join(projects,'family-calendar-phase1-test-data')).isSymbolicLink()&&
  path.dirname(path.dirname(fileURLToPath(import.meta.url)))===code)
 const ps=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
 const r=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
  path.join(code,'scripts','private-phase1-windows-stage-acl.ps1'),'-Mode','Verify','-Scope','windows-inactive-stage','-Directory',root],{encoding:'utf8',timeout:120000,windowsHide:true})
 need(!r.error&&r.status===0&&r.stdout.trim()==='PHASE1_WINDOWS_STAGE_ACL=PASS | PRIVATE_DACL=YES | TASKS_CHANGED=NO | DEPLOYMENT_AUTHORIZED=NO')
 const reviewFile=path.join(root,'ACTIVE-TEST-REVIEW.json')
 const stat=fs.lstatSync(reviewFile)
 need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=8192)
 const review=JSON.parse(fs.readFileSync(reviewFile,'utf8'))
 need(review.kind==='phase1-windows-active-test-review-v1'&&review.site==='existing-secure-test'&&review.testStartupApproved===true&&review.liveDeploymentAuthorized===false&&/^[a-f0-9]{40}$/.test(review.candidateSha??''))
 const pin=spawnSync('git',['-C',code,'rev-parse','HEAD'],{encoding:'utf8',timeout:10000,windowsHide:true})
 need(!pin.error&&pin.status===0&&pin.stdout.trim()===review.candidateSha)
 const task=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; if((Get-ScheduledTask -TaskName 'Family Calendar Secure TEST' -TaskPath '\\').State -cne 'Running' -or (Get-ScheduledTask -TaskName 'Family Calendar Secure TEST Auto Deploy' -TaskPath '\\').State -cne 'Disabled' -or (Get-ScheduledTask -TaskName 'Family Calendar Server' -TaskPath '\\').State -cne 'Running'){exit 1}; exit 0"],{timeout:15000,windowsHide:true})
 need(!task.error&&task.status===0)
 console.log(JSON.stringify(createLocalBackupStopRequest(root)))
}catch{
 console.error('PHASE1_TEST_BACKUP_STOP_REQUEST=REFUSED | MANUAL_REVIEW_REQUIRED=YES')
 process.exitCode=1
}
