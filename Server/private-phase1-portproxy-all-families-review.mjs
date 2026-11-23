// Phase 1 TEST: source-only validation of all Windows netsh portproxy
// forwarding families. "show v4tov4" alone cannot discover v6tov4,
// v4tov6 or v6tov6 rules. This is a READ-ONLY review of a trusted
// "netsh interface portproxy dump" capture, not host proof or permission
// to change a service, route, firewall, Task Scheduler or calendar data.
const SHA = /^[a-f0-9]{40}$/
const IPV4 = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/
const REQUIRED = ['listenport','listenaddress','connectport','connectaddress']
const TYPES = new Set(['v4tov4','v4tov6','v6tov4','v6tov6'])

function refuse(reason) {
  throw new Error('Phase 1 portproxy-all-families review refused: ' + reason)
}
function ipv4(value) {
  return IPV4.test(value) && value.split('.').every(x => Number(x) <= 255)
}
function properties(words) {
  const result = Object.create(null)
  for (const word of words) {
    const match = /^([a-z]+)=([^\s=]+)$/.exec(word)
    if (!match || ![...REQUIRED,'protocol'].includes(match[1]) ||
        Object.hasOwn(result, match[1])) {
      refuse('unrecognized, missing or repeated forwarding parameter.')
    }
    result[match[1]] = match[2]
  }
  if (Object.keys(result).length < 4 ||
      REQUIRED.some(name => !Object.hasOwn(result, name)) ||
      (result.protocol && result.protocol !== 'tcp')) {
    refuse('incomplete or unexpected TCP forwarding parameters.')
  }
  return result
}

/**
 * Refuse unfamiliar export syntax rather than trusting a partial inventory.
 * Only ONE known IPv4-to-IPv4 TEST legacy forwarder may exist during the
 * observed baseline; any IPv6 family or additional IPv4 rule is a review hold.
 * A matching export alone does NOT prove listener ownership or direct denial.
 */
export function assessPrivatePhase1AllFamilyPortproxyDump({
  dump, installedTestSha, legacyTestAddress,
}) {
  if (typeof dump !== 'string' || dump.length < 15 || dump.length > 32768 ||
      /\0/.test(dump) || !SHA.test(installedTestSha) ||
      typeof legacyTestAddress !== 'string' ||
      !ipv4(legacyTestAddress) || !legacyTestAddress.startsWith('100.')) {
    refuse('bounded portproxy export and exact installed TEST references required.')
  }
  const lines = dump.replace(/^\uFEFF/, '').split(/\r?\n/)
  let phase = 'initial'
  let count = 0
  for (const original of lines) {
    const line = original.trim()
    if (!line || line.startsWith('#')) continue
    if (phase === 'initial' && /^pushd interface portproxy$/i.test(line)) {
      phase = 'entered'
    } else if (phase === 'entered' && /^reset$/i.test(line)) {
      phase = 'reset'
    } else if (phase === 'reset' && /^add\s+/i.test(line)) {
      const tokens = line.toLowerCase().split(/\s+/)
      const kind = tokens[1]
      if (!TYPES.has(kind)) refuse('unknown forwarding address-family command.')
      // Portproxy dump includes IPv4 and IPv6 families. Any extra family is
      // unreviewed; never discard it because show v4tov4 looks correct.
      if (kind !== 'v4tov4') {
        refuse('unreviewed IPv6 or mixed-address-family forwarding rule.')
      }
      const args = properties(tokens.slice(2))
      if (++count !== 1 || args.listenport !== '13003' ||
          args.listenaddress !== '127.0.0.1' ||
          args.connectport !== '13002' ||
          args.connectaddress !== legacyTestAddress) {
        refuse('unreviewed additional or mismatched TEST portproxy rule.')
      }
    } else if (phase === 'reset' && /^popd$/i.test(line)) {
      phase = 'done'
    } else {
      refuse('unrecognized or incomplete complete-family export format.')
    }
  }
  if (phase !== 'done' || count !== 1) {
    refuse('complete portproxy family export and exactly one TEST rule required.')
  }
  return Object.freeze({
    kind: 'phase1-netsh-portproxy-complete-family-review-v1',
    installedTestSha, expectedLegacyRuleCount: 1,
    observedBaselinePortproxyMatches: true,
    IPv6OrMixedFamilyRuleDetected: false,
    verifiedListenerOwnership: false,
    verifiedAllHostForwarders: false,
    old13002DirectAccessDenied: false,
    testDeploymentAuthorized: false,
    liveDeploymentAuthorized: false,
    portproxyChanged: false,
    operatorReviewStillRequired: true,
  })
}
