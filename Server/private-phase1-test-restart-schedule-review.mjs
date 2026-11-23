// Pure read-only Phase 1 TEST maintenance-window schedule risk assessment.
// No Task Scheduler queries, calendar access, clock calls, service mutations
// or deployment authorization. Operator-supplied local timestamps are NOT
// evidence that the actual Windows host is fenced or safe to cut over.
const TS=/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/
const CYCLE_MINUTES=5
function refuse(message) {
  throw new Error('Phase 1 TEST maintenance schedule review refused: '+message)
}
function parseLocal(value) {
  if(typeof value!=='string'||!TS.test(value)) refuse('complete local date/time required.')
  const [date,time]=value.split('T')
  const [year,month,day]=date.split('-').map(Number)
  const [hour,minute,second]=time.split(':').map(Number)
  const utc=new Date(Date.UTC(year,month-1,day,hour,minute,second))
  if(utc.getUTCFullYear()!==year || utc.getUTCMonth()+1!==month ||
    utc.getUTCDate()!==day||utc.getUTCHours()!==hour ||
    utc.getUTCMinutes()!==minute||utc.getUTCSeconds()!==second){
    refuse('invalid calendar date or local timestamp.')
  }
  // Ordering is valid for local wall-clock timestamps outside DST fold;
  // refuse changes spanning DST transition below instead of guessing.
  return value
}
function dayParts(input) {
  return input.slice(0,10)
}
export function reviewPrivatePhase1TestMaintenanceSchedule({
  windowStartLocal,windowEndLocal,monthlyRestartNextLocal,
  watchdogNextLocal,watchdogCycleMinutes,
  monthlyRestartTaskEnabled,watchdogTaskEnabled,
  watchdogLegacyTestExclusionIndependentlyVerified=false,
  monthlyRestartRebootPreventedDuringWindow=false,
  scheduledTaskActionsIndependentlyReviewed=false,
}={}){
  const start=parseLocal(windowStartLocal)
  const end=parseLocal(windowEndLocal)
  const restart=parseLocal(monthlyRestartNextLocal)
  const watchdog=parseLocal(watchdogNextLocal)
  if(start>=end || watchdogCycleMinutes!==CYCLE_MINUTES ||
    typeof monthlyRestartTaskEnabled!=='boolean'||
    watchdogTaskEnabled!==true ||
    typeof watchdogLegacyTestExclusionIndependentlyVerified!=='boolean'||
    typeof monthlyRestartRebootPreventedDuringWindow!=='boolean'||
    typeof scheduledTaskActionsIndependentlyReviewed!=='boolean' ||
    // Use same-day wall-clock windows only; do not infer DST behavior or
    // interpret this advisory as permission to change the host's clock.
    dayParts(start)!==dayParts(end)){
    refuse('short explicit, pinned same-day TEST window and 5-minute watchdog required.')
  }
  const collisions=[]
  const rebootInWindow=monthlyRestartTaskEnabled &&
    restart>=start && restart<=end
  if(rebootInWindow && !monthlyRestartRebootPreventedDuringWindow){
    collisions.push('Monthly laptop reboot could interrupt TEST migration or backup.')
  }
  if(!watchdogLegacyTestExclusionIndependentlyVerified){
    collisions.push('Watchdog TEST restart exclusion is not independently verified.')
  }
  if(!scheduledTaskActionsIndependentlyReviewed){
    collisions.push('Real Windows task action code and nested calls still need review.')
  }
  // If monthly task protection is claimed, this review does not verify that
  // the task has actually been disabled/blocked or that LIVE remains protected.
  return Object.freeze({
    kind:'phase1-test-restart-schedule-risk-v1',
    windowStartLocal:start,windowEndLocal:end,
    reportedMonthlyRestartNextLocal:restart,
    reportedWatchdogNextLocal:watchdog,
    watchdogCycleMinutes:CYCLE_MINUTES,
    monthlyRebootCollision:rebootInWindow,
    operatorReportedBlockers:Object.freeze(collisions),
    requiresFreshHostEvidence:true,
    verifiedTaskExclusionOnHost:false,
    verifiedMonthlyRebootBlockedOnHost:false,
    verifiedLegacyBackendStopped:false,
    verifiedLiveUnaffected:false,
    safeToCutover:false,
    testDeploymentAuthorized:false,
    liveDeploymentAuthorized:false,
    servicesChanged:false,
  })
}
