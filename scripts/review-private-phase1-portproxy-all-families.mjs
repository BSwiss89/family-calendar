// Stdin-only, sanitized decoder for read-only Windows netsh portproxy dump.
// Never echoes the command output, and never changes route or service state.
import { assessPrivatePhase1AllFamilyPortproxyDump } from '../Server/private-phase1-portproxy-all-families-review.mjs'

const pieces = []
let bytes = 0
try {
  for await (const piece of process.stdin) {
    bytes += piece.length
    if (bytes > 40000) throw new Error('too large')
    pieces.push(piece)
  }
  const input = JSON.parse(Buffer.concat(pieces).toString('utf8'))
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !['dump,installedTestSha,legacyTestAddress,showAll',
      'dump,installedTestSha,legacyTestAddress,phase,showAll'].includes(Object.keys(input).sort().join(','))) {
    throw new Error('unexpected fields')
  }
  const result = assessPrivatePhase1AllFamilyPortproxyDump(input)
  process.stdout.write(JSON.stringify({
    status: 'PASS',
    kind: result.kind,
    phase: result.phase,
    legacyRuleCount: result.expectedLegacyRuleCount,
    candidateGatewayForwardingMatches: result.candidateGatewayForwardingMatches,
    completeNetshRuleCount: result.completeNetshRuleCount,
    IPv6OrMixedFamilyRuleDetected: result.IPv6OrMixedFamilyRuleDetected,
    verifiedListenerOwnership: result.verifiedListenerOwnership,
    verifiedAllHostForwarders: result.verifiedAllHostForwarders,
    old13002DirectAccessDenied: result.old13002DirectAccessDenied,
    testDeploymentAuthorized: false,
    liveDeploymentAuthorized: false,
    portproxyChanged: false,
  }) + '\n')
} catch {
  process.stderr.write(
    'Phase 1 complete-family portproxy export refused; no calendar or Windows settings changed.\n')
  process.exitCode = 2
}
