// Synthetic TEST-only evidence. No actual Windows netsh/process inspection.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assessPrivatePhase1AllFamilyPortproxyDump as inspect }
  from '../Server/private-phase1-portproxy-all-families-review.mjs'

const sha = '76caa3e46186c3c5c6408f11b55800eb06779776'
const address = '100.124.58.19'
const prefix = '# Port Proxy configuration\r\npushd interface portproxy\r\n\r\nreset\r\n'
const suffix = '\r\npopd\r\n# End of Port Proxy configuration\r\n'
const rule = 'add v4tov4 listenport=13003 listenaddress=127.0.0.1 ' +
  'connectport=13002 connectaddress=100.124.58.19'
const input = dump => ({ dump, installedTestSha: sha, legacyTestAddress: address })
const full = (...rules) => prefix + rules.join('\r\n') + suffix
const script = fileURLToPath(
  new URL('./review-private-phase1-portproxy-all-families.mjs', import.meta.url))
const run = value => spawnSync(process.execPath, [script], {
  encoding: 'utf8', input: typeof value === 'string' ? value : JSON.stringify(value),
  timeout: 7000, windowsHide: true,
})

test('recognizes complete netsh export of exactly the observed baseline, without approval', () => {
  const report = inspect(input(full(rule)))
  assert.equal(report.observedBaselinePortproxyMatches, true)
  assert.equal(report.expectedLegacyRuleCount, 1)
  for (const flag of ['IPv6OrMixedFamilyRuleDetected',
    'verifiedListenerOwnership','verifiedAllHostForwarders',
    'old13002DirectAccessDenied','testDeploymentAuthorized',
    'liveDeploymentAuthorized','portproxyChanged']) {
    assert.equal(report[flag], false, flag)
  }
  assert.equal(report.operatorReviewStillRequired, true)
  assert(Object.isFrozen(report))
  const serialized = run(input(full(rule)))
  assert.equal(serialized.status, 0, serialized.stderr)
  assert.equal(JSON.parse(serialized.stdout).status, 'PASS')
  assert.equal(JSON.parse(serialized.stdout).testDeploymentAuthorized, false)
})

test('normal Windows dump field ordering and comments are allowed', () => {
  const reordered = 'add v4tov4 connectaddress=100.124.58.19 ' +
    'listenaddress=127.0.0.1 protocol=tcp connectport=13002 listenport=13003'
  assert.equal(inspect(input(full(reordered))).observedBaselinePortproxyMatches,true)
  assert.equal(inspect(input('\uFEFF' + full(rule))).observedBaselinePortproxyMatches,true)
})

test('all alternative address families and extra forwarded aliases are refused', () => {
  const unexpected = [
    'add v6tov4 listenport=15000 listenaddress=:: connectport=13002 connectaddress=100.124.58.19',
    'add v4tov6 listenport=16000 listenaddress=0.0.0.0 connectport=13002 connectaddress=::1',
    'add v6tov6 listenport=15000 listenaddress=:: connectport=13004 connectaddress=::1',
    'add v4tov4 listenport=13008 listenaddress=0.0.0.0 connectport=13002 connectaddress=100.124.58.19',
    rule,
  ]
  for (const extra of unexpected) {
    assert.throws(() => inspect(input(full(rule, extra))), /refused/)
    const result = run(input(full(rule, extra)))
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
  }
})

test('wrong, incomplete, substituted or missing export refuses', () => {
  const invalid = [
    full(''), full('reset'), full('add v4tov4 listenport=13003'),
    full(rule.replace('127.0.0.1','0.0.0.0')),
    full(rule.replace('13002','13004')),
    full(rule.replace(address,'192.0.2.1')),
    full(rule + ' connectaddress=100.124.58.19'),
    full(rule + ' protocol=udp'),
    full(rule + ' &echo=SECRET'),
    full('set v4tov4 ' + rule),
    'pushd interface portproxy\n' + rule + '\npopd',
    'pushd interface portproxy\nreset\n' + rule,
    full(rule) + '\nadd v4tov4 listenport=4444',
  ]
  for (const dump of invalid) {
    assert.throws(() => inspect(input(dump)), /refused/)
  }
})

test('refuses wrong source pins and scrubs raw secrets from rejected stdout/stderr', () => {
  assert.throws(() => inspect({ ...input(full(rule)), installedTestSha: 'bad' }), /refused/)
  assert.throws(() => inspect({ ...input(full(rule)), legacyTestAddress: '127.0.0.1' }), /refused/)
  const secret = 'TRAP_SECRET_123'
  for (const payload of [
    JSON.stringify(input(full(rule + '\n' + secret))),
    JSON.stringify({ ...input(full(rule)), extra: secret }),
    '{' + secret,
    secret.repeat(5000),
  ]) {
    const result = run(payload)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /refused/)
    assert.doesNotMatch(result.stderr, /TRAP_SECRET_123/)
  }
})
