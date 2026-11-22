// Phase 1 TEST routing boundary review. PURE, READ-ONLY and SOURCE-ONLY.
// Describes the currently observed Windows TEST Funnel/portproxy topology and
// a future, *separately authorized* TEST-only cutover to a private loopback gateway.
// This is not a supervisor, release installer, firewall, or proof of process
// identity/HTTPS ownership. Never interpret a matching snapshot as permission
// to deploy, stop a service, reconfigure portproxy, or restore SQLite.
const SHA = /^[a-f0-9]{40}$/
const IPV4 = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/
const PROTECTED = new Set([443, 8443, 3001, 11434, 13001, 13002, 13003])
const ROLES = new Set(['legacy-test', 'portproxy', 'private-gateway',
  'household-backend', 'other'])
const MANUAL_GATES = Object.freeze([
  'Pin exact reviewed candidate, CI, installed TEST baseline and rollback source.',
  'Verify all Windows task actions, auto-deployer and watchdog collision fencing.',
  'Prove current TEST database/uploads plus coordinated central/household backup and restore.',
  'Prove independently supervised gateway and household child processes, writer locks and sessions.',
  'Verify no direct household backend access (including legacy 13002) from remote or localhost without gateway authentication.',
  'Verify the TEST Funnel upstream, portproxy, TLS, login cookies, and LIVE isolation.',
  'Demonstrate TEST-only reversal and explicit operator approval before changing any routing.',
])
function refuse(message) {
  throw new Error('Private Phase 1 TEST route inspection refused: ' + message)
}
function ipv4(value) {
  return typeof value === 'string' && IPV4.test(value) &&
    value.split('.').every(x => Number(x) <= 255)
}
function loopback(value) {
  return value === '127.0.0.1'
}
function port(value) {
  return Number.isSafeInteger(value) && value > 0 && value < 65536
}
function add(blockers, reason) {
  if (!blockers.includes(reason)) blockers.push(reason)
}
function exactRule(rule, expected) {
  return rule.listenAddress === expected.listenAddress &&
    rule.listenPort === expected.listenPort &&
    rule.connectAddress === expected.connectAddress &&
    rule.connectPort === expected.connectPort
}
function validListener(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry) &&
    ipv4(entry.address) && port(entry.port) && ROLES.has(entry.role)
}
function validRule(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry) &&
    ipv4(entry.listenAddress) && ipv4(entry.connectAddress) &&
    port(entry.listenPort) && port(entry.connectPort)
}
function validatedSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      input.schemaVersion !== 1 || input.site !== 'existing-secure-test' ||
      !['baseline', 'candidate-review'].includes(input.phase) ||
      !SHA.test(input.installedTestSha) ||
      !ipv4(input.legacyTestAddress) ||
      !input.legacyTestAddress.startsWith('100.') ||
      !port(input.gatewayPort) || input.gatewayPort < 1024 ||
      PROTECTED.has(input.gatewayPort) ||
      !Array.isArray(input.portproxyRules) ||
      input.portproxyRules.length > 64 ||
      input.portproxyRules.some(x => !validRule(x)) ||
      !Array.isArray(input.listeners) || input.listeners.length > 128 ||
      input.listeners.some(x => !validListener(x))) {
    refuse('complete sanitized Windows TCP, portproxy, and pinned SHA inventory required.')
  }
}
/**
 * In particular, 13003 remains the only existing TEST HTTPS entry; it may
 * eventually proxy to a localhost gateway, NEVER directly to any family
 * backend. The old non-loopback Node 13002 must be stopped/fenced before
 * candidate routing can be considered. A local-only service token is another
 * defense, not a substitute for removing the bypass.
 */
