// Pure simulated TEST handoff: absolutely no Windows, SQLite or sockets.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  beginPrivatePhase1TestCutoverReview as begin,
  advancePrivatePhase1TestCutoverReview as advance,
  holdPrivatePhase1TestCutoverReview as hold,
} from '../Server/private-phase1-test-staged-handoff-review.mjs'

const oldSha = '76caa3e46186c3c5c6408f11b55800eb06779776'
const candidateSha = 'eebb9a5b3641438210cf17e6279ed604081158ab'
const liveSha = 'ec0d91f2f54f21d84f6eb50da78b74adaf808c6c'
const oldIP = '100.124.58.19'
const gw = 13004
const oldProxy = () => ({ listenAddress: '127.0.0.1', listenPort: 13003,
  connectAddress: oldIP, connectPort: 13002 })
const newProxy = () => ({ listenAddress: '127.0.0.1', listenPort: 13003,
  connectAddress: '127.0.0.1', connectPort: gw })
const socket = (address, port, role) => ({ address, port, role })
const proxyListener = () => socket('127.0.0.1', 13003, 'portproxy')
const gateway = () => socket('127.0.0.1', gw, 'private-gateway')
const privateOne = () => socket('127.0.0.1', 13005, 'household-backend')
const privateTwo = () => socket('127.0.0.1', 13006, 'household-backend')
function topology(phase) {
  return {
    schemaVersion: 1, site: 'existing-secure-test',
    phase, installedTestSha: oldSha, legacyTestAddress: oldIP,
    gatewayPort: gw,
    portproxyRules: [phase === 'candidate-review' ? newProxy() : oldProxy()],
    listeners: phase === 'baseline' ? [
      proxyListener(), socket(oldIP, 13002, 'legacy-test'),
    ] : phase === 'legacy-fenced' ? [
      proxyListener(),
    ] : [proxyListener(), gateway(), privateOne(), privateTwo()],
  }
}
const preparation = {
  existingTestRestoreAttested: true,
  candidateExactHeadCiPassed: true,
  testAutodeployCollisionReviewed: true,
  testWatchdogCollisionReviewed: true,
  liveProcessAndRoutingProtected: true,
  approvedMigrationPlanReviewed: true,
}
const offline = {
  allLegacyWritersIndependentlyStopped: true,
  coordinatedCentralAndHouseholdSnapshotCaptured: true,
  sourceSqliteWalCheckpointed: true,
  independentSnapshotRestoreAttested: true,
  legacyCredentialsAndSessionPolicyReviewed: true,
  newHouseholdMutationsNotDiscarded: true,
}
const canary = {
  externalTestHttpsAndTailscaleTlsReviewed: true,
  signedOwnerAndOperatorRolesChecked: true,
  crossHouseholdDataReadsAndWritesDenied: true,
  directBackendAndOld13002AccessDenied: true,
  liveHttpsAndLiveDataUnchanged: true,
  taskWriterAndBackupHoldsStillEnforced: true,
}
const requiredTasks=[
  'Family Calendar Server','Family Calendar Ollama Server',
  'Family Calendar Watchdog','Family Calendar Secure TEST',
  'Family Calendar Secure TEST Auto Deploy','Family Calendar Auto Deploy',
  'Family Calendar Backup Sender',
]
function taskInventory(stage) {
  return {
    schemaVersion:1,site:'existing-secure-test',stage,
    installedTestSha:oldSha,enumerationSucceeded:true,
    tasks:requiredTasks.map((name,i)=>{
      const disabled=(name==='Family Calendar Auto Deploy') ||
        (stage==='maintenance-fenced' && [
          'Family Calendar Secure TEST','Family Calendar Secure TEST Auto Deploy',
        ].includes(name))
      return {
        name,path:'\\',state:disabled?'Disabled':'Ready',enabled:!disabled,
        actionDigest:(i+1).toString(16).padStart(64,'0'),
        principalDigest:(i+21).toString(16).padStart(64,'0'),
        triggerDigest:(i+41).toString(16).padStart(64,'0'),
        triggerCount:1,restartCount:3,multipleInstances:'IgnoreNew',
      }
    }),
  }
}
function taskSnapshots(){
  return { baseline:taskInventory('baseline'),
    maintenance:taskInventory('maintenance-fenced') }
}
function start() {
  return begin({
    baselineTopology: topology('baseline'), candidateSha,
    expectedLiveSha: liveSha,
  })
}
function prep() {
  return advance(start(), { step: 'report-preparation', evidence: preparation })
}
function taskFenced() {
  return advance(prep(), {
    step: 'observe-test-task-fence', taskSnapshots:taskSnapshots(),
  })
}
function fenced() {
  return advance(taskFenced(), {
    step: 'observe-legacy-fence', topology: topology('legacy-fenced'),
  })
}
function backed() {
  return advance(fenced(), { step: 'report-offline-backup', evidence: offline })
}
function privateReady() {
  return advance(backed(), {
    step: 'observe-private-gateway', topology: topology('pre-route'),
  })
}
function routed() {
  return advance(privateReady(), {
    step: 'observe-repointed-test-route', topology: topology('candidate-review'),
  })
}
function unauthorized(receipt) {
  assert.equal(receipt.testDeploymentAuthorized, false)
  assert.equal(receipt.liveDeploymentAuthorized, false)
  assert.equal(receipt.mayAutomaticallyRollback, false)
  assert.equal(receipt.mayAutomaticallyRestart, false)
  assert.equal(receipt.windowsServicesModified, false)
  assert.equal(receipt.independentlyVerifiedHostEvidence, false)
}

