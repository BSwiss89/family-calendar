// PURE / SOURCE-ONLY Phase 1 TEST handoff sequencing REVIEW.
// Does not read the Windows host, start or stop a calendar, connect to SQLite,
// move portproxy, register tasks, authorize TEST or touch LIVE. All evidence is
// caller-supplied (synthetic in CI) and is NOT an independently verified receipt.
import { assessPrivatePhase1TestRoutingBoundary } from './private-phase1-test-network-boundary.mjs'
import { assessPrivatePhase1WindowsTaskFencing } from './private-phase1-windows-test-task-fencing.mjs'

const SHA = /^[a-f0-9]{40}$/
const KIND = 'phase1-test-cutover-simulation-v1'
const PHASES = Object.freeze([
  'baseline-reviewed', 'preparation-reported', 'test-tasks-fenced-reported', 'legacy-fenced-reported',
  'offline-backup-reported', 'private-ready-reported', 'new-route-reported',
  'canary-reported', 'requires-operator-review',
])
const STEP_RULES = Object.freeze({
  'report-preparation': {
    from: 'baseline-reviewed', to: 'preparation-reported',
    checks: [
      'existingTestRestoreAttested', 'candidateExactHeadCiPassed',
      'testAutodeployCollisionReviewed', 'testWatchdogCollisionReviewed',
      'liveProcessAndRoutingProtected', 'approvedMigrationPlanReviewed',
    ],
  },
  'observe-test-task-fence': {
    from: 'preparation-reported', to: 'test-tasks-fenced-reported',
    taskFencing: true,
  },
  'observe-legacy-fence': {
    from: 'test-tasks-fenced-reported', to: 'legacy-fenced-reported',
    topology: 'legacy-fenced', check: 'legacyFenceTopologyMatches',
  },
  'report-offline-backup': {
    from: 'legacy-fenced-reported', to: 'offline-backup-reported',
    checks: [
      'allLegacyWritersIndependentlyStopped',
      'coordinatedCentralAndHouseholdSnapshotCaptured',
      'sourceSqliteWalCheckpointed',
      'independentSnapshotRestoreAttested',
      'legacyCredentialsAndSessionPolicyReviewed',
      'newHouseholdMutationsNotDiscarded',
    ],
  },
  'observe-private-gateway': {
    from: 'offline-backup-reported', to: 'private-ready-reported',
    topology: 'pre-route', check: 'preRouteTopologyMatches',
  },
  'observe-repointed-test-route': {
    from: 'private-ready-reported', to: 'new-route-reported',
    topology: 'candidate-review', check: 'candidateNetworkTopologyMatches',
  },
  'report-canary': {
    from: 'new-route-reported', to: 'canary-reported',
    checks: [
      'externalTestHttpsAndTailscaleTlsReviewed',
      'signedOwnerAndOperatorRolesChecked',
      'crossHouseholdDataReadsAndWritesDenied',
      'directBackendAndOld13002AccessDenied',
      'liveHttpsAndLiveDataUnchanged',
      'taskWriterAndBackupHoldsStillEnforced',
    ],
  },
})
function refuse(message) {
  throw new Error('Phase 1 TEST staged handoff review refused: ' + message)
}
function snapshotMatches(review, topology, stage) {
  if (!topology || topology.phase !== stage ||
      topology.installedTestSha !== review.installedTestSha ||
      topology.legacyTestAddress !== review.legacyTestAddress ||
      topology.gatewayPort !== review.gatewayPort) {
    refuse('routing observations must match the pinned existing TEST baseline.')
  }
  const result = assessPrivatePhase1TestRoutingBoundary(topology)
  return result
}
function observation(review, kind, options = {}) {
  const next = Object.freeze([...review.recordedSteps, kind])
  return Object.freeze({
    ...review, phase: options.phase, recordedSteps: next,
    // Never turn synthetic or externally supplied proof into permission.
    independentlyVerifiedHostEvidence: false,
    windowsServicesModified: false,
    testDeploymentAuthorized: false,
    liveDeploymentAuthorized: false,
    mayAutomaticallyRollback: false,
    mayAutomaticallyRestart: false,
  })
}
function assertReview(review) {
  if (!review || typeof review !== 'object' || review.kind !== KIND ||
      !PHASES.includes(review.phase) ||
      !SHA.test(review.installedTestSha) || !SHA.test(review.candidateSha) ||
      !SHA.test(review.expectedLiveSha) ||
      typeof review.legacyTestAddress !== 'string' ||
      !Number.isSafeInteger(review.gatewayPort) ||
      !Array.isArray(review.recordedSteps) ||
      !Object.isFrozen(review) || !Object.isFrozen(review.recordedSteps) ||
      review.testDeploymentAuthorized !== false ||
      review.liveDeploymentAuthorized !== false ||
      review.mayAutomaticallyRollback !== false ||
      review.mayAutomaticallyRestart !== false) {
    refuse('only a pinned immutable source-only review can advance.')
  }
}
export function beginPrivatePhase1TestCutoverReview({
  baselineTopology, candidateSha, expectedLiveSha,
}) {
  if (!SHA.test(candidateSha) || !SHA.test(expectedLiveSha) ||
      !baselineTopology || baselineTopology.phase !== 'baseline') {
    refuse('complete exact-head candidate, LIVE reference and baseline required.')
  }
  const checked = assessPrivatePhase1TestRoutingBoundary(baselineTopology)
  if (!checked.observedBaselineMatches || checked.blockers.length) {
    refuse('existing TEST route does not match reviewed baseline.')
  }
  const review = Object.freeze({
    kind: KIND,
    phase: 'baseline-reviewed',
    installedTestSha: baselineTopology.installedTestSha,
    candidateSha,
    expectedLiveSha,
    legacyTestAddress: baselineTopology.legacyTestAddress,
    gatewayPort: baselineTopology.gatewayPort,
    originalTestPortproxy: checked.rollbackReference.originalPortproxy,
    proposedTestPortproxy: checked.proposedCutoverPortproxy,
    recordedSteps: Object.freeze(['baseline-topology-observed']),
    independentlyVerifiedHostEvidence: false,
    windowsServicesModified: false,
    testDeploymentAuthorized: false,
    liveDeploymentAuthorized: false,
    mayAutomaticallyRollback: false,
    mayAutomaticallyRestart: false,
  })
  return review
}
export function advancePrivatePhase1TestCutoverReview(review, {
  step, topology = null, evidence = null, taskSnapshots = null,
} = {}) {
  assertReview(review)
  if (review.phase === 'requires-operator-review') {
    refuse('held cutover requires a separate offline recovery review.')
  }
  const rule = STEP_RULES[step]
  if (!rule || review.phase !== rule.from) {
    refuse('unexpected cutover order or stage replay.')
  }
  if (rule.taskFencing) {
    if (topology !== null || evidence !== null || !taskSnapshots ||
        typeof taskSnapshots !== 'object' || Array.isArray(taskSnapshots) ||
        Object.keys(taskSnapshots).length !== 2) {
      refuse('exact task baseline and fenced observations are required.')
    }
    // This check correlates the fixed TEST revision with both Task Scheduler
    // snapshots. They remain caller-supplied and NEVER prove process exit or
    // watchdog exclusion: see explicit false receipt flags below.
    const reviewed = assessPrivatePhase1WindowsTaskFencing({
      baseline: taskSnapshots.baseline,
      maintenance: taskSnapshots.maintenance,
      expectedInstalledTestSha: review.installedTestSha,
    })
    if (!reviewed.observedTaskStatesMatch ||
        reviewed.blockers.length ||
        reviewed.safeToCutover !== false) {
      refuse('TEST scheduler collision, task-definition drift or incomplete fencing.')
    }
  } else if (rule.topology) {
    if (taskSnapshots !== null || evidence !== null) {
      refuse('topology steps cannot replace observations with attestations.')
    }
    const check = snapshotMatches(review, topology, rule.topology)
    if (!check[rule.check] || check.blockers.length !== 0 ||
        check.testDeploymentAuthorized !== false) {
      refuse('private TEST stage has unexpected listeners or bypass routing.')
    }
  } else {
    if (topology !== null || taskSnapshots !== null || !evidence || typeof evidence !== 'object' ||
        Array.isArray(evidence) ||
        Object.keys(evidence).length !== rule.checks.length ||
        rule.checks.some(name => evidence[name] !== true)) {
      refuse('complete explicit operator-reported checkpoints required.')
    }
  }
  return observation(review, step, { phase: rule.to })
}
/** No automatic revert: going back to legacy would require an offline data
 * reconciliation of any new household writes, backups, writer locks and
 * independent operator authorization. A held simulation is terminal. */
export function holdPrivatePhase1TestCutoverReview(review, reason) {
  assertReview(review)
  if (review.phase === 'requires-operator-review' ||
      typeof reason !== 'string' ||
      !['unexpected-process', 'writer-lock', 'backup-mismatch',
        'direct-bypass', 'route-drift', 'authentication', 'data-isolation',
        'canary-failed', 'other'].includes(reason)) {
    refuse('specific unrecovered TEST hold reason required.')
  }
  return Object.freeze({
    ...observation(review, 'hold-for-' + reason, {
      phase: 'requires-operator-review',
    }),
    holdReason: reason,
    lastReviewedPhase: review.phase,
    // Emergency routing must be reviewed separately; no automatic rollback.
    rollbackNeedsIndependentDataReconciliation: true,
  })
}