export function assessPrivatePhase1TestRoutingBoundary(input) {
  validatedSnapshot(input)
  const blockers = []
  const proxy = input.portproxyRules.filter(x => x.listenPort === 13003)
  if (proxy.length !== 1) add(blockers,
    'TEST portproxy 13003 must have exactly one verified IPv4 rule.')
  if (input.portproxyRules.some(x => x.listenPort === input.gatewayPort ||
      x.connectPort === 3001 || x.connectPort === 8443)) {
    add(blockers, 'A conflicting or LIVE-directed portproxy rule requires review.')
  }
  const expectedCurrent = Object.freeze({
    listenAddress: '127.0.0.1', listenPort: 13003,
    connectAddress: input.legacyTestAddress, connectPort: 13002,
  })
  const expectedCandidate = Object.freeze({
    listenAddress: '127.0.0.1', listenPort: 13003,
    connectAddress: '127.0.0.1', connectPort: input.gatewayPort,
  })
  const required = input.phase === 'baseline' ? expectedCurrent : expectedCandidate
  if (proxy.length === 1 && !exactRule(proxy[0], required)) {
    add(blockers, 'TEST portproxy does not point to the stage-specific reviewed target.')
  }
  const get = p => input.listeners.filter(x => x.port === p)
  const proxySocket = get(13003)
  if (proxySocket.length !== 1 || !loopback(proxySocket[0].address) ||
      proxySocket[0].role !== 'portproxy') {
    add(blockers, 'Portproxy listener at 13003 must be exactly one localhost owner.')
  }
  const legacy = get(13002)
  const gateway = get(input.gatewayPort)
  if (input.phase === 'baseline') {
    if (legacy.length !== 1 ||
        legacy[0].address !== input.legacyTestAddress ||
        legacy[0].role !== 'legacy-test') {
      add(blockers, 'Observed legacy TEST 13002 listener differs from recorded baseline.')
    }
    if (gateway.length) {
      add(blockers, 'No proposed Phase 1 gateway may be wired during baseline inspection.')
    }
  } else {
    // A live legacy endpoint can bypass family gateway authentication. The
    // stricter rule is NO old 13002 listener, even if rebinding to loopback.
    if (legacy.length) {
      add(blockers, 'Old TEST backend 13002 is still running; direct bypass not fenced.')
    }
    if (gateway.length !== 1 || !loopback(gateway[0].address) ||
        gateway[0].role !== 'private-gateway') {
      add(blockers, 'Pinned Phase 1 gateway must have one localhost-only listener.')
    }
    const backends = input.listeners.filter(x => x.role === 'household-backend')
    if (backends.length < 1) {
      add(blockers, 'No separately verified private household backend listener.')
    }
    const used = new Set()
    for (const item of backends) {
      if (!loopback(item.address) || PROTECTED.has(item.port) ||
          item.port === input.gatewayPort || used.has(item.port)) {
        add(blockers, 'Private household backend must use a distinct unprotected localhost port.')
      }
      used.add(item.port)
    }
  }
  for (const item of input.listeners) {
    if ((item.role === 'private-gateway' || item.role === 'household-backend') &&
        !loopback(item.address)) {
      add(blockers, 'Private gateway/backend exposed on a non-loopback network address.')
    }
    if ((item.port === 13002 && item.role !== 'legacy-test') ||
        (item.port === input.gatewayPort && item.role !== 'private-gateway')) {
      add(blockers, 'Protected listener owner role cannot be independently corroborated.')
    }
  }
  const duplicate = new Set()
  for (const item of input.listeners) {
    const key = item.address + ':' + item.port
    if (duplicate.has(key)) add(blockers, 'Duplicate listener requires OS process-owner review.')
    duplicate.add(key)
  }
  // The original baseline target is a ROLLBACK REFERENCE only; never perform
  // rollback automatically or re-enable the old service while newer family
  // databases may still have writers. Reconcile state offline first.
  const rollbackReference = Object.freeze({
    installedTestSha: input.installedTestSha,
    originalPortproxy: expectedCurrent,
    requiresOfflineReconciliation: true,
    mayExecuteAutomatically: false,
  })
  return Object.freeze({
    schemaVersion: 1,
    site: input.site,
    phase: input.phase,
    observedBaselineMatches: input.phase === 'baseline' && blockers.length === 0,
    candidateNetworkTopologyMatches: input.phase === 'candidate-review' && blockers.length === 0,
    blockers: Object.freeze(blockers),
    manualGates: MANUAL_GATES,
    proposedCutoverPortproxy: expectedCandidate,
    rollbackReference,
    verifiedProcessOwnership: false,
    verifiedDirectAccessDenied: false,
    verifiedTaskFencing: false,
    verifiedCoordinatedRollback: false,
    testDeploymentAuthorized: false,
    liveDeploymentAuthorized: false,
    portproxyOrServiceChanged: false,
  })
}
