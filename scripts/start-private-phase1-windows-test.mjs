// Fixed-path existing TEST task entry. No install, activation or routing.
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {launchReviewedWindowsPhase1TestGateway} from '../Server/private-disposable-reviewed-phase1-gateway-runtime.mjs'
import {readLocalBackupStopRequest,completeLocalBackupStopRequest} from '../Server/private-phase1-local-maintenance-control.mjs'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..','family-calendar-phase1-test-data')
let runtime,closing=false,timer
async function close(held,request=null){
 if(closing)return
 closing=true
 clearInterval(timer)
 try{
  if(held){await runtime.closeHeldForReview();process.exitCode=1}
  else if(request){
   const receipt=await runtime.shutdownAndCaptureBackup()
   completeLocalBackupStopRequest(root,request,receipt)
   console.log('PHASE1_TEST_BACKUP_STOP=PASS | RESTART_BLOCKED=YES')
   process.exitCode=0
  }else{await runtime.shutdown();process.exitCode=0}
 }catch{process.exitCode=1}
 console.log(held?'PHASE1_TEST_SUPERVISOR=HELD | MANUAL_REVIEW_REQUIRED=YES':'PHASE1_TEST_SUPERVISOR_STOP_RESULT='+process.exitCode)
}
try{
 if(process.argv.length!==2)throw Error('Unexpected arguments')
 runtime=await launchReviewedWindowsPhase1TestGateway()
 process.once('SIGINT',()=>void close(false))
 process.once('SIGTERM',()=>void close(false))
 let maintenanceRefused=false
 timer=setInterval(()=>{
  if(closing)return
  const state=runtime.snapshot()
  if(state.phase==='held'||!state.supervisorAdmissionOpen){void close(true);return}
  if(maintenanceRefused)return
  try{
   const request=readLocalBackupStopRequest(root)
   if(request)void close(false,request)
  }catch{
   // Malformed/stale requests never stop the service or clear the marker.
   maintenanceRefused=true
   console.error('PHASE1_TEST_MAINTENANCE=REFUSED | MANUAL_REVIEW_REQUIRED=YES')
  }
 },1000)
 console.log('PHASE1_TEST_SUPERVISOR=RUNNING | GATEWAY_PORT=13004 | LIVE_CHANGED=NO')
}catch{
 console.error('PHASE1_TEST_SUPERVISOR=REFUSED | MANUAL_REVIEW_REQUIRED=YES')
 process.exitCode=1
}
