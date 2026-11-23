// SOURCE-ONLY / DISPOSABLE evidence for a Phase 1 post-write rollback decision.
// This is NOT a restore, an authorization, a snapshot capture or an OS writer
// fence. It reads TWO independently attested OS-temp backup sets only and
// cannot establish whether any writes occurred after the later snapshot.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyOfflinePrivateRestoreSet } from './private-restore-preflight.mjs'

function refuse(message) {
  throw new Error('Disposable post-write rollback review refused: ' + message)
}

function within(parent, item) {
  const a = process.platform === 'win32' ? parent.toLowerCase() : parent
  const b = process.platform === 'win32' ? item.toLowerCase() : item
  const relative = path.relative(a, b)
  return relative === '' || (relative !== '..' &&
    !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

function requireDisposableRoot(value, checkout, temp) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    refuse('independent absolute backup roots are required.')
  }
  const stat = fs.lstatSync(value)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    refuse('backup root must be a physical directory, not a link.')
  }
  const real = fs.realpathSync(value)
  if (real === temp || !within(temp, real) ||
      within(checkout, real) || within(real, checkout)) {
    refuse('only independently stored OS-temp backups outside checkout are allowed.')
  }
  return real
}

function inventory(attestation) {
  if (!attestation || !Array.isArray(attestation.files) ||
      !Array.isArray(attestation.households)) {
    refuse('both independently verified backup attestations are required.')
  }
  const files = new Map()
  for (const f of attestation.files) {
    if (typeof f?.path !== 'string' || typeof f?.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(f.sha256) || files.has(f.path)) {
      refuse('invalid or duplicate attested file entry.')
    }
    files.set(f.path, f.sha256)
  }
  return files
}

function bucket(filename) {
  if (filename === 'central/identity.db') return 'central'
  if (/^households\/[^/]+\/data\/calendar\.db$/.test(filename)) return 'database'
  if (/^households\/[^/]+\/uploads\//.test(filename)) return 'uploads'
  return 'metadata'
}

/**
 * Compare trusted backup-time evidence from BEFORE and AFTER a pilot write
 * window. Every backup is independently verified against its own saved
 * attestation; a checksum recomputed from a damaged backup is not evidence.
 *
 * Even matching snapshots can be stale: this report NEVER declares a rollback
 * safe. The operator must prove current writer exclusion, account/session
 * reconciliation and any newer writes separately before a scoped decision.
 * Results contain counts, not family names, upload paths or secret contents.
 */
export function reviewDisposablePhase1PostWriteRollback({
  serverDirectory, baselineSnapshotRoot, baselineAttestation,
  laterSnapshotRoot, laterAttestation,
}) {
  if (typeof serverDirectory !== 'string' ||
      !path.isAbsolute(serverDirectory)) {
    refuse('a reviewed source checkout is required.')
  }
  const server = fs.realpathSync(serverDirectory)
  if (!fs.statSync(server).isDirectory()) refuse('source Server directory is missing.')
  const checkout = path.dirname(server)
  const temp = fs.realpathSync(os.tmpdir())
  const beforeRoot = requireDisposableRoot(baselineSnapshotRoot, checkout, temp)
  const afterRoot = requireDisposableRoot(laterSnapshotRoot, checkout, temp)
  if (within(beforeRoot, afterRoot) || within(afterRoot, beforeRoot)) {
    refuse('before and after must be distinct non-overlapping backup roots.')
  }

  // The attestations are supplied from an independent trusted catalog.
  // A bad hash, missing upload, foreign tenant or SQLite corruption must stop.
  verifyOfflinePrivateRestoreSet({
    serverDirectory, restoreRoot: beforeRoot,
  }, baselineAttestation)
  verifyOfflinePrivateRestoreSet({
    serverDirectory, restoreRoot: afterRoot,
  }, laterAttestation)
  const before = inventory(baselineAttestation)
  const after = inventory(laterAttestation)
  const categories = {
    central: 0, database: 0, uploads: 0, metadata: 0,
  }
  let addedFiles = 0
  let missingFiles = 0
  let changedFiles = 0
  for (const [filename, digest] of before) {
    if (!after.has(filename)) {
      missingFiles++
      categories[bucket(filename)]++
    } else if (after.get(filename) !== digest) {
      changedFiles++
      categories[bucket(filename)]++
    }
  }
  for (const filename of after.keys()) {
    if (!before.has(filename)) {
      addedFiles++
      categories[bucket(filename)]++
    }
  }
  const priorHouseholds = new Set(baselineAttestation.households)
  const laterHouseholds = new Set(laterAttestation.households)
  const addedHouseholds = [...laterHouseholds]
    .filter(id => !priorHouseholds.has(id)).length
  const missingHouseholds = [...priorHouseholds]
    .filter(id => !laterHouseholds.has(id)).length
  const changed = addedFiles + missingFiles + changedFiles > 0 ||
    addedHouseholds + missingHouseholds > 0

  return Object.freeze({
    kind: 'disposable-phase1-post-write-rollback-review-v1',
    baselineVerified: true,
    laterBackupVerified: true,
    backupFileChanges: Object.freeze({
      added: addedFiles, missing: missingFiles, changed: changedFiles,
    }),
    changedCategories: Object.freeze({ ...categories }),
    householdCountBefore: priorHouseholds.size,
    householdCountLater: laterHouseholds.size,
    addedHouseholds, missingHouseholds,
    newerBackupDiffers: changed,
    possibleNewerDataLoss: changed,
    // No automatic restoration, even when snapshots match: a third write
    // could occur later, or a browser session could be revived.
    writesAfterLaterSnapshotUnknown: true,
    allSystemWritersFenced: false,
    accountSessionReconciliationProven: false,
    productionBackupAuthorized: false,
    automaticRollbackAllowed: false,
    restoreAuthorized: false,
    deploymentAuthorized: false,
    manualOwnerReviewRequired: true,
  })
}