test('baseline-to-private route sequence records exact stages without ever authorizing deployment', () => {
  const steps = [start(), prep(), taskFenced(), fenced(), backed(), privateReady(), routed()]
  const last = advance(steps.at(-1), { step: 'report-canary', evidence: canary })
  assert.deepEqual(steps.map(x => x.phase), [
    'baseline-reviewed', 'preparation-reported',
    'test-tasks-fenced-reported', 'legacy-fenced-reported', 'offline-backup-reported',
    'private-ready-reported', 'new-route-reported',
  ])
  assert.equal(last.phase, 'canary-reported')
  assert.equal(last.recordedSteps.length, 8)
  assert.equal(last.candidateSha, candidateSha)
  assert.deepEqual(last.originalTestPortproxy, oldProxy())
  assert.deepEqual(last.proposedTestPortproxy, newProxy())
  for (const value of [...steps, last]) {
    unauthorized(value)
    assert(Object.isFrozen(value) && Object.isFrozen(value.recordedSteps))
  }
  assert.equal(steps[0].phase, 'baseline-reviewed',
    'immutable earlier observations must never be changed')
})

test('a missing backup, skipped maintenance stage or fabricated topologies fail closed', () => {
  assert.throws(() => advance(start(), {
    step: 'observe-repointed-test-route',
    topology: topology('candidate-review'),
  }), /unexpected cutover order/)
  const partial = { ...preparation }
  delete partial.testWatchdogCollisionReviewed
  assert.throws(() => advance(start(), {
    step: 'report-preparation', evidence: partial,
  }), /complete explicit/)
  assert.throws(() => advance(fenced(), {
    step: 'report-offline-backup',
    evidence: { ...offline, sourceSqliteWalCheckpointed: false },
  }), /complete explicit/)
  assert.throws(() => advance(backed(), {
    step: 'observe-private-gateway',
    topology: topology('candidate-review'),
  }), /routing observations/)
  assert.throws(() => advance(privateReady(), {
    step: 'observe-repointed-test-route',
    topology: topology('pre-route'),
  }), /routing observations/)
  assert.throws(() => advance(routed(), {
    step: 'report-canary', evidence: { ...canary, liveHttpsAndLiveDataUnchanged: false },
  }), /complete explicit/)
})

