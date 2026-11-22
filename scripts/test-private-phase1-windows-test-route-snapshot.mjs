// Pure OS-temp/synthetic input tests. No Windows service is inspected.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./review-private-phase1-windows-test-route.mjs',
  import.meta.url))
const sourceSha = '76caa3e46186c3c5c6408f11b55800eb06779776'
function baseline() {
  return {
    schemaVersion: 1, site: 'existing-secure-test', phase: 'baseline',
    installedTestSha: sourceSha, legacyTestAddress: '100.124.58.19',
    gatewayPort: 13004,
    portproxyRules: [{
      listenAddress: '127.0.0.1', listenPort: 13003,
      connectAddress: '100.124.58.19', connectPort: 13002,
    }],
    listeners: [
      { address: '127.0.0.1', port: 13003, role: 'portproxy' },
      { address: '100.124.58.19', port: 13002, role: 'legacy-test' },
    ],
  }
}
function invoke(value) {
  return spawnSync(process.execPath, [entry], {
    input: typeof value === 'string' ? value : JSON.stringify(value),
    encoding: 'utf8', windowsHide: true, timeout: 7000,
  })
}
test('observed baseline is reported without granting any deployment permission', () => {
  const result = invoke(baseline())
  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(result.stdout)
  assert.equal(evidence.result, 'PASS')
  assert.equal(evidence.installedTestSha, sourceSha)
  assert.deepEqual(evidence.currentTestRoute, baseline().portproxyRules[0])
  assert.equal(evidence.proposedGatewayRoute.connectPort, 13004)
  for (const key of ['testDeploymentAuthorized', 'liveDeploymentAuthorized',
    'verifiedProcessOwnership', 'verifiedDirectAccessDenied',
    'verifiedTaskFencing', 'verifiedCoordinatedRollback',
    'filesOrServicesModified']) {
    assert.equal(evidence[key], false, key)
  }
  assert(evidence.requiredManualGates.length >= 5)
})
test('wrong TEST forwarding, running gateway and exposed source fail baseline check', () => {
  let x = baseline()
  x.portproxyRules[0].connectPort = 13004
  let result = invoke(x)
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stdout).result, 'REVIEW')
  x = baseline()
  x.listeners.push({ address: '127.0.0.1', port: 13004, role: 'private-gateway' })
  result = invoke(x)
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stdout).result, 'REVIEW')
  x = baseline()
  x.listeners[1].address = '0.0.0.0'
  result = invoke(x)
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stdout).result, 'REVIEW')
})
test('malformed, future-phase and oversized snapshots fail without echoing input', () => {
  for (const value of [
    'invalid-secret-token-{garbage}',
    { ...baseline(), phase: 'candidate-review' },
    { ...baseline(), installedTestSha: 'not-a-sha' },
    'SECRET=' + 's'.repeat(40000),
  ]) {
    const result = invoke(value)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /refused/)
    assert.doesNotMatch(result.stderr, /SECRET|invalid-secret-token/)
  }
})
