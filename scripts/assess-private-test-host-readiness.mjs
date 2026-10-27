// READ-ONLY readiness review for a separately approved future Windows TEST
// household pilot. This program NEVER starts, stops, installs, or deploys
// anything and never declares a multi-family deployment authorized.
// Expects a sanitized inventory from scripts/inspect-private-test-host.ps1,
// or synthetic input when run in CI. Never echo raw inventory or secrets.
import { pathToFileURL } from 'node:url'

const SHA = /^[a-f0-9]{40}$/
const PROTECTED_TASK = /family[ -]?calendar/i

function checkoutSafe(value) {
  return value && typeof value === 'object' &&
    value.exists === true && value.gitRepo === true &&
    value.trackedAndUntrackedClean === true &&
    value.reparsePoint === false && SHA.test(value.headSha)
}

/**
 * A PASS here establishes ONLY that some read-only prerequisites were
 * observed, NOT account migration, backup integrity, SSL routing or release
 * approval. Unknown inventory data fails closed.
 */
export function assessPrivateTestHostReadiness(inventory) {
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory) ||
      inventory.schemaVersion !== 1) {
    throw new Error('Private TEST readiness requires a versioned host inventory.')
  }
  const blockers = []
  const warnings = []
  if (inventory.platform !== 'win32') {
    blockers.push('Review on the Windows server has not been verified.')
  }
  if (inventory.taskEnumerationSucceeded !== true ||
      !Array.isArray(inventory.tasks)) {
    blockers.push('Existing Windows Task Scheduler inventory is unavailable.')
  }
  if (inventory.distinctCheckouts !== true) {
    blockers.push('LIVE and TEST checkout isolation is unverified.')
  }
  for (const site of ['live', 'test']) {
    if (!checkoutSafe(inventory.checkouts?.[site])) {
      blockers.push(site.toUpperCase() +
        ' checkout existence, cleanliness and Git identity are unverified.')
    }
  }
  if (inventory.checkouts?.live?.headSha &&
      inventory.checkouts.live.headSha === inventory.checkouts?.test?.headSha) {
    warnings.push('LIVE and TEST currently have matching Git revisions; their data and URL isolation still require separate verification.')
  }
  if (Array.isArray(inventory.tasks)) {
    const seen = new Set()
    for (const task of inventory.tasks) {
      if (!task || typeof task.name !== 'string' ||
          task.name.length < 1 || task.name.length > 128 ||
          !PROTECTED_TASK.test(task.name) ||
          typeof task.enabled !== 'boolean' ||
          !Number.isSafeInteger(task.restartCount) || task.restartCount < 0) {
        blockers.push('A calendar task has incomplete or unsafe metadata.')
        continue
      }
      const key = task.name.toLowerCase()
      if (seen.has(key)) blockers.push('Duplicate calendar task names require operator review.')
      seen.add(key)
      if (/private[ -]?household[ -]?supervisor/i.test(task.name)) {
        blockers.push('An existing private household supervisor task must be reviewed before installing another.')
        if (task.restartCount > 0) blockers.push('A private supervisor task is configured for unattended restart after failure.')
      }
    }
  }
  // The host inventory cannot attest HTTPS/Tailscale ownership, migration,
  // rollback, power policy or OS-wide SQLite writer fencing. Fail closed.
  const requiredManualGates = Object.freeze([
    'Operator-approved, separately installed Windows startup supervisor',
    'OS-level process identity and writer-fencing verification',
    'Test-only coordinated backup and successful isolated restore',
    'One-household account migration and session-continuity rehearsal',
    'Explicit existing TEST HTTPS routing and release-denylist cutover approval',
    'Unattended laptop wake, lid, power, connectivity and startup verification',
    'Independent family login, events, Lists and sharing acceptance tests',
  ])
  return {
    schemaVersion: 1,
    inspectedOnly: true,
    hostInventoryPassed: blockers.length === 0,
    blockers,
    warnings,
    requiredManualGates,
    authorizedToMergeMain: false,
    authorizedToDeployTest: false,
    authorizedToDeployLive: false,
    taskOrServiceInstalledByThisAudit: false,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks = []
  let size = 0
  try {
    for await (const part of process.stdin) {
      size += part.length
      if (size > 65536) throw new Error('Readiness inventory exceeded the size limit.')
      chunks.push(part)
    }
    const snapshot = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    process.stdout.write(JSON.stringify(assessPrivateTestHostReadiness(snapshot), null, 2) + '\n')
  } catch {
    // Do not echo untrusted raw JSON, paths, credentials or task arguments.
    process.stderr.write('Private TEST readiness inventory rejected; no site changed.\n')
    process.exitCode = 2
  }
}
