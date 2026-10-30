// DISPOSABLE, OFFLINE-ONLY coordinated backup CAPTURE rehearsal.
// This is deliberately restricted to fresh OS-temp fixtures. It NEVER opens
// any installed calendar backup directory, live SQLite, Windows service/task,
// TEST release, or browser-controlled path. Production writer fencing and
// production snapshot acquisition are NOT implemented or authorized here.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  attestOfflinePrivateRestoreSet,
  verifyOfflinePrivateRestoreSet,
} from './private-restore-preflight.mjs'

const MARKER = '.family-calendar-restore-review.json'
const HOUSEHOLD = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const MAX_FILES = 50000

function fail(message) {
  throw new Error('Disposable coordinated backup refused: ' + message)
}

function within(parent, child) {
  const a = process.platform === 'win32' ? parent.toLowerCase() : parent
  const b = process.platform === 'win32' ? child.toLowerCase() : child
  const relative = path.relative(a, b)
  return relative === '' || (relative !== '..' &&
    !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

function realFolder(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    fail('absolute existing folders are required.')
  }
  const stat = fs.lstatSync(value)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('source or parent folder is a link or not a directory.')
  }
  return fs.realpathSync(value)
}

function validateTemporaryPaths(serverDirectory, sourceRoot, destinationRoot) {
  if (typeof serverDirectory !== 'string' || !path.isAbsolute(serverDirectory) ||
      typeof destinationRoot !== 'string' || !path.isAbsolute(destinationRoot)) {
    fail('explicit absolute checkout, source and destination paths are required.')
  }
  const checkout = path.dirname(fs.realpathSync(serverDirectory))
  const temp = realFolder(os.tmpdir())
  const source = realFolder(sourceRoot)
  const destination = path.resolve(destinationRoot)
  const parent = realFolder(path.dirname(destination))
  // This guard is intentional, and may not be removed to deploy this code.
  // A real operator-approved live acquisition must be a separate design.
  if ([source, destination, parent].some(p => p === temp || !within(temp, p)) ||
      within(checkout, source) || within(source, checkout) ||
      within(checkout, destination) || within(destination, checkout) ||
      within(source, destination) || within(destination, source) ||
      within(source, parent)) {
    fail('only separate disposable OS-temp staging outside checkout is permitted.')
  }
  if (fs.existsSync(destination) || fs.existsSync(destination + '.capture-lock')) {
    fail('snapshot destination or exclusive reservation already exists.')
  }
  return { source, destination, parent }
}

function assertEntry(root, relative, type) {
  const filename = path.join(root, ...relative.split('/'))
  const stat = fs.lstatSync(filename)
  if (stat.isSymbolicLink() || !within(root, fs.realpathSync(filename))) {
    fail('staging links or paths outside the source are forbidden.')
  }
  if ((type === 'file' && !stat.isFile()) ||
      (type === 'directory' && !stat.isDirectory())) {
    fail('source has an unexpected file type.')
  }
  return filename
}

function exact(root, relative, expected) {
  const location = relative === '.' ? root : assertEntry(root, relative, 'directory')
  const actual = fs.readdirSync(location).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    fail('unrecognized or missing files in source: ' + relative)
  }
}

function collectUploads(root, subdir, output) {
  assertEntry(root, subdir, 'directory')
  for (const name of fs.readdirSync(path.join(root, ...subdir.split('/'))).sort()) {
    const relative = subdir + '/' + name
    const full = path.join(root, ...relative.split('/'))
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) fail('uploaded file links are forbidden.')
    if (stat.isDirectory()) {
      collectUploads(root, relative, output)
    } else if (stat.isFile()) {
      assertEntry(root, relative, 'file')
      output.push(relative)
    } else {
      fail('unsupported uploaded file type.')
    }
    if (output.length > MAX_FILES) fail('snapshot file count exceeds limit.')
  }
}

