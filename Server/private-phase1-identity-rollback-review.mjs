// Phase 1 source-only comparison of central identity changes across two
// independently attested, disposable OS-temp backups. It never opens the
// running TEST/LIVE databases, changes accounts, restores files, or authorizes
// a rollback. It reports ONLY aggregate counts, not household IDs, usernames,
// credentials, device labels, tokens, roles, paths or account metadata.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { reviewDisposablePhase1PostWriteRollback } from './private-phase1-post-write-rollback-review.mjs'

// Whitelisted known central identity tables. The comparison includes every
// stored column (including revoked devices and permissions) without emitting
// any row or its digest. Unknown/changed schemas conservatively count as
// changed records or trigger a manual refusal.
const TABLES = Object.freeze([
  { name: 'family_users', label: 'accounts', key: ['id'] },
  { name: 'household_registry', label: 'households', key: ['id'] },
  { name: 'household_memberships', label: 'memberships',
    key: ['user_id', 'household_id'] },
  { name: 'family_sessions', label: 'sessions', key: ['id'] },
  { name: 'household_session_selections', label: 'selections',
    key: ['session_id'] },
])
const MAX_ROWS_PER_TABLE = 50000

function refuse(message) {
  throw new Error('Disposable central identity rollback review refused: ' + message)
}
function inventory(db, spec) {
  const table = spec.name // static whitelist only; never user input
  const present = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table)
  if (!present) refuse('required central identity table is absent.')
  const rows = db.prepare('SELECT * FROM "' + table + '"').all()
  if (rows.length > MAX_ROWS_PER_TABLE) refuse('identity table exceeds review limit.')
  const found = new Map()
  for (const row of rows) {
    if (spec.key.some(column => !Object.hasOwn(row, column) ||
        row[column] === null || row[column] === undefined)) {
      refuse('identity primary key missing.')
    }
    const key = JSON.stringify(spec.key.map(column => row[column]))
    if (found.has(key)) refuse('duplicate identity row key.')
    // Never output actual data, individual hashes or identifying keys.
    found.set(key, JSON.stringify(row))
  }
  return found
}
function compare(before, after) {
  let added = 0
  let removed = 0
  let changed = 0
  for (const [key, value] of before) {
    if (!after.has(key)) removed++
    else if (after.get(key) !== value) changed++
  }
  for (const key of after.keys()) {
    if (!before.has(key)) added++
  }
  return Object.freeze({
    before: before.size, after: after.size, added, removed, changed,
  })
}
function readCentral(root) {
  const filename = path.join(root, 'central', 'identity.db')
  // Both roots and their complete manifests were just validated by the
  // independent backup reviewer. Never accept arbitrary database filenames.
  const db = new DatabaseSync(filename, { readOnly: true })
  try {
    const data = new Map()
    for (const spec of TABLES) {
      data.set(spec.label, inventory(db, spec))
    }
    return data
  } finally {
    db.close()
  }
}
/**
 * This distinguishes user/permission/session differences, not merely
 * whether the central SQLite hash changed. The two full snapshots are
 * verified before AND after read-only comparison to catch detected drift.
 * These are still snapshots, so external writers and post-snapshot changes
 * require independent owner-operated reconciliation before ANY restore.
 */
export function reviewDisposablePhase1IdentityRollbackImpact(args) {
  const report = reviewDisposablePhase1PostWriteRollback(args)
  const before = readCentral(args.baselineSnapshotRoot)
  const after = readCentral(args.laterSnapshotRoot)
  const changes = Object.create(null)
  let identityRecordsDiffer = false
  for (const spec of TABLES) {
    const count = compare(before.get(spec.label), after.get(spec.label))
    changes[spec.label] = count
    identityRecordsDiffer ||= count.added + count.removed + count.changed > 0
  }
  // Detect modifications between the original independent attestation
  // verification and the read. This is NOT a proof of no later writes.
  const rechecked = reviewDisposablePhase1PostWriteRollback(args)
  if (JSON.stringify(rechecked) !== JSON.stringify(report)) {
    refuse('backup attestations changed during inspection.')
  }
  // Even if the SQLite file hash changed only because of layout or VACUUM,
  // treat the full backup difference as a manual-reconciliation hold.
  const centralFileChanged = report.changedCategories.central > 0
  return Object.freeze({
    kind: 'disposable-phase1-identity-session-rollback-impact-v1',
    baselineBackupVerified: true,
    laterBackupVerified: true,
    identityChanges: Object.freeze({ ...changes }),
    identityRecordsDiffer,
    centralFileChanged,
    anyNewerBackupData: report.newerBackupDiffers,
    accountOrSessionRollbackImpactPossible: identityRecordsDiffer ||
      centralFileChanged,
    identityDetailsExposed: false,
    activeSessionsProvenInvalidatedOnRealHost: false,
    writesAfterLaterSnapshotUnknown: true,
    allSystemWritersFenced: false,
    ownerReauthenticationRequiredAfterAnyApprovedRecovery: true,
    automaticRollbackAllowed: false,
    restoreAuthorized: false,
    deploymentAuthorized: false,
    manualOwnerReviewRequired: true,
  })
}
