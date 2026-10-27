// ISOLATED PRIVATE HOUSEHOLD TEST RUNTIME ONLY.
// NOT an operating-system service, TEST deployer or public gateway.
// The trusted host explicitly calls these functions; no HTTP request, login,
// invitation, filesystem discovery or scheduler starts a household backend.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { resolveHouseholdStorage } from './household-storage.mjs'
import { listApprovedPrivateHouseholds } from './private-household-activation-records.mjs'

const FIXTURE_BASELINE = Object.freeze(['family-a', 'family-b'])
const GENERATED_ID = /^family-[0-9a-f]{24}$/
const PRIVATE_PORTS = new Set([3001, 13001, 13002, 13003, 11434, 443, 8443])

/**
 * Read CENTRAL approved identities, NOT arbitrary directories or browser data.
 * This disposable fixture has exactly two preconfigured legacy households;
 * every other backend must have a prior, explicit central approval. A stale
 * approval (e.g., its invited owner is disabled) halts startup for review,
 * rather than silently dropping another family's service.
 */
export function planApprovedPrivateHouseholdStartup({
  identityDatabase, serverDirectory, storageRoot,
  baselineHouseholdIds = FIXTURE_BASELINE,
}) {
  if (!Array.isArray(baselineHouseholdIds) ||
      baselineHouseholdIds.length !== FIXTURE_BASELINE.length ||
      baselineHouseholdIds.some((id, index) => id !== FIXTURE_BASELINE[index])) {
    throw new Error('Unreviewed baseline household startup configuration.')
  }
  const approved = listApprovedPrivateHouseholds(identityDatabase)
  const storedApprovals = identityDatabase.prepare(
    'SELECT COUNT(*) AS n FROM private_activated_households'
  ).get().n
  if (storedApprovals !== approved.length) {
    throw new Error('Approved household has inactive or inconsistent ownership; operator review required.')
  }
  if (new Set(approved).size !== approved.length ||
      approved.some(id => !GENERATED_ID.test(id))) {
    throw new Error('Invalid independent household startup approval.')
  }
  const ids = [...FIXTURE_BASELINE, ...approved]
  for (const householdId of ids) {
    const registry = identityDatabase.prepare(
      'SELECT id FROM household_registry WHERE storage_id = ? AND disabled = 0'
    ).get(householdId)
    if (!registry) throw new Error('Missing active household identity registry.')
    // This validates the provisioned SQLite and uploads, containment, and
    // symlink boundaries without creating, replacing or deleting any data.
    resolveHouseholdStorage({ serverDirectory, storageRoot, householdId })
  }
  return Object.freeze({ householdIds: Object.freeze(ids) })
}

/**
 * Locks are cooperative only. Never reclaim an abandoned lock because a PID
 * is missing, stale or unresponsive. A separate reviewed, offline recovery
 * process must establish exclusive ownership after any crash.
 */
export function assertPrivateStartupLocksClear({
  serverDirectory, storageRoot, householdIds,
}) {
  if (!Array.isArray(householdIds) || householdIds.length < 2 ||
      new Set(householdIds).size !== householdIds.length) {
    throw new Error('Invalid supervised household startup lock scope.')
  }
  const root = fs.realpathSync(storageRoot)
  if (fs.existsSync(path.join(root, '.family-calendar-private-gateway-writer.lock'))) {
    throw new Error('Private gateway lock still exists; restart requires review.')
  }
  for (const householdId of householdIds) {
    const storage = resolveHouseholdStorage({ serverDirectory, storageRoot, householdId })
    const lock = path.join(path.dirname(storage.dataFolder),
      '.family-calendar-private-backend-writer.lock')
    if (fs.existsSync(lock)) {
      throw new Error('Private backend lock still exists; restart requires review.')
    }
  }
  return { locksClear: true, recoveryApproved: false }
}

/**
 * Spawn only the already-reviewed startup plan. An actual private backend is
 * considered started ONLY after its captured child handle is returned and
 * verified healthy. Keep secrets entirely in the trusted host process.
 * On any failure, stop ONLY captured children and require confirmed exits.
 * Never start a half-configured gateway or clear foreign writer locks.
 */
export async function launchApprovedPrivateHouseholdBackends({
  plan, usedPorts, allocateLoopbackPort, launchBackend, awaitHealthyBackend,
  stopBackend, previousTokens = {},
}) {
  const ids = plan?.householdIds
  if (!Object.isFrozen(plan) || !Object.isFrozen(ids) ||
      !Array.isArray(ids) || ids.length < 2 ||
      ids[0] !== 'family-a' || ids[1] !== 'family-b' ||
      new Set(ids).size !== ids.length ||
      ids.slice(2).some(id => typeof id !== 'string' || !GENERATED_ID.test(id)) ||
      !(usedPorts instanceof Set) ||
      [allocateLoopbackPort, launchBackend, awaitHealthyBackend, stopBackend]
        .some(callback => typeof callback !== 'function')) {
    throw new Error('Unreviewed private supervisor launch configuration.')
  }
  const backends = []
  const backendPorts = {}
  const backendTokens = {}
  const seen = new Set(usedPorts)
  try {
    for (const householdId of ids) {
      const port = await allocateLoopbackPort(usedPorts)
      if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 ||
          PRIVATE_PORTS.has(port) || seen.has(port)) {
        throw new Error('Private supervisor refused unsafe or reused port.')
      }
      seen.add(port)
      usedPorts.add(port)
      let token
      do { token = randomBytes(32).toString('hex') }
      while (token === previousTokens[householdId] ||
        Object.values(backendTokens).includes(token))
      const backend = await launchBackend({ householdId, port, upstreamToken: token })
      // Capture any returned process handle BEFORE checking identity so a
      // malformed or mismatched result cannot escape supervised cleanup.
      if (backend?.child) backends.push(backend)
      if (!backend || backend.householdId !== householdId || !backend.child) {
        throw new Error('Private supervisor did not capture expected child handle.')
      }
      backendPorts[householdId] = port
      backendTokens[householdId] = token
      await awaitHealthyBackend(backend)
    }
  } catch (startupError) {
    const failures = [startupError]
    for (const backend of [...backends].reverse()) {
      try { await stopBackend(backend) } catch (error) { failures.push(error) }
    }
    if (failures.length > 1) {
      throw new AggregateError(failures,
        'Private startup failed and captured backend shutdown is unverified.')
    }
    throw startupError
  }
  return { backends, backendPorts, backendTokens }
}
