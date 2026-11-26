// Fixed-path existing TEST task entry. No install, activation or routing.
import {launchReviewedWindowsPhase1TestGateway} from '../Server/private-disposable-reviewed-phase1-gateway-runtime.mjs'
let runtime,closing=false,timer
async function close(held){
 if(closing)return
 closing=true
 clearInterval(timer)
 try{
  if(held){await runtime.closeHeldForReview();process.exitCode=1}
  else{await runtime.shutdown();process.exitCode=0}
 }catch{process.exitCode=1}
 console.log(held?'PHASE1_TEST_SUPERVISOR=HELD | MANUAL_REVIEW_REQUIRED=YES':'PHASE1_TEST_SUPERVISOR=STOPPED | EXIT_CODE='+process.exitCode)
}
try{
 if(process.argv.length!==2)throw Error('Unexpected arguments')
 runtime=await launchReviewedWindowsPhase1TestGateway()
 process.once('SIGINT',()=>void close(false))
 process.once('SIGTERM',()=>void close(false))
 timer=setInterval(()=>{
  const state=runtime.snapshot()
  if(state.phase==='held'||!state.supervisorAdmissionOpen)void close(true)
 },1000)
 console.log('PHASE1_TEST_SUPERVISOR=RUNNING | GATEWAY_PORT=13004 | LIVE_CHANGED=NO')
}catch{
 console.error('PHASE1_TEST_SUPERVISOR=REFUSED | MANUAL_REVIEW_REQUIRED=YES')
 process.exitCode=1
}
