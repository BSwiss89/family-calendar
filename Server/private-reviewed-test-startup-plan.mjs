// DEV-ONLY candidate for the *real* first-family household, not demo family-a/b.
// Selects a reviewed primary household and separately approved invited owners
// from a central identity database. No tasks, processes, services, listeners,
// directories, SQLite writes, deploys or automatic recovery are performed here.
// DO NOT route a public or TEST HTTPS endpoint through this planning module.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { listApprovedPrivateHouseholds } from './private-household-activation-records.mjs'
import { resolveHouseholdStorage } from './household-storage.mjs'
import { inspectPrivateWindowsSupervisorHold } from './private-windows-supervisor-crash-hold.mjs'

const HOUSEHOLD = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const INVITED = /^family-[0-9a-f]{24}$/
const GATEWAY_LOCK = '.family-calendar-private-gateway-writer.lock'
const BACKEND_LOCK = '.family-calendar-private-backend-writer.lock'

function refuse(message) {
  throw new Error('Reviewed private TEST startup refused: ' + message)
}

function validatedPrimary(value) {
  if (typeof value !== 'string' || !HOUSEHOLD.test(value) || INVITED.test(value) ||
      value === 'family-a' || value === 'family-b') {
    refuse('a separately reviewed non-demo primary household ID is required.')
  }
  return value
}

function validatedStorage(serverDirectory, storageRoot, id) {
  const resolved = resolveHouseholdStorage({ serverDirectory, storageRoot, householdId: id })
  const root = fs.realpathSync(storageRoot)
  // These locks must be assessed BEFORE any backend is launched. Never unlink
  // abandoned locks simply because the process recorded in them has exited.
  const home = path.dirname(resolved.dataFolder)
  if (fs.existsSync(path.join(home, BACKEND_LOCK))) {
    refuse('a household writer lock needs manual recovery review.')
  }
  if (!fs.lstatSync(resolved.databasePath).isFile()) {
    refuse('household database is not a regular file.')
  }
  return resolved
}

function assertReadOnlySqliteIntegrity(db) {
  const check = db.prepare('PRAGMA quick_check').all()
  if (check.length !== 1 || check[0].quick_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    refuse('central or household SQLite integrity verification failed.')
  }
}

/**
 * Reads a separate central identity DB previously opened by the trusted
 * operator. A valid ID is not itself authorization: every active identity
 * registry entry must either be the explicit primary or a prior approved,
 * redeemed independent household with an active invited owner.
 *
 * The primary household and data root are NEVER auto-discovered from the
 * filesystem, a browser, invitation or a Task Scheduler environment variable.
 *
 * A passing plan is NOT evidence of OS-level exclusive writer ownership,
 * successful migration, session continuity, backup consistency or routing.
 */
export function planReviewedPrivateTestStartup({
  identityDatabase, serverDirectory, storageRoot, stateDirectory,
  primaryHouseholdId,
}) {
  const primary = validatedPrimary(primaryHouseholdId)
  if (!(identityDatabase instanceof DatabaseSync)) {
    refuse('the trusted operator must supply an opened central SQLite database.')
  }
  if (typeof serverDirectory !== 'string' || typeof storageRoot !== 'string' ||
      typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)) {
    refuse('reviewed absolute application and state paths are required.')
  }
  const state = fs.realpathSync(stateDirectory)
  if (!fs.statSync(state).isDirectory() ||
      fs.lstatSync(stateDirectory).isSymbolicLink()) {
    refuse('supervisor state directory must be an existing real directory.')
  }
  const root = fs.realpathSync(storageRoot)
  const checkout = path.dirname(fs.realpathSync(serverDirectory))
  const overlap = (a, b) => {
    const relative = path.relative(a, b)
    return relative === '' || (relative !== '..' &&
      !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  }
  if (overlap(root, state) || overlap(state, root) ||
      overlap(checkout, state) || overlap(state, checkout)) {
    refuse('supervisor state, household data, and source checkout must be separate.')
  }
  if (fs.existsSync(path.join(root, GATEWAY_LOCK))) {
    refuse('gateway writer lock needs manual recovery review.')
  }
  if (inspectPrivateWindowsSupervisorHold(state).held) {
    refuse('durable supervisor crash hold needs manual review.')
  }
  assertReadOnlySqliteIntegrity(identityDatabase)
  const registered = identityDatabase.prepare([
    'SELECT id, storage_id AS householdId, disabled',
    'FROM household_registry ORDER BY storage_id',
  ].join(' ')).all()
  if (registered.length < 1 || registered.length > 1000 ||
      registered.some(row => row.disabled !== 0 ||
        typeof row.householdId !== 'string' || !HOUSEHOLD.test(row.householdId)) ||
      new Set(registered.map(x => x.householdId)).size !== registered.length) {
    refuse('household registry contains missing, disabled or invalid entries.')
  }
  const primaryEntry = registered.find(row => row.householdId === primary)
  if (!primaryEntry) refuse('reviewed primary is absent from the identity registry.')

  // Require a currently authorized owner before allowing any family to boot.
  const owners = identityDatabase.prepare([
    'SELECT h.storage_id AS householdId, COUNT(*) AS owners',
    'FROM household_registry h',
    'JOIN household_memberships m ON m.household_id = h.id',
    'JOIN family_users u ON u.id = m.user_id',
    "WHERE m.role = 'owner' AND m.disabled = 0 AND u.disabled = 0",
    'GROUP BY h.storage_id',
  ].join(' ')).all()
  const ownerMap = new Map(owners.map(row => [row.householdId, row.owners]))
  if (registered.some(row => !Number.isSafeInteger(ownerMap.get(row.householdId)) ||
      ownerMap.get(row.householdId) < 1)) {
    refuse('an active household is missing an active owner.')
  }
  // One-household-per-login: refuse duplicate memberships (including disabled).
  const multiple = identityDatabase.prepare([
    'SELECT user_id FROM household_memberships GROUP BY user_id',
    'HAVING COUNT(*) > 1 LIMIT 1',
  ].join(' ')).get()
  if (multiple) refuse('one login is linked to more than one household.')

  const approved = listApprovedPrivateHouseholds(identityDatabase)
  const numberApproved = identityDatabase.prepare(
    'SELECT COUNT(*) AS n FROM private_activated_households'
  ).get().n
  if (numberApproved !== approved.length || new Set(approved).size !== approved.length) {
    refuse('a friend activation is stale, disabled or inconsistent.')
  }
  const invited = registered.filter(row => row.householdId !== primary)
    .map(row => row.householdId)
  if (invited.some(id => !INVITED.test(id) || !approved.includes(id)) ||
      approved.some(id => !invited.includes(id))) {
    refuse('an active friend household lacks explicit trusted activation.')
  }

  const ordered = [primary, ...invited.sort()]
  const files = new Set()
  for (const householdId of ordered) {
    const storage = validatedStorage(serverDirectory, storageRoot, householdId)
    if (files.has(storage.databasePath.toLowerCase())) {
      refuse('two households resolve to the same SQLite database.')
    }
    files.add(storage.databasePath.toLowerCase())
    const db = new DatabaseSync(storage.databasePath, { readOnly: true })
    try { assertReadOnlySqliteIntegrity(db) }
    finally { db.close() }
  }
  return Object.freeze({
    kind: 'reviewed-private-test-startup-plan-v1',
    primaryHouseholdId: primary,
    householdIds: Object.freeze(ordered),
    householdCount: ordered.length,
    planVerifiedReadOnly: true,
    osWideWriterOwnershipVerified: false,
    taskSchedulerInstalled: false,
    deploymentAuthorized: false,
  })
}
