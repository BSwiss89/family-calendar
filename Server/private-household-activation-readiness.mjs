// PRIVATE source-only operator readiness assessment. It is NOT activation,
// a backend health claim, a backup, permission to merge, or a third calendar.
// Uses only trusted server-side paths and central invitation records.
// Results are intentionally coarse; no tenant events, lists, photos, paths,
// ports, credentials, or private service tokens are sent to the browser.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveHouseholdStorage } from './household-storage.mjs'

const INVITED_ID = /^family-[a-f0-9]{24}$/

function actualInvitedOwner(identityDatabase, householdId) {
  const record = identityDatabase.prepare([
    'SELECT h.id AS householdKey,',
    'COUNT(DISTINCT CASE WHEN m.role = ? AND m.disabled = 0',
    "AND u.disabled = 0 AND u.account_kind = 'person' THEN u.id END) AS activeOwners,",
    'COUNT(DISTINCT CASE WHEN i.redeemed_at IS NOT NULL AND i.revoked_at IS NULL',
    'AND i.redeemed_user_id = m.user_id AND m.role = ? AND m.disabled = 0',
    "AND u.disabled = 0 AND u.account_kind = 'person'",
    'THEN u.id END) AS invitedOwners',
    'FROM household_registry h',
    'LEFT JOIN household_memberships m ON m.household_id = h.id',
    'LEFT JOIN family_users u ON u.id = m.user_id',
    'LEFT JOIN independent_household_invitations i ON i.household_id = h.id',
    'WHERE h.storage_id = ? AND h.disabled = 0',
  ].join(' ')).get('owner', 'owner', householdId)
  return record?.activeOwners === 1 && record?.invitedOwners === 1
}

function checkedStorage({ serverDirectory, storageRoot, householdId }) {
  const storage = resolveHouseholdStorage({
    serverDirectory, storageRoot, householdId,
  })
  const householdRoot = path.dirname(storage.dataFolder)
  const database = new DatabaseSync(storage.databasePath, { readOnly: true })
  try {
    const integrity = database.prepare('PRAGMA quick_check').all()
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all()
    if (integrity.length !== 1 || integrity[0].quick_check !== 'ok' ||
        foreignKeys.length !== 0) return false

    // Newly registered household storage starts with event_people. A backend
    // may subsequently install event/list tables but MUST NOT pre-populate a
    // future tenant while activation is still pending.
    const declared = new Set(database.prepare([
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ].join(' ')).all().map(row => row.name))
    if (!declared.has('event_people')) return false
    for (const table of ['events', 'lists']) {
      if (declared.has(table) && database.prepare(
        'SELECT 1 FROM ' + table + ' LIMIT 1'
      ).get()) return false
    }
    // The new storage boundary must not contain previously uploaded People
    // photos or other family assets before a reviewed activation.
    if (fs.readdirSync(storage.uploadFolder).length !== 0) return false
    // A lock is NOT proof of a healthy backend. We report the storage check
    // only; the trusted supervisor must separately attest the process.
    if (!fs.statSync(householdRoot).isDirectory()) return false
    return true
  } finally {
    database.close()
  }
}

/**
 * Called only with a household ID taken from an operator-authorized,
 * issuer-scoped invitation inventory. Never accept a request query/body ID.
 *
 * This read-only check is deliberately insufficient for enrollment:
 * a verified live loopback backend binding, independent backups, permitted
 * rollout, supervisor crash-hold review and actual Owner acceptance are still
 * necessary. It NEVER writes activation or starts a service.
 */
export function inspectPrivateHouseholdActivationReadiness({
  identityDatabase, serverDirectory, storageRoot, householdId,
  configuredRoute = false,
}) {
  if (!identityDatabase || typeof identityDatabase.prepare !== 'function' ||
      typeof serverDirectory !== 'string' || !path.isAbsolute(serverDirectory) ||
      typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot) ||
      typeof configuredRoute !== 'boolean') {
    throw new Error('Trusted private activation inspection context required.')
  }
  if (typeof householdId !== 'string' || !INVITED_ID.test(householdId)) {
    return { stage: 'blocked-review', storagePreflight: 'not-evaluated' }
  }
  try {
    if (!actualInvitedOwner(identityDatabase, householdId)) {
      return { stage: 'blocked-review', storagePreflight: 'not-evaluated' }
    }
    const approved = identityDatabase.prepare([
      'SELECT 1 FROM private_activated_households a',
      'JOIN household_registry h ON h.id = a.household_id',
      'WHERE h.storage_id = ? AND h.disabled = 0',
    ].join(' ')).get(householdId)
    if (approved) {
      return {
        stage: configuredRoute ? 'approved-route-configured'
          : 'approved-awaiting-route',
        storagePreflight: 'not-evaluated',
      }
    }
    return checkedStorage({ serverDirectory, storageRoot, householdId }) ?
      { stage: 'storage-reviewed-awaiting-backend-proof', storagePreflight: 'passed' } :
      { stage: 'blocked-review', storagePreflight: 'failed' }
  } catch {
    // Report a coarse hold for damaged/unavailable storage. Do not echo
    // filesystem paths or SQLite errors into any household-facing response.
    return { stage: 'blocked-review', storagePreflight: 'failed' }
  }
}
