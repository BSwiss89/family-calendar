// PRIVATE TEST-ONLY offline backup/restore COPY rehearsal.
//
// NEVER copies from a running service, selects a household based on HTTP
// input, replaces an existing directory, or promotes a backup to production.
// The source must be a separate, complete, quiesced OFFLINE staging snapshot
// that passes private-restore-preflight AND matches the independently saved
// backup-time attestation. Snapshot acquisition and production cutover are
// deliberately NOT implemented.
//
// No account/session or storage changes are made to any source database.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { verifyOfflinePrivateRestoreSet } from './private-restore-preflight.mjs'

function refuse(message) {
  throw new Error('Offline restore rehearsal refused: ' + message)
}

function safelyOutsideCheckout(serverDirectory, candidate) {
  if (typeof serverDirectory !== 'string'
      || typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    refuse('absolute offline paths are required.')
  }
  const checkout = path.dirname(fs.realpathSync(serverDirectory))
  const relative = path.relative(checkout, candidate)
  if (!relative || (!relative.startsWith('..' + path.sep)
      && relative !== '..' && !path.isAbsolute(relative))) {
    refuse('restore destination must be outside application checkout.')
  }
}

function isInside(parent, item) {
  const relative = path.relative(parent, item)
  return relative === '' || (relative !== '..' &&
    !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

function validatedInventoryPath(relative) {
  if (typeof relative !== 'string' || relative.length > 1024
      || !/^[a-zA-Z0-9._/-]+$/.test(relative)
      || relative.startsWith('/') || relative.includes('\\')
      || relative.split('/').some(p => !p || p === '.' || p === '..')) {
    refuse('untrusted file path in backup inventory.')
  }
  return relative.split('/')
}

/**
 * Copy an independently approved complete backup into a NEW, isolated folder
 * for restore rehearsals. No existing target may be overwritten.
 *
 * Two separate source inspections catch many accidental concurrent changes;
 * this is NOT a substitute for quiescing all source writers and checkpointing
 * SQLite before the source backup was made. On failed validation, staging
 * artifacts owned by this function are removed and the target is untouched.
 */
export function copyVerifiedPrivateRestoreSet({
  serverDirectory, sourceRoot, destinationRoot, approvedAttestation,
}) {
  if (typeof sourceRoot !== 'string' || typeof destinationRoot !== 'string' ||
      !path.isAbsolute(sourceRoot) || !path.isAbsolute(destinationRoot)) {
    refuse('absolute offline source and destination are required.')
  }
  const source = fs.realpathSync(sourceRoot)
  const destination = path.resolve(destinationRoot)
  const parent = fs.realpathSync(path.dirname(destination))
  safelyOutsideCheckout(serverDirectory, destination)
  safelyOutsideCheckout(serverDirectory, parent)
  if (fs.existsSync(destination) || fs.existsSync(destination + '.restore-lock')) {
    refuse('restore destination or reservation already exists.')
  }
  if (isInside(source, destination) || isInside(destination, source) ||
      isInside(source, parent)) {
    refuse('source and restore destination directories must not overlap.')
  }
  // Never read any file bytes before validating the independently approved
  // backup snapshot, its SQLite data, and its complete file inventory.
  verifyOfflinePrivateRestoreSet({
    serverDirectory, restoreRoot: source,
  }, approvedAttestation)

  const reservation = destination + '.restore-lock'
  const lock = fs.openSync(reservation, 'wx', 0o600)
  let temporary = null
  try {
    fs.closeSync(lock)
    temporary = fs.mkdtempSync(path.join(parent, '.private-restore-review-'))
    const copyList = approvedAttestation.files
    for (const file of copyList) {
      const parts = validatedInventoryPath(file.path)
      const relative = parts.join(path.sep)
      const original = path.join(source, relative)
      const into = path.join(temporary, relative)
      if (!fs.lstatSync(original).isFile()) refuse('source file is not regular.')
      fs.mkdirSync(path.dirname(into), { recursive: true })
      fs.copyFileSync(original, into, fs.constants.COPYFILE_EXCL)
    }
    // Empty household upload folders must exist even when inventory contains
    // no upload files; also preserve complete approved directory structure.
    for (const slug of approvedAttestation.households) {
      if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
        refuse('untrusted household in backup attestation.')
      }
      fs.mkdirSync(path.join(temporary, 'households', slug, 'uploads'), {
        recursive: true,
      })
    }
    verifyOfflinePrivateRestoreSet({
      serverDirectory, restoreRoot: temporary,
    }, approvedAttestation)
    verifyOfflinePrivateRestoreSet({
      serverDirectory, restoreRoot: source,
    }, approvedAttestation)
    if (fs.existsSync(destination)) refuse('destination appeared during copy.')
    fs.renameSync(temporary, destination)
    temporary = null
    return {
      verified: true,
      householdCount: approvedAttestation.households.length,
      fileCount: copyList.length,
      destination,
    }
  } finally {
    if (temporary !== null) {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
    fs.rmSync(reservation, { force: true })
  }
}
