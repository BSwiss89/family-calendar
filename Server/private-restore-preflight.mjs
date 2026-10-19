// OFFLINE RESTORE PREFLIGHT FOR DISPOSABLE PRIVATE HOUSEHOLDS ONLY.
//
// This code NEVER restores, deletes, overwrites, creates databases or starts
// services. All SQLite handles are read-only. It rejects a mixed, incomplete,
// uncheckpointed or logically inconsistent restore set before an operator
// considers any separate restoration procedure.
//
// A trusted attestation is captured at backup time from a quiesced, complete
// staging set and stored OUTSIDE that set. Hashes check integrity, not origin
// authenticity; the caller must safeguard that external attestation.
// No file on the currently running family calendar is read intentionally.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { resolveHouseholdStorage } from './household-storage.mjs'

const STAGE_MARKER = '.family-calendar-restore-review.json'
const STAGE_KIND = 'private-household-offline-restore-review'
const UID = /^[0-9a-f]{32}$/
const HOUSEHOLD_ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const MAX_FILES = 50000

function fail(message) {
  throw new Error('Offline restore preflight refused: ' + message)
}

function entry(root, relative) {
  const full = path.join(root, ...relative.split('/'))
  const stat = fs.lstatSync(full)
  if (stat.isSymbolicLink()) fail('symbolic links or junctions are forbidden.')
  const actual = fs.realpathSync(full)
  const diff = path.relative(root, actual)
  if ((relative !== '.' && !diff) || diff === '..' || diff.startsWith('..' + path.sep)
      || path.isAbsolute(diff)) {
    fail('staging path escapes its directory.')
  }
  return { full, stat }
}

function directory(root, relative) {
  const item = entry(root, relative)
  if (!item.stat.isDirectory()) fail('expected directory is not a directory.')
  return item.full
}

function regularFile(root, relative) {
  const item = entry(root, relative)
  if (!item.stat.isFile()) fail('expected file is not a regular file.')
  return item.full
}

function children(root, relative) {
  directory(root, relative)
  return fs.readdirSync(path.join(root, ...relative.split('/'))).sort()
}

function exactChildren(root, relative, names) {
  const found = children(root, relative)
  if (JSON.stringify(found) !== JSON.stringify([...names].sort())) {
    fail('restore set contains unexpected or missing entries in ' + relative + '.')
  }
}

function checkSqlite(db, label) {
  const check = db.prepare('PRAGMA quick_check').all()
  if (check.length !== 1 || check[0].quick_check !== 'ok') {
    fail(label + ' database quick_check failed.')
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) {
    fail(label + ' database has invalid foreign-key references.')
  }
}

function requireTables(db, names, label) {
  const present = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all().map(x => x.name))
  for (const table of names) {
    if (!present.has(table)) fail(label + ' database is missing a required table.')
  }
}

function collectUploadFiles(root, folder, output) {
  for (const filename of children(root, folder)) {
    const relative = folder + '/' + filename
    const { stat } = entry(root, relative)
    if (stat.isDirectory()) collectUploadFiles(root, relative, output)
    else if (stat.isFile()) output.push(relative)
    else fail('unsupported upload file type.')
    if (output.length > MAX_FILES) fail('too many staged upload files.')
  }
}

