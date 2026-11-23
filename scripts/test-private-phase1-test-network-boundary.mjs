// All fixtures are synthetic. No real Windows tasks, ports, or calendar data.
import test from 'node:test'
// Also verify sanitized Windows task-definition drift before any TEST pilot.
import './test-private-phase1-windows-test-task-fencing.mjs'
import './test-private-phase1-test-restart-schedule-review.mjs'
import './test-private-phase1-watchdog-source-audit.mjs'
import './test-private-phase1-offline-legacy-capture-contract.mjs'
// The existing CI boundary test also loads the staged handoff regression suite.
import './test-private-phase1-test-staged-handoff-review.mjs'
import assert from 'node:assert/strict'
import { assessPrivatePhase1TestRoutingBoundary as inspect }
  from '../Server/private-phase1-test-network-boundary.mjs'

const sha = '76caa3e46186c3c5c6408f11b55800eb06779776'
const address = '100.124.58.19'
const gatewayPort = 13004
const proxy = { listenAddress: '127.0.0.1', listenPort: 13003,
  connectAddress: address, connectPort: 13002 }
const listener = (address, port, role) => ({ address, port, role })
function base() {
  return {
    schemaVersion: 1, site: 'existing-secure-test',
    phase: 'baseline', installedTestSha: sha, legacyTestAddress: address,
    gatewayPort, portproxyRules: [{ ...proxy }],
    listeners: [
      listener('127.0.0.1', 13003, 'portproxy'),
      listener(address, 13002, 'legacy-test'),
    ],
  }
}
function candidate() {
  const x = base()
  x.phase = 'candidate-review'
  x.portproxyRules[0].connectAddress = '127.0.0.1'
  x.portproxyRules[0].connectPort = gatewayPort
  x.listeners = [
    listener('127.0.0.1', 13003, 'portproxy'),
    listener('127.0.0.1', gatewayPort, 'private-gateway'),
    listener('127.0.0.1', 13005, 'household-backend'),
    listener('127.0.0.1', 13006, 'household-backend'),
  ]
  return x
}
test('recognizes current observed TEST route but never authorizes cutover', () => {
  const result = inspect(base())
  assert.equal(result.observedBaselineMatches, true)
  assert.equal(result.candidateNetworkTopologyMatches, false)
  assert.equal(result.blockers.length, 0)
  assert.deepEqual(result.proposedCutoverPortproxy, {
    listenAddress: '127.0.0.1', listenPort: 13003,
    connectAddress: '127.0.0.1', connectPort: 13004,
  })
  assert.deepEqual(result.rollbackReference.originalPortproxy, proxy)
  assert.equal(result.rollbackReference.installedTestSha, sha)
  assert.equal(result.rollbackReference.mayExecuteAutomatically, false)
  assert.equal(result.testDeploymentAuthorized, false)
  assert.equal(result.liveDeploymentAuthorized, false)
  assert.equal(result.portproxyOrServiceChanged, false)
  assert(Object.isFrozen(result) && Object.isFrozen(result.blockers))
})
test('synthetic hardened candidate only passes topology, not release approvals', () => {
  const result = inspect(candidate())
  assert.equal(result.candidateNetworkTopologyMatches, true)
  assert.equal(result.observedBaselineMatches, false)
  assert.equal(result.blockers.length, 0)
  assert.equal(result.verifiedProcessOwnership, false)
  assert.equal(result.verifiedDirectAccessDenied, false)
  assert.equal(result.verifiedTaskFencing, false)
  assert.equal(result.verifiedCoordinatedRollback, false)
  assert.equal(result.testDeploymentAuthorized, false)
  assert(result.manualGates.some(x => /watchdog/.test(x)))
})
test('deny candidate if legacy direct 13002 still listens, including loopback', () => {
  for (const addr of ['100.124.58.19', '127.0.0.1', '0.0.0.0']) {
    const x = candidate()
    x.listeners.push(listener(addr, 13002, 'legacy-test'))
    const result = inspect(x)
    assert.equal(result.candidateNetworkTopologyMatches, false)
    assert(result.blockers.some(x => /direct bypass/.test(x)))
  }
})
test('deny wrong/duplicate portproxy and gateway to backend bypass', () => {
  let x = candidate()
  x.portproxyRules[0].connectPort = 13005
  assert(inspect(x).blockers.some(x => /stage-specific/.test(x)))
  x = candidate()
  x.portproxyRules.push({ ...x.portproxyRules[0] })
  assert(inspect(x).blockers.some(x => /exactly one/.test(x)))
  x = candidate()
  x.portproxyRules.push({ listenAddress: '127.0.0.1', listenPort: 13004,
    connectAddress: '127.0.0.1', connectPort: 13005 })
  assert(inspect(x).blockers.some(x => /conflicting/.test(x)))
})
function preRoute() {
  const x = candidate()
  x.phase = 'pre-route'
  x.portproxyRules = [{ ...proxy }]
  return x
}
test('legacy-fenced maintenance window contains zero active calendar backend or gateway listeners', () => {
  const quiet = base()
  quiet.phase = 'legacy-fenced'
  quiet.listeners = [listener('127.0.0.1', 13003, 'portproxy')]
  const review = inspect(quiet)
  assert.equal(review.legacyFenceTopologyMatches, true)
  assert.equal(review.observedBaselineMatches, false)
  assert.equal(review.testDeploymentAuthorized, false)
  assert.equal(review.portproxyOrServiceChanged, false)
  for (const active of [
    listener(address, 13002, 'legacy-test'),
    listener('127.0.0.1', gatewayPort, 'private-gateway'),
    listener('127.0.0.1', 13005, 'household-backend'),
  ]) {
    const bad = { ...quiet, listeners: [...quiet.listeners, active] }
    assert.equal(inspect(bad).legacyFenceTopologyMatches, false)
    assert(inspect(bad).blockers.some(x => /fully quiesced/.test(x)))
  }
})
test('pre-route stage confirms legacy service stopped while forwarding is still unchanged', () => {
  const phase = inspect(preRoute())
  assert.equal(phase.observedBaselineMatches, false)
  assert.equal(phase.preRouteTopologyMatches, true)
  assert.equal(phase.candidateNetworkTopologyMatches, false)
  assert.deepEqual(phase.rollbackReference.originalPortproxy, proxy)
  assert.equal(phase.testDeploymentAuthorized, false)
  assert.equal(phase.portproxyOrServiceChanged, false)
  const wrong = preRoute()
  wrong.portproxyRules[0].connectPort = 13004
  assert.equal(inspect(wrong).preRouteTopologyMatches, false,
    'gateway may not be routed until old backend is fenced and reviewed')
  const activeLegacy = preRoute()
  activeLegacy.listeners.push(listener(address, 13002, 'legacy-test'))
  assert.equal(inspect(activeLegacy).preRouteTopologyMatches, false)
  assert(inspect(activeLegacy).blockers.some(b => /direct bypass/.test(b)))
})
test('deny extra portproxy paths to legacy backend or household SQLite services', () => {
  let x = candidate()
  x.portproxyRules.push({
    listenAddress: '127.0.0.1', listenPort: 14222,
    connectAddress: address, connectPort: 13002,
  })
  assert(inspect(x).blockers.some(b => /Unreviewed forwarding/.test(b)))
  x = candidate()
  x.portproxyRules.push({
    listenAddress: '0.0.0.0', listenPort: 14223,
    connectAddress: '127.0.0.1', connectPort: 13005,
  })
  assert(inspect(x).blockers.some(b => /Unreviewed forwarding/.test(b)))
  x = candidate()
  x.portproxyRules.push({
    listenAddress: '0.0.0.0', listenPort: 14224,
    connectAddress: '127.0.0.1', connectPort: 13004,
  })
  assert(inspect(x).blockers.some(b => /Unreviewed forwarding/.test(b)))
  x = preRoute()
  x.portproxyRules.push({
    listenAddress: '127.0.0.1', listenPort: 14225,
    connectAddress: '127.0.0.1', connectPort: 13006,
  })
  assert.equal(inspect(x).preRouteTopologyMatches, false)
})
test('deny exposed, missing, duplicated and protected private listeners', () => {
  let x = candidate()
  x.listeners[1].address = '0.0.0.0'
  assert(inspect(x).blockers.some(x => /localhost-only/.test(x)))
  x = candidate()
  x.listeners[2].address = address
  assert(inspect(x).blockers.some(x => /distinct unprotected localhost/.test(x)))
  x = candidate()
  x.listeners.splice(2, 2)
  assert(inspect(x).blockers.some(x => /No separately/.test(x)))
  x = candidate()
  x.listeners[3].port = 13005
  x.listeners[3].address = '127.0.0.1'
  assert(inspect(x).blockers.some(x => /distinct unprotected localhost/.test(x)))
  x = candidate()
  x.listeners[3].port = 13002
  assert(inspect(x).blockers.some(x => /direct bypass/.test(x)))
})
test('deny malformed, unreviewed and incomplete inventories', () => {
  for (const patch of [
    { installedTestSha: 'short' }, { phase: 'arbitrary' },
    { site: 'live' }, { schemaVersion: 2 }, { gatewayPort: 13003 },
    { gatewayPort: 8443 }, { gatewayPort: 1000 }, { gatewayPort: '13004' },
    { legacyTestAddress: '127.0.0.1' }, { listeners: null },
    { portproxyRules: null },
  ]) assert.throws(() => inspect({ ...base(), ...patch }), /refused/)
  const x = base()
  x.listeners[0].address = '0.0.0.0'
  assert(inspect(x).blockers.some(x => /localhost owner/.test(x)))
  const y = candidate()
  y.listeners[1].role = 'other'
  assert(inspect(y).blockers.some(x => /gateway/.test(x)))
})