test('legacy direct 13002 bypass, second public forwarder and non-local backend block progress', () => {
  const oldRunning = topology('pre-route')
  oldRunning.listeners.push(socket(oldIP, 13002, 'legacy-test'))
  assert.throws(() => advance(backed(), {
    step: 'observe-private-gateway', topology: oldRunning,
  }), /unexpected listeners/)
  const exposed = topology('pre-route')
  exposed.listeners[3].address = oldIP
  assert.throws(() => advance(backed(), {
    step: 'observe-private-gateway', topology: exposed,
  }), /unexpected listeners/)
  const forwarded = topology('candidate-review')
  forwarded.portproxyRules.push({
    listenAddress: '0.0.0.0', listenPort: 14111,
    connectAddress: '127.0.0.1', connectPort: 13005,
  })
  assert.throws(() => advance(privateReady(), {
    step: 'observe-repointed-test-route', topology: forwarded,
  }), /unexpected listeners/)
  const liveRoute = topology('candidate-review')
  liveRoute.portproxyRules[0].connectPort = 3001
  assert.throws(() => advance(privateReady(), {
    step: 'observe-repointed-test-route', topology: liveRoute,
  }), /unexpected listeners/)
})

test('review stages cannot be replayed or transferred to a different TEST host reference', () => {
  assert.throws(() => begin({
    baselineTopology: topology('candidate-review'), candidateSha,
    expectedLiveSha: liveSha,
  }), /baseline required/)
  assert.throws(() => begin({
    baselineTopology: topology('baseline'), candidateSha: 'short',
    expectedLiveSha: liveSha,
  }), /complete exact-head/)
  const swapped = topology('legacy-fenced')
  swapped.installedTestSha = candidateSha
  assert.throws(() => advance(taskFenced(), {
    step: 'observe-legacy-fence', topology: swapped,
  }), /pinned existing TEST baseline/)
  const changedPort = topology('legacy-fenced')
  changedPort.gatewayPort = 13007
  assert.throws(() => advance(taskFenced(), {
    step: 'observe-legacy-fence', topology: changedPort,
  }), /pinned existing TEST baseline/)
  assert.throws(() => advance(backed(), {
    step: 'report-offline-backup', evidence: offline,
  }), /unexpected cutover order/)
})

test('scheduler maintenance must be reviewed before claiming legacy has stopped',()=>{
  assert.throws(()=>advance(prep(),{
    step:'observe-legacy-fence',topology:topology('legacy-fenced'),
  }),/unexpected cutover order/)
  assert.equal(taskFenced().phase,'test-tasks-fenced-reported')
  const bad=taskSnapshots()
  bad.maintenance.tasks.find(x=>x.name==='Family Calendar Secure TEST Auto Deploy')
    .enabled=true
  bad.maintenance.tasks.find(x=>x.name==='Family Calendar Secure TEST Auto Deploy')
    .state='Ready'
  assert.throws(()=>advance(prep(),{
    step:'observe-test-task-fence',taskSnapshots:bad,
  }),/scheduler collision/)
  const changed=taskSnapshots()
  changed.maintenance.tasks.find(x=>x.name==='Family Calendar Watchdog')
    .actionDigest='f'.repeat(64)
  assert.throws(()=>advance(prep(),{
    step:'observe-test-task-fence',taskSnapshots:changed,
  }),/scheduler collision/)
  assert.throws(()=>advance(prep(),{
    step:'observe-test-task-fence',taskSnapshots:{baseline:taskInventory('baseline')},
  }),/exact task baseline/)
  assert.equal(taskFenced().testDeploymentAuthorized,false)
})

test('any unrecovered fault enters a terminal manual hold, never automatically restores old TEST', () => {
  for (const item of [start(), taskFenced(), fenced(), backed(), privateReady(), routed()]) {
    const held = hold(item, 'canary-failed')
    assert.equal(held.phase, 'requires-operator-review')
    assert.equal(held.lastReviewedPhase, item.phase)
    assert.equal(held.rollbackNeedsIndependentDataReconciliation, true)
    unauthorized(held)
    assert.throws(() => advance(held, {
      step: 'report-canary', evidence: canary,
    }), /separate offline recovery/)
    assert.throws(() => hold(held, 'route-drift'), /specific unrecovered/)
  }
  assert.throws(() => hold(start(), 'unknown-failure'), /specific unrecovered/)
})
