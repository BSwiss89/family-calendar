// Read-only single-family TEST pilot preflight. Never starts a server, writes
// SQLite, installs tasks, changes HTTPS routes or authorizes a deployment.
// Existing TEST is a legacy single-family calendar, NOT the private gateway.
import { pathToFileURL } from 'node:url'
import { assessPrivateTestHostReadiness } from './assess-private-test-host-readiness.mjs'
import { assessPrivateWindowsPortOwners } from './assess-private-windows-port-owners.mjs'

const SHA = /^[a-f0-9]{40}$/
const REQUIRED_TASKS = [
  'Family Calendar Server',
  'Family Calendar Secure TEST',
  'Family Calendar Secure TEST Auto Deploy',
  'Family Calendar Watchdog',
]
const NEXT_GATES = Object.freeze([
  'Operator inspects actual TEST process tree, scheduled task identities, auto-deploy and watchdog race boundaries',
  'Verify an independent consistent SQLite TEST backup AND all associated uploads (never file-copy a hot WAL database)',
  'Perform and verify an isolated restore of the exact candidate and its account/session state',
  'Set up at least one active family owner login before turning on required authentication; test login/logout and secured uploads',
  'Review actual TEST HTTPS route, host/session cookie isolation, access restrictions and lack of direct-backend bypass',
  'Demonstrate TEST-only rollback: preserved original executable/configuration/DB/uploads and safe process handoff',
  'Exercise mobile and wall client acceptance: events, Lists, People, recurring events and device sessions',
  'Explicit operator sign-off that backup, recovery, credential, HTTPS and family acceptance evidence all matches the pinned candidate',
])

function refuse(message) {
  throw new Error('One-family TEST pilot preflight rejected: ' + message)
}
function validObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item)
}

/**
 * Synthetic/observed host inventory reader; does NOT certify installation,
 * deployment readiness or writer fencing, even if the snapshots look healthy.
 * No authorization decision may be inferred from these results.
 */
export function assessOneFamilyTestPilotReadiness(input) {
  if (!validObject(input) || input.schemaVersion !== 1 ||
      input.mode !== 'existing-test-single-household' ||
      !SHA.test(input.candidateCommitSha)) {
    refuse('a versioned, pinned, existing-TEST single-family review is required.')
  }
  if (!validObject(input.hostInventory) || !validObject(input.portInventory)) {
    refuse('both separately observed Windows inventory sources are required.')
  }

  const host = assessPrivateTestHostReadiness(input.hostInventory)
  const network = assessPrivateWindowsPortOwners(input.portInventory)
  const blockers = [...host.blockers]
  const warnings = [...host.warnings, ...network.warnings]
  const taskMap = new Map()
  for (const item of Array.isArray(input.hostInventory.tasks)
    ? input.hostInventory.tasks : []) {
    if (!validObject(item) || typeof item.name !== 'string') continue
    const normalized = item.name.trim().toLowerCase()
    if (taskMap.has(normalized)) blockers.push('Repeated scheduled task requires review.')
    taskMap.set(normalized, item)
  }
  for (const name of REQUIRED_TASKS) {
    const found = taskMap.get(name.toLowerCase())
    if (!found || found.enabled !== true) {
      blockers.push('Expected protected task missing or disabled: ' + name)
    }
  }
  if (taskMap.get('family calendar auto deploy')?.enabled === true) {
    blockers.push('LIVE auto-deployer unexpectedly enabled; do not attempt pilot.')
  }

  // The actual TEST port may bind to a Tailnet address rather than loopback.
  // The generic private-preview audit is deliberately stricter than legacy
  // TEST. Report discrepancies for manual routing review, not as permission
  // to change the network or a blanket claim that the old TEST is unsafe.
  if (network.blockers.length) {
    warnings.push('Protected listener audit needs manual review: ' +
      network.blockers.length + ' finding(s). No routing approval.')
  }
  const inspectable = input.hostInventory.taskEnumerationSucceeded === true &&
    input.portInventory.listenerEnumerationSucceeded === true &&
    host.blockers.length === 0 && blockers.length === 0

  return Object.freeze({
    schemaVersion: 1,
    mode: 'existing-test-single-household',
    candidateCommitSha: input.candidateCommitSha,
    inspectedOnly: true,
    hostInventoryPassed: inspectable,
    protectedListenersObserved: network.observedListeners,
    hostBlockers: [...new Set(blockers)],
    networkReviewRequired: true,
    warnings: [...new Set(warnings)],
    requiredBeforeTestCutover: NEXT_GATES,
    realBackupVerified: false,
    isolatedRestoreVerified: false,
    rollbackVerified: false,
    requiredAuthenticationVerified: false,
    ownerAccountVerified: false,
    browserAndMobileAcceptanceVerified: false,
    osWideWriterFencingVerified: false,
    reviewedPinnedTestProcessVerified: false,
    allowedToChangeTest: false,
    allowedToChangeLive: false,
    allowedToChangeMain: false,
    tasksOrFilesModified: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const chunks = []
    let n = 0
    for await (const part of process.stdin) {
      n += part.length
      if (n > 65536) refuse('input was too large.')
      chunks.push(part)
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    process.stdout.write(JSON.stringify(assessOneFamilyTestPilotReadiness(payload), null, 2) + '\n')
  } catch {
    // Do not echo raw input, real local paths, credentials or process args.
    process.stderr.write('One-family TEST preflight refused; no site or data changed.\n')
    process.exitCode = 2
  }
}
