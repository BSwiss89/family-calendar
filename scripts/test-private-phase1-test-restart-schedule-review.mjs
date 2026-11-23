import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewPrivatePhase1TestMaintenanceSchedule as inspect }
  from '../Server/private-phase1-test-restart-schedule-review.mjs'

// These dates are the user's READ-ONLY Windows inventory as of 2026-11-22.
// Synthetic proposed maintenance windows are NOT an actual cutover plan.
const observed={
  monthlyRestartNextLocal:'2026-12-01T02:00:00',
  watchdogNextLocal:'2026-11-22T18:42:00',
  watchdogCycleMinutes:5,
  monthlyRestartTaskEnabled:true,
  watchdogTaskEnabled:true,
}
const proposed={
  windowStartLocal:'2026-12-01T01:55:00',
  windowEndLocal:'2026-12-01T02:15:00',
}
test('real reported reboot time blocks a hypothetical same-time cutover',()=>{
  const r=inspect({...observed,...proposed})
  assert.equal(r.monthlyRebootCollision,true)
  assert(r.operatorReportedBlockers.some(x=>/Monthly laptop reboot/.test(x)))
  assert(r.operatorReportedBlockers.some(x=>/Watchdog/.test(x)))
  assert(r.operatorReportedBlockers.some(x=>/task action code/.test(x)))
  for(const key of ['testDeploymentAuthorized','liveDeploymentAuthorized',
    'safeToCutover','servicesChanged','verifiedTaskExclusionOnHost',
    'verifiedMonthlyRebootBlockedOnHost','verifiedLegacyBackendStopped',
    'verifiedLiveUnaffected']){
    assert.equal(r[key],false,key)
  }
  assert(Object.isFrozen(r)&&Object.isFrozen(r.operatorReportedBlockers))
})
test('outside reboot interval still requires independently reviewed watchdog',()=>{
  const r=inspect({...observed,
    windowStartLocal:'2026-11-29T14:00:00',
    windowEndLocal:'2026-11-29T15:00:00',
  })
  assert.equal(r.monthlyRebootCollision,false)
  assert(r.operatorReportedBlockers.some(x=>/Watchdog/.test(x)))
  assert.equal(r.safeToCutover,false)
})
test('operator-reported watchdog exclusion and reboot hold never authorize a release',()=>{
  const r=inspect({...observed,...proposed,
    monthlyRestartRebootPreventedDuringWindow:true,
    watchdogLegacyTestExclusionIndependentlyVerified:true,
    scheduledTaskActionsIndependentlyReviewed:true,
  })
  assert.deepEqual(r.operatorReportedBlockers,[])
  assert.equal(r.monthlyRebootCollision,true)
  assert.equal(r.verifiedMonthlyRebootBlockedOnHost,false)
  assert.equal(r.safeToCutover,false)
  assert.equal(r.testDeploymentAuthorized,false)
  assert.equal(r.liveDeploymentAuthorized,false)
})
test('invalid clock, reversed window, and incomplete watchdog evidence reject',()=>{
  for(const patch of [
    {windowStartLocal:'2026-12-01T02:15:00'},
    {windowEndLocal:'2026-12-01T01:50:00'},
    {windowEndLocal:'2026-12-02T02:00:00'},
    {monthlyRestartNextLocal:'2026-13-01T02:00:00'},
    {watchdogNextLocal:'2026-11-31T18:42:00'},
    {watchdogCycleMinutes:60},
    {watchdogTaskEnabled:false},
    {monthlyRestartTaskEnabled:null},
  ]){
    assert.throws(()=>inspect({...observed,...proposed,...patch}),/refused/)
  }
})
