// Phase 1 TEST: source-only validation of all Windows netsh portproxy
// forwarding families. "show v4tov4" alone cannot discover v6tov4,
// v4tov6 or v6tov6 rules. This is a READ-ONLY review of a trusted
// "netsh interface portproxy dump" capture, not host proof or permission
// to change a service, route, firewall, Task Scheduler or calendar data.
const SHA = /^[a-f0-9]{40}$/
const IPV4 = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/
const REQUIRED = ['listenport','connectport','connectaddress']
const ALLOWED = new Set([...REQUIRED,'listenaddress','protocol'])
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
    if (!match || !ALLOWED.has(match[1]) ||
        Object.hasOwn(result, match[1])) {
      refuse('unrecognized, missing or repeated forwarding parameter.')
    }
    result[match[1]] = match[2]
  }
  if (Object.keys(result).length < REQUIRED.length ||
      REQUIRED.some(name => !Object.hasOwn(result, name)) ||
      (result.protocol && result.protocol !== 'tcp')) {
    refuse('incomplete or unexpected TCP forwarding parameters.')
  }
  return result
}

// Windows can omit listenaddress from "portproxy dump" even when "show all"
// explicitly lists 127.0.0.1. Never guess a default for a missing address.
// Require a separately captured, COMPLETE show-all table with exactly one
// IPv4-to-IPv4 rule and compare that row to the exported rule.
function parseCompleteShowAll(showAll, legacyTestAddress) {
  if (typeof showAll !== 'string' || showAll.length < 30 ||
      showAll.length > 32768 || /\\0/.test(showAll)) {
    refuse('complete bounded show-all forwarding evidence required.')
  }
  const lines = showAll.replace(/^\\uFEFF/, '').split(/\\r?\\n/)
    .map(line => line.trim()).filter(Boolean)
  if (lines.length !== 4 ||
      !/^Listen on ipv4:\\s+Connect to ipv4:$/i.test(lines[0]) ||
      !/^Address\\s+Port\\s+Address\\s+Port$/i.test(lines[1]) ||
      !/^-+\\s+-+\\s+-+\\s+-+$/.test(lines[2])) {
    refuse('unexpected, incomplete or additional portproxy show-all sections.')
  }
  const row = lines[3].split(/\\s+/)
  if (row.length !== 4 || row[0] !== '127.0.0.1' ||
      row[1] !== '13003' || row[2] !== legacyTestAddress ||
      row[3] !== '13002') {
    refuse('show-all forwarding differs from the one reviewed TEST rule.')
  }
  return Object.freeze({
    listenaddress: row[0], listenport: row[1],
    connectaddress: row[2], connectport: row[3],
  })
}

/**
 * Refuse unfamiliar export syntax rather than trusting a partial inventory.
 * Only ONE known IPv4-to-IPv4 TEST legacy forwarder may exist during the
 * observed baseline; any IPv6 family or additional IPv4 rule is a review hold.
 * A matching export alone does NOT prove listener ownership or direct denial.
 */
export function assessPrivatePhase1AllFamilyPortproxyDump({
  dump, showAll, installedTestSha, legacyTestAddress,
}) {
  if (typeof dump !== 'string' || dump.length < 15 || dump.length > 32768 ||
      /\0/.test(dump) || !SHA.test(installedTestSha) ||
      typeof legacyTestAddress !== 'string' ||
      !ipv4(legacyTestAddress) || !legacyTestAddress.startsWith('100.')) {
    refuse('bounded portproxy export and exact installed TEST references required.')
  }
  const observed = parseCompleteShowAll(showAll, legacyTestAddress)
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
      if (++count !== 1 ||
          args.listenport !== observed.listenport ||
          (args.listenaddress !== undefined &&
            args.listenaddress !== observed.listenaddress) ||
          args.connectport !== observed.connectport ||
          args.connectaddress !== observed.connectaddress) {
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
