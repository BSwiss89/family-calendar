// DISPOSABLE OFFLINE BACKUP / ROLLBACK READINESS REVIEW ONLY.
// This module neither activates a household nor restores production data.
// It checks independently attested offline snapshots from temporary test
// fixtures. It must never be invoked from an HTTP request, or against real
// TEST / LIVE storage. Production snapshot capture and OS-wide writer
// fencing are NOT yet available.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyOfflinePrivateRestoreSet } from './private-restore-preflight.mjs'

const GENERATED_HOUSEHOLD = /^family-[0-9a-f]{24}$/
const DIGEST = /^[0-9a-f]{64}$/

function refuse(message) {
  throw new Error('Disposable private activation rollback review refused: ' + message)
}

function within(parent, child) {
  const relative = path.relative(
    process.platform === 'win32' ? parent.toLowerCase() : parent,
    process.platform === 'win32' ? child.toLowerCase() : child,
  )
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
}

function safeDisposableRoot(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) {
    refuse('an existing absolute offline snapshot root is required.')
  }
  const stat = fs.lstatSync(filename)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    refuse('snapshot root must be a real physical directory.')
  }
  const actual = fs.realpathSync(filename)
  const temp = fs.realpathSync(os.tmpdir())
  if (!within(temp, actual)) {
    refuse('only disposable OS-temp snapshots may be reviewed.')
  }
  return actual
}

function assetMap(attestation, householdId) {
  const prefix = 'households/' + householdId + '/'
  return new Map(attestation.files.filter(f =>
    f && typeof f.path === 'string' && f.path.startsWith(prefix))
    .map(f => [f.path, f.sha256]))
}

/**
 * Check an isolated two-stage backup sequence: before registration/activation
 * and after adding exactly ONE new household. Require full independent
 * backup-time attestations and ensure every prior household SQLite byte and
 * uploaded asset is unchanged in the new candidate. This is stricter than
 * ordinary live operation because only an OFFLINE, quiesced fixture may pass.
 *
 * The result cannot authorize an actual rollout or claim a real rollback.
 * An actual offline restore COPY is tested separately with
 * copyVerifiedPrivateRestoreSet, and an installed TEST launch still needs
 * exclusive OS writer fencing, confirmed production backups, rollback
 * ownership and explicit owner approval.
 */
export function reviewDisposableInvitedHouseholdRollback({
  serverDirectory, baselineSnapshotRoot, baselineAttestation,
  expandedSnapshotRoot, expandedAttestation, newlyInvitedHouseholdId,
}) {
  if (typeof newlyInvitedHouseholdId !== 'string' ||
      !GENERATED_HOUSEHOLD.test(newlyInvitedHouseholdId)) {
    refuse('one generated newly invited household ID is required.')
  }
  const original = safeDisposableRoot(baselineSnapshotRoot)
  const expanded = safeDisposableRoot(expandedSnapshotRoot)
  if (original === expanded || within(original, expanded) ||
      within(expanded, original)) {
    refuse('independent baseline and expanded snapshots may not overlap.')
  }
  // Both manifests MUST come from a separate trusted backup catalog, rather
  // than recomputing a checksum from the current potentially modified files.
  const before = verifyOfflinePrivateRestoreSet({
    serverDirectory, restoreRoot: original,
  }, baselineAttestation)
  const after = verifyOfflinePrivateRestoreSet({
    serverDirectory, restoreRoot: expanded,
  }, expandedAttestation)
  if (!before.ok || !after.ok || !Array.isArray(baselineAttestation.households) ||
      !Array.isArray(expandedAttestation.households) ||
      baselineAttestation.households.length < 1) {
    refuse('both coordinated backup snapshots must verify independently.')
  }
  const initial = baselineAttestation.households
  const later = expandedAttestation.households
  if (new Set(initial).size !== initial.length ||
      new Set(later).size !== later.length ||
      initial.includes(newlyInvitedHouseholdId) ||
      later.length !== initial.length + 1 ||
      !later.includes(newlyInvitedHouseholdId) ||
      initial.some(id => !later.includes(id))) {
    refuse('candidate must retain every baseline family and add exactly the invited family.')
  }
  for (const householdId of initial) {
    const beforeFiles = assetMap(baselineAttestation, householdId)
    const afterFiles = assetMap(expandedAttestation, householdId)
    if (beforeFiles.size < 2 || beforeFiles.size !== afterFiles.size ||
        [...beforeFiles].some(([filename, digest]) =>
          !DIGEST.test(digest) || digest !== afterFiles.get(filename))) {
      refuse('existing family SQLite, metadata or uploads changed or disappeared.')
    }
  }
  const addedFiles = assetMap(expandedAttestation, newlyInvitedHouseholdId)
  if (!addedFiles.has('households/' + newlyInvitedHouseholdId +
      '/data/calendar.db') ||
      !addedFiles.has('households/' + newlyInvitedHouseholdId +
      '/.family-calendar-household.json')) {
    refuse('the new household requires its own isolated SQLite and storage marker.')
  }
  return Object.freeze({
    kind: 'disposable-private-invited-household-rollback-review-v1',
    baselineHouseholdCount: initial.length,
    expandedHouseholdCount: later.length,
    priorHouseholdAssetsPreserved: true,
    baselineSnapshotVerified: true,
    expandedSnapshotVerified: true,
    independentlyRestoredInProduction: false,
    allProductionWritersFenced: false,
    liveOrTestDeploymentAuthorized: false,
    activationFromBrowserAllowed: false,
  })
}
