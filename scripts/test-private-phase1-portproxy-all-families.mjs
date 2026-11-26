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
const normalShowAll = [
  'Listen on ipv4:             Connect to ipv4:',
  'Address         Port        Address         Port',
  '--------------- ----------  --------------- ----------',
  '127.0.0.1       13003       100.124.58.19   13002',
  '',
].join('\n')
const input = (dump, showAll = normalShowAll) =>
  ({ dump, showAll, installedTestSha: sha, legacyTestAddress: address })
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

test('actual November 23 Windows export omits listenaddress but agrees with complete show all', () => {
  const windowsDump = [
    '#========================',
    '# Port Proxy configuration',
    '#========================',
    'pushd interface portproxy',
    '',
    'reset',
    'add v4tov4 listenport=13003 connectaddress=100.124.58.19 connectport=13002',
    '',
    '',
    'popd',
    '',
    '# End of Port Proxy configuration',
    '',
  ].join('\n')
  const evidence = inspect(input(windowsDump))
  assert.equal(evidence.observedBaselinePortproxyMatches, true)
  assert.equal(evidence.old13002DirectAccessDenied, false)
  assert.equal(evidence.testDeploymentAuthorized, false)
  const wrapper = run(input(windowsDump))
  assert.equal(wrapper.status, 0, wrapper.stderr)
  assert.equal(JSON.parse(wrapper.stdout).status, 'PASS')
})

test('missing export listenaddress is never accepted without matching complete show-all evidence', () => {
  const omitted = 'add v4tov4 listenport=13003 connectaddress=100.124.58.19 connectport=13002'
  const suspicious = [
    normalShowAll.replace('127.0.0.1', '0.0.0.0'),
    normalShowAll.replace('13003', '13004'),
    normalShowAll.replace('13002', '13005'),
    normalShowAll + '0.0.0.0 14000 100.124.58.19 13002\n',
    normalShowAll + 'Listen on ipv6: Connect to ipv4:\n',
    '',
  ]
  for (const showAll of suspicious) {
    assert.throws(() => inspect(input(full(omitted), showAll)), /refused/)
    const wrapper = run(input(full(omitted), showAll))
    assert.equal(wrapper.status, 2)
    assert.equal(wrapper.stdout, '')
  }
  assert.throws(() => inspect(input(
    full(rule.replace('listenaddress=127.0.0.1',
      'listenaddress=0.0.0.0')))), /refused/)
  assert.throws(() => inspect(input(full(omitted), '')), /refused/)
})


test('complete portproxy review distinguishes each cutover phase and refuses stale routes', () => {
  const candidateRule = rule.replace('connectport=13002','connectport=13004').replace('connectaddress='+address,'connectaddress=127.0.0.1')
  const candidateShowAll = normalShowAll.replace(address,'127.0.0.1').replace('13002','13004')
  const legacy = input(full(rule))
  const candidate = input(full(candidateRule),candidateShowAll)
  for (const phase of ['baseline','legacy-fenced','pre-route']) {
    const report = inspect({...legacy,phase})
    assert.equal(report.legacyForwardingMatches,true)
    assert.equal(report.observedBaselinePortproxyMatches,phase==='baseline')
    assert.equal(report.candidateGatewayForwardingMatches,false)
    assert.throws(()=>inspect({...candidate,phase}),/refused/)
  }
  const postRoute = {...candidate,phase:'candidate-review'}
  const report = inspect(postRoute)
  assert.equal(report.candidateGatewayForwardingMatches,true)
  assert.equal(report.expectedLegacyRuleCount,0)
  assert.equal(report.completeNetshRuleCount,1)
  assert.equal(report.old13002DirectAccessDenied,false)
  assert.equal(report.testDeploymentAuthorized,false)
  const cli=run(postRoute)
  assert.equal(cli.status,0,cli.stderr)
  assert.equal(JSON.parse(cli.stdout).candidateGatewayForwardingMatches,true)
  assert.throws(()=>inspect({...legacy,phase:'candidate-review'}),/refused/)
  assert.throws(()=>inspect({...candidate,phase:'unknown'}),/refused/)
  assert.throws(()=>inspect({...postRoute,dump:full(candidateRule,rule)}),/refused/)
  assert.throws(()=>inspect({...postRoute,dump:full(candidateRule,'add v6tov4 listenport=14000 listenaddress=:: connectport=13005 connectaddress=127.0.0.1')}),/refused/)
  assert.throws(()=>inspect({...postRoute,dump:full(candidateRule.replace('connectport=13004','connectport=13005'))}),/refused/)
  assert.throws(()=>inspect({...postRoute,showAll:candidateShowAll.replace('13004','13005')}),/refused/)
})
