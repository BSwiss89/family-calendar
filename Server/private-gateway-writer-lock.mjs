// DISPOSABLE PRIVATE HOUSEHOLD TEST GATEWAY ONLY.
// Atomic directory ownership serializes gateway instances that share the same
// trusted household storage root. This is NOT OS process fencing: a privileged
// or same-user attacker could remove the directory, and household backend
// processes still require separate supervision.
//
// An unclean termination intentionally leaves a persistent lock. Never
// automatically steal a "stale" lock using a PID or timeout: a backend or
// sibling process may still be completing a SQLite write. Manual operator
// inspection and explicit cleanup are required before a safe restart.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const LOCK_DIR = '.family-calendar-private-gateway-writer.lock'

export function acquirePrivateGatewayWriterLock(storageRoot) {
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    throw new Error('Private gateway writer lock requires an absolute storage root.')
  }
  const root = fs.realpathSync(storageRoot)
  if (!fs.statSync(root).isDirectory()) {
    throw new Error('Private gateway writer lock storage is not a directory.')
  }
  const directory = path.join(root, LOCK_DIR)
  const token = randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('Private gateway writer lock already exists; refuse concurrent startup or unreviewed crash recovery.')
    }
    throw error
  }
  // A crash before creating the owner marker leaves an intentionally
  // quarantined directory instead of an automatically reusable lock.
  const ownerPath = path.join(directory, 'owner.json')
  fs.writeFileSync(ownerPath, JSON.stringify({
    kind: 'private-household-gateway-writer',
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    token,
  }) + '\n', { flag: 'wx', mode: 0o600 })

  let released = false
  return {
    release() {
      if (released) return
      // Do not remove a replacement/tampered lock or any unknown directory.
      if (!fs.lstatSync(directory).isDirectory() ||
          fs.lstatSync(ownerPath).isSymbolicLink() ||
          !fs.lstatSync(ownerPath).isFile()) {
        throw new Error('Private gateway writer ownership changed; lock needs manual review.')
      }
      let owner
      try { owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) } catch {
        throw new Error('Private gateway writer marker unreadable; lock needs manual review.')
      }
      if (owner?.kind !== 'private-household-gateway-writer' || owner?.token !== token ||
          owner?.pid !== process.pid || fs.readdirSync(directory).join(',') !== 'owner.json') {
        throw new Error('Private gateway writer ownership mismatch; lock needs manual review.')
      }
      fs.unlinkSync(ownerPath)
      fs.rmdirSync(directory)
      released = true
    },
  }
}
