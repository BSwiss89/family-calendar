// DISPOSABLE PRIVATE HOUSEHOLD TEST SERVICES ONLY.
// Atomic directory markers prevent accidentally starting multiple gateway
// instances or multiple backend services for the SAME household data.
//
// These are cooperative same-host guards, NOT hostile-process/OS-level fencing.
// An unclean exit quarantines the lock. A PID or timeout NEVER authorizes
// automatic reclaim, even if the writer appears to have disappeared.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const GATEWAY_LOCK_DIR = '.family-calendar-private-gateway-writer.lock'
const BACKEND_LOCK_DIR = '.family-calendar-private-backend-writer.lock'
const HOUSEHOLD_ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

function acquireWriterDirectoryLock(root, directoryName, kind, collisionMessage) {
  const directory = path.join(root, directoryName)
  const token = randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(collisionMessage)
    throw error
  }
  // If the writer crashes before owner.json is created, the empty directory
  // remains quarantined. The original process must never steal an unknown lock.
  const ownerPath = path.join(directory, 'owner.json')
  fs.writeFileSync(ownerPath, JSON.stringify({
    kind, pid: process.pid, acquiredAt: new Date().toISOString(), token,
  }) + '\n', { flag: 'wx', mode: 0o600 })

  let released = false
  return {
    release() {
      if (released) return
      if (!fs.lstatSync(directory).isDirectory() ||
          fs.lstatSync(directory).isSymbolicLink() ||
          fs.lstatSync(ownerPath).isSymbolicLink() ||
          !fs.lstatSync(ownerPath).isFile()) {
        throw new Error('Private writer ownership changed; lock needs manual review.')
      }
      let owner
      try { owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) } catch {
        throw new Error('Private writer marker unreadable; lock needs manual review.')
      }
      if (owner?.kind !== kind || owner?.token !== token ||
          owner?.pid !== process.pid ||
          fs.readdirSync(directory).join(',') !== 'owner.json') {
        throw new Error('Private writer ownership mismatch; lock needs manual review.')
      }
      fs.unlinkSync(ownerPath)
      fs.rmdirSync(directory)
      released = true
    },
  }
}

export function acquirePrivateGatewayWriterLock(storageRoot) {
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    throw new Error('Private gateway writer lock requires an absolute storage root.')
  }
  const root = fs.realpathSync(storageRoot)
  if (!fs.statSync(root).isDirectory()) {
    throw new Error('Private gateway writer lock storage is not a directory.')
  }
  return acquireWriterDirectoryLock(root, GATEWAY_LOCK_DIR,
    'private-household-gateway-writer',
    'Private gateway writer lock already exists; refuse concurrent startup or unreviewed crash recovery.')
}

// This is called by the explicit test-only private household backend before
// opening SQLite. Each household locks its own pre-provisioned storage home;
// Family A and Family B may run concurrently but Family A cannot start twice.
export function acquirePrivateHouseholdBackendWriterLock(storage) {
  if (storage?.mode !== 'household' ||
      typeof storage.householdId !== 'string' ||
      !HOUSEHOLD_ID.test(storage.householdId) ||
      typeof storage.dataFolder !== 'string' ||
      typeof storage.databasePath !== 'string') {
    throw new Error('Private backend lock requires provisioned household storage.')
  }
  const data = fs.realpathSync(storage.dataFolder)
  const home = path.dirname(data)
  if (!fs.lstatSync(data).isDirectory() ||
      fs.lstatSync(data).isSymbolicLink() ||
      path.basename(data) !== 'data' ||
      path.basename(home) !== storage.householdId ||
      fs.realpathSync(storage.databasePath) !== path.join(data, 'calendar.db')) {
    throw new Error('Private backend writer lock refused a mismatched storage boundary.')
  }
  return acquireWriterDirectoryLock(home, BACKEND_LOCK_DIR,
    'private-household-backend-writer',
    'Private household backend writer lock already exists; refuse duplicate backend startup or unreviewed crash recovery.')
}
