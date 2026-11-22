// SOURCE-ONLY, stdin-only decoder for a sanitized Windows routing snapshot.
// Never accesses live listeners, changes portproxy/tasks, installs code, or
// authorizes a cutover. Windows collection is in a separate read-only script.
import { assessPrivatePhase1TestRoutingBoundary } from '../Server/private-phase1-test-network-boundary.mjs'

const chunks = []
let size = 0
try {
  for await (const part of process.stdin) {
    size += part.length
    if (size > 32768) throw new Error('oversized snapshot')
    chunks.push(part)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  // This observer is intentionally limited to the EXISTING legacy baseline.
  if (value?.phase !== 'baseline') throw new Error('unsupported review phase')
  const review = assessPrivatePhase1TestRoutingBoundary(value)
  const ok = review.observedBaselineMatches === true &&
    review.blockers.length === 0
  process.stdout.write(JSON.stringify({
    kind: 'phase1-read-only-existing-test-route-v1',
    result: ok ? 'PASS' : 'REVIEW',
    installedTestSha: review.rollbackReference.installedTestSha,
    currentTestRoute: review.rollbackReference.originalPortproxy,
    proposedGatewayRoute: review.proposedCutoverPortproxy,
    blockers: review.blockers,
    requiredManualGates: review.manualGates,
    verifiedProcessOwnership: false,
    verifiedDirectAccessDenied: false,
    verifiedTaskFencing: false,
    verifiedCoordinatedRollback: false,
    testDeploymentAuthorized: false,
    liveDeploymentAuthorized: false,
    filesOrServicesModified: false,
  }, null, 2) + '\n')
  if (!ok) process.exitCode = 2
} catch {
  // Never echo a caller-supplied JSON payload, credentials or process args.
  process.stderr.write('Read-only Phase 1 Windows TEST route snapshot refused; no site changed.\n')
  process.exitCode = 2
}