function sourceInventory(root) {
  // A source snapshot must already be OFFLINE and checkpointed by an
  // independent operator. This function cannot establish writer quiescence.
  exact(root, '.', ['central', 'households'])
  exact(root, 'central', ['identity.db'])
  const slugs = fs.readdirSync(assertEntry(root, 'households', 'directory')).sort()
  if (slugs.length < 1 || slugs.length > 1000 ||
      slugs.some(slug => !HOUSEHOLD.test(slug))) {
    fail('expected one or more valid staged households.')
  }
  const paths = ['central/identity.db']
  for (const slug of slugs) {
    const home = 'households/' + slug
    exact(root, home, ['.family-calendar-household.json', 'data', 'uploads'])
    exact(root, home + '/data', ['calendar.db'])
    paths.push(home + '/.family-calendar-household.json')
    paths.push(home + '/data/calendar.db')
    collectUploads(root, home + '/uploads', paths)
  }
  if (paths.length > MAX_FILES) fail('snapshot file count exceeds limit.')
  return { slugs, paths: paths.sort() }
}

function hashFile(filename) {
  const fd = fs.openSync(filename, 'r')
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (count === 0) break
      digest.update(buffer.subarray(0, count))
    }
  } finally { fs.closeSync(fd) }
  return digest.digest('hex')
}

/**
 * Build a NEW, complete and internally reconciled offline backup set.
 * The caller MUST first stop ALL source writers and checkpoint SQLite.
 * This operation cannot prove they are stopped: only disposable OS-temp
 * fixtures are accepted. A trusted operator must store the returned
 * attestation OUTSIDE the snapshot, in a separately protected catalog.
 */
export function captureDisposableCoordinatedHouseholdSnapshot({
  serverDirectory, sourceRoot, destinationRoot,
}) {
  const { source, destination, parent } = validateTemporaryPaths(
    serverDirectory, sourceRoot, destinationRoot)
  const inventory = sourceInventory(source)
  const reservation = destination + '.capture-lock'
  const lock = fs.openSync(reservation, 'wx', 0o600)
  let stage = null
  try {
    fs.closeSync(lock)
    stage = fs.mkdtempSync(path.join(parent, '.family-calendar-snapshot-'))
    // Only the copy under a new, exclusive temporary directory can receive
    // the restore marker. The source is never changed or sanitized.
    fs.writeFileSync(path.join(stage, MARKER), JSON.stringify({
      kind: 'private-household-offline-restore-review', version: 1,
    }) + '\n', { flag: 'wx', mode: 0o600 })

    const originals = new Map()
    for (const relative of inventory.paths) {
      const original = assertEntry(source, relative, 'file')
      const before = hashFile(original)
      const into = path.join(stage, ...relative.split('/'))
      fs.mkdirSync(path.dirname(into), { recursive: true })
      fs.copyFileSync(original, into, fs.constants.COPYFILE_EXCL)
      const copied = hashFile(into)
      const after = hashFile(assertEntry(source, relative, 'file'))
      if (before !== copied || after !== before) {
        fail('offline source changed during snapshot copy.')
      }
      originals.set(relative, before)
    }
    for (const slug of inventory.slugs) {
      fs.mkdirSync(path.join(stage, 'households', slug, 'uploads'),
        { recursive: true })
    }

    // Existing preflight rejects orphaned WALs, mixed shared-event state,
    // stale sessions, unresolved outboxes and corrupt SQLite. The attestation
    // is returned, never saved inside the backup it authenticates.
    const attestation = attestOfflinePrivateRestoreSet({
      serverDirectory, restoreRoot: stage,
    })
    verifyOfflinePrivateRestoreSet({
      serverDirectory, restoreRoot: stage,
    }, attestation)

    const again = sourceInventory(source)
    if (JSON.stringify(again) !== JSON.stringify(inventory)) {
      fail('source file inventory changed during capture.')
    }
    for (const [relative, originalHash] of originals) {
      if (hashFile(assertEntry(source, relative, 'file')) !== originalHash) {
        fail('source changed after staged attestation.')
      }
    }
    if (fs.existsSync(destination)) fail('snapshot destination appeared.')
    fs.renameSync(stage, destination)
    stage = null
    return {
      snapshotRoot: destination,
      attestation,
      householdCount: inventory.slugs.length,
      fileCount: attestation.files.length,
      capturedFromDisposableOfflineStage: true,
      sourceWritersVerifiedStopped: false,
      productionBackupAuthorized: false,
    }
  } finally {
    // No existing backup is overwritten. The only deleted files are a
    // temporary stage and reservation created by this invocation.
    if (stage !== null) fs.rmSync(stage, { recursive: true, force: true })
    fs.rmSync(reservation, { force: true })
  }
}