function digestFile(full) {
  // Files may be large (SQLite, photographs). Never load the entire backup
  // into RAM just to compute its inventory digest.
  const hash = createHash('sha256')
  const fd = fs.openSync(full, 'r')
  const buf = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const count = fs.readSync(fd, buf, 0, buf.length, null)
      if (count === 0) break
      hash.update(buf.subarray(0, count))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function inspectSet({ serverDirectory, restoreRoot }) {
  if (typeof serverDirectory !== 'string' ||
      typeof restoreRoot !== 'string' || !path.isAbsolute(restoreRoot)) {
    fail('an absolute offline staging root and source directory are required.')
  }
  const root = fs.realpathSync(restoreRoot)
  if (!fs.statSync(root).isDirectory() || fs.lstatSync(restoreRoot).isSymbolicLink()) {
    fail('offline staging root must be a real directory.')
  }
  const checkout = path.dirname(fs.realpathSync(serverDirectory))
  const delta = path.relative(checkout, root)
  if (delta === '' || (!delta.startsWith('..' + path.sep) &&
      delta !== '..' && !path.isAbsolute(delta))) {
    fail('the stage must not be inside the application checkout.')
  }

  exactChildren(root, '.', ['central', 'households', STAGE_MARKER])
  const marker = JSON.parse(fs.readFileSync(regularFile(root, STAGE_MARKER), 'utf8'))
  if (marker?.kind !== STAGE_KIND || marker?.version !== 1) {
    fail('an explicit offline-only restore review marker is required.')
  }
  exactChildren(root, 'central', ['identity.db'])
  const centralPath = regularFile(root, 'central/identity.db')
  const slugs = children(root, 'households')
  if (slugs.length === 0 || slugs.length > 1000) {
    fail('expected one or more staged private households.')
  }
  if (slugs.some(slug => !HOUSEHOLD_ID.test(slug))) {
    fail('staged household folder has an invalid identifier.')
  }

  const central = new DatabaseSync(centralPath, { readOnly: true })
  const opened = new Map()
  try {
    checkSqlite(central, 'central')
    requireTables(central, [
      'family_users', 'family_sessions', 'household_registry',
      'household_memberships', 'event_share_connections',
      'event_share_grants', 'event_share_sync_pending',
    ], 'central')
    const registered = central.prepare(
      'SELECT id, storage_id AS slug, disabled FROM household_registry ORDER BY storage_id'
    ).all()
    if (JSON.stringify(registered.map(x => x.slug)) !== JSON.stringify(slugs)) {
      fail('central household registry does not match staged household folders.')
    }
    if (central.prepare(
      'SELECT COUNT(*) AS n FROM event_share_sync_pending'
    ).get().n !== 0) {
      fail('the central sync journal has unfinished event mutations.')
    }
    // A central DB restored from a backup might resurrect a device revoked
    // after the backup. Require sessions sanitized in a separate, audited
    // staging operation before any live restoration is considered.
    if (central.prepare(
      'SELECT COUNT(*) AS n FROM family_sessions WHERE revoked_at IS NULL AND expires_at > ?'
    ).get(Date.now()).n !== 0) {
      fail('a restored login session could regain access; revoke staged sessions first.')
    }
    for (const household of registered) {
      if (!HOUSEHOLD_ID.test(household.slug)) fail('invalid household registry slug.')
      const storage = resolveHouseholdStorage({
        serverDirectory, storageRoot: root, householdId: household.slug,
      })
      // Storage resolver checks marker containment and exact household slug.
      exactChildren(root, 'households/' + household.slug, [
        '.family-calendar-household.json', 'data', 'uploads',
      ])
      exactChildren(root, 'households/' + household.slug + '/data', ['calendar.db'])
      const db = new DatabaseSync(storage.databasePath, { readOnly: true })
      opened.set(household.id, db)
      checkSqlite(db, 'household')
      requireTables(db, ['events'], 'household')
      // A source-local outbox is transactionally tied to calendar event
      // writes. A restore candidate with undelivered source changes could
      // expose stale invitations even when the CENTRAL journal is empty.
      const hasOutbox = db.prepare([
        "SELECT 1 FROM sqlite_master WHERE type='table'",
        "AND name='event_source_share_outbox'",
      ].join(' ')).get()
      if (hasOutbox && db.prepare(
        'SELECT COUNT(*) AS n FROM event_source_share_outbox'
      ).get().n !== 0) {
        fail('source household has undelivered event changes.')
      }
      const cols = db.prepare('PRAGMA table_info(events)').all().map(x => x.name)
      if (!cols.includes('event_uid')) {
        fail('source household is missing permanent event identities.')
      }
      const invalidIds = db.prepare([
        'SELECT id FROM events WHERE event_uid IS NULL',
        'OR length(event_uid) != 32',
        "OR event_uid GLOB '*[^0-9a-f]*' LIMIT 1",
      ].join(' ')).get()
      if (invalidIds) fail('invalid permanent source event identity.')
      if (db.prepare([
        'SELECT COUNT(*) AS n FROM (SELECT event_uid FROM events',
        'GROUP BY event_uid HAVING COUNT(*) > 1)',
      ].join(' ')).get().n > 0) {
        fail('duplicate permanent source event identity.')
      }
    }
    // Do not restore stale active share copies or pending invitations from
    // another point in time. The exact trusted event identity AND the allowed
    // snapshot fields must agree with each source database in the same set.
    const grants = central.prepare([
      'SELECT source_household_id AS householdId, source_event_id AS eventId,',
      'source_event_uid AS uid, title, date, end_date AS endDate,',
      'time, end_time AS endTime FROM event_share_grants',
      "WHERE status IN ('pending','accepted')",
    ].join(' ')).all()
    for (const grant of grants) {
      if (typeof grant.uid !== 'string' || !UID.test(grant.uid)) {
        fail('an active share has no valid permanent source identity.')
      }
      const db = opened.get(grant.householdId)
      if (!db) fail('active share refers to a missing source household.')
      const event = db.prepare([
        'SELECT event_uid AS uid, title, date,',
        'end_date AS endDate, time, end_time AS endTime,',
        'repeat_unit AS repeatUnit FROM events WHERE id=?',
      ].join(' ')).get(grant.eventId)
      if (!event || event.uid !== grant.uid ||
          (event.repeatUnit != null && event.repeatUnit !== '' &&
            event.repeatUnit !== 'none') ||
          ['title', 'date', 'endDate', 'time', 'endTime'].some(
            key => (event[key] ?? null) !== (grant[key] ?? null)
          )) {
        fail('an active shared invitation does not match its source event.')
      }
    }

    // Preserve ALL staged assets with a deterministic file-by-file inventory,
    // including central identity/permissions, household markers and uploads.
    const paths = [STAGE_MARKER, 'central/identity.db']
    for (const slug of slugs) {
      paths.push('households/' + slug + '/.family-calendar-household.json')
      paths.push('households/' + slug + '/data/calendar.db')
      collectUploadFiles(root, 'households/' + slug + '/uploads', paths)
    }
    if (paths.length > MAX_FILES) fail('too many staged files.')
    const files = paths.sort().map(relative => ({
      path: relative,
      sha256: digestFile(regularFile(root, relative)),
    }))
    return { version: 1, households: slugs, files }
  } finally {
    for (const db of opened.values()) db.close()
    central.close()
  }
}

// Call only during a deliberately quiesced, offline snapshot capture. Store
// the returned attestation in an independent, trusted backup catalog.
export function attestOfflinePrivateRestoreSet(args) {
  const inventory = inspectSet(args)
  const sha256 = createHash('sha256').update(JSON.stringify(inventory)).digest('hex')
  return { ...inventory, sha256 }
}

// A supplied attestation is mandatory. Recomputing one's own manifest from
// a mixed or altered restore candidate is NOT a restore safety check.
export function verifyOfflinePrivateRestoreSet(args, approvedAttestation) {
  if (!approvedAttestation || typeof approvedAttestation !== 'object'
      || !Array.isArray(approvedAttestation.files)
      || !/^[0-9a-f]{64}$/.test(approvedAttestation.sha256 ?? '')) {
    fail('an independent, trusted backup-time attestation is required.')
  }
  const expected = {
    version: approvedAttestation.version,
    households: approvedAttestation.households,
    files: approvedAttestation.files,
  }
  const externalDigest = createHash('sha256').update(JSON.stringify(expected)).digest('hex')
  if (externalDigest !== approvedAttestation.sha256) {
    fail('backup-time attestation was modified.')
  }
  const actual = attestOfflinePrivateRestoreSet(args)
  if (JSON.stringify(actual) !== JSON.stringify(approvedAttestation)) {
    fail('staged restore files do not match the approved backup-time attestation.')
  }
  return { ok: true, households: actual.households.length, files: actual.files.length }
}
