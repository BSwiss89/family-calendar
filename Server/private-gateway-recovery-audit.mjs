// READ-ONLY INSPECTION FOR ISOLATED PRIVATE HOUSEHOLD TEST FIXTURES.
// This module NEVER removes a writer lock, stops processes, recovers a DB,
// serves a request or authorizes a restart. A dead PID is NOT a fencing proof.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveHouseholdStorage } from './household-storage.mjs'

const LOCK_NAME = '.family-calendar-private-gateway-writer.lock'
const OWNER_KIND = 'private-household-gateway-writer'
const HOUSEHOLD_ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

function regular(p, expected) {
  const stat = fs.lstatSync(p)
  if (stat.isSymbolicLink() || !(expected === 'file' ? stat.isFile() : stat.isDirectory())) {
    throw new Error('Recovery audit refused an unsafe or unexpected file type.')
  }
  return fs.realpathSync(p)
}

function sqliteStatus(filename) {
  let db
  try {
    db = new DatabaseSync(regular(filename, 'file'), { readOnly: true })
    db.exec('PRAGMA query_only = ON')
    const check = db.prepare('PRAGMA quick_check').all()
    if (check.length !== 1 || check[0].quick_check !== 'ok') {
      return { intact: false, reason: 'SQLite quick_check failed' }
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) {
      return { intact: false, reason: 'SQLite foreign_key_check failed' }
    }
    return { intact: true }
  } catch {
    return { intact: false, reason: 'SQLite file could not be verified read-only' }
  } finally {
    db?.close()
  }
}

function inspectPid(pid) {
  try {
    process.kill(pid, 0)
    return 'running-or-access-denied'
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return 'running-or-access-denied'
    if (error?.code === 'ESRCH') return 'not-found-at-inspection'
    return 'unknown'
  }
}

export function auditPrivateGatewayAbandonedLock({
  serverDirectory, storageRoot, centralDatabasePath,
}) {
  if (typeof serverDirectory !== 'string' || typeof storageRoot !== 'string' ||
      !path.isAbsolute(storageRoot) || typeof centralDatabasePath !== 'string' ||
      !path.isAbsolute(centralDatabasePath)) {
    throw new Error('Recovery audit requires explicit absolute private fixture paths.')
  }
  const root = regular(storageRoot, 'directory')
  const checkout = path.dirname(fs.realpathSync(regular(serverDirectory, 'directory')))
  const delta = path.relative(checkout, root)
  if (delta === '' || (delta !== '..' && !delta.startsWith('..' + path.sep) &&
      !path.isAbsolute(delta))) {
    throw new Error('Recovery audit cannot inspect an application checkout.')
  }
  const directory = path.join(root, LOCK_NAME)
  regular(directory, 'directory')
  if (fs.readdirSync(directory).join(',') !== 'owner.json') {
    throw new Error('Recovery audit refused an incomplete or modified writer lock.')
  }
  const ownerPath = regular(path.join(directory, 'owner.json'), 'file')
  if (fs.statSync(ownerPath).size > 1024) {
    throw new Error('Recovery audit refused an oversized owner marker.')
  }
  let owner
  try { owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) } catch {
    throw new Error('Recovery audit refused an unreadable owner marker.')
  }
  if (owner?.kind !== OWNER_KIND || !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 || typeof owner.token !== 'string' ||
      !/^[0-9a-f]{64}$/.test(owner.token) ||
      typeof owner.acquiredAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(owner.acquiredAt) ||
      !Number.isFinite(Date.parse(owner.acquiredAt))) {
    throw new Error('Recovery audit refused malformed writer ownership metadata.')
  }

  // A PID is only a diagnostic. Even a missing PID does not prove that a
  // restarted child backend or an unrelated SQLite writer has stopped.
  const ownerProcess = inspectPid(owner.pid)
  const issues = []
  if (ownerProcess !== 'not-found-at-inspection') {
    issues.push('Previous owner is running or its process state is unknown.')
  }
  const centralPath = regular(centralDatabasePath, 'file')
  const centralReal = path.relative(root, centralPath)
  if (centralReal === '' || (!centralReal.startsWith('..' + path.sep) &&
      centralReal !== '..' && !path.isAbsolute(centralReal))) {
    throw new Error('Central identity database must be separate from household storage.')
  }
  const centralCheck = sqliteStatus(centralPath)
  if (!centralCheck.intact) issues.push('Central identity SQLite could not pass integrity review.')

  let registered = []
  let pendingSourceSync = null
  if (centralCheck.intact) {
    const db = new DatabaseSync(centralPath, { readOnly: true })
    try {
      db.exec('PRAGMA query_only = ON')
      registered = db.prepare('SELECT storage_id FROM household_registry ORDER BY storage_id')
        .all().map(r => r.storage_id)
      pendingSourceSync = db.prepare('SELECT COUNT(*) AS n FROM event_share_sync_pending')
        .get().n
      if (!Number.isSafeInteger(pendingSourceSync) || pendingSourceSync < 0) {
        issues.push('Invalid source event sync count.')
      } else if (pendingSourceSync > 0) {
        issues.push('Event-sharing source changes await verified replay after fencing.')
      }
    } catch {
      issues.push('Central household registry or source-sync tables could not be verified.')
    } finally { db.close() }
  }
  const households = []
  try {
    const folder = regular(path.join(root, 'households'), 'directory')
    const children = fs.readdirSync(folder).sort()
    if (children.length === 0 || children.length > 1000 ||
        children.some(id => !HOUSEHOLD_ID.test(id)) ||
        registered.length !== children.length ||
        registered.some((id, i) => id !== children[i])) {
      issues.push('Central registry and household storage directory differ.')
    }
    for (const id of children) {
      if (!HOUSEHOLD_ID.test(id)) continue
      try {
        const storage = resolveHouseholdStorage({
          serverDirectory, storageRoot: root, householdId: id,
        })
        const status = sqliteStatus(storage.databasePath)
        households.push({ householdId: id, intact: status.intact })
        if (!status.intact) issues.push('Household SQLite integrity failed: ' + id)
      } catch {
        households.push({ householdId: id, intact: false })
        issues.push('Household storage boundary could not be verified: ' + id)
      }
    }
  } catch {
    issues.push('Household storage directory could not be inspected.')
  }
  for (const filename of [centralPath, ...households.map(h =>
    path.join(root, 'households', h.householdId, 'data', 'calendar.db'))]) {
    if (fs.existsSync(filename + '-wal') || fs.existsSync(filename + '-journal')) {
      issues.push('SQLite recovery sidecar requires offline operator review.')
    }
  }
  // Deliberately never return the secret marker token or imply safe auto-unlock.
  return {
    lockPresent: true,
    ownerPid: owner.pid,
    ownerProcess,
    householdChecks: households,
    centralIntegrity: centralCheck.intact,
    pendingSourceSync,
    issues,
    requiresOperatorFencing: true,
    canAutomaticallyReclaim: false,
  }
}
