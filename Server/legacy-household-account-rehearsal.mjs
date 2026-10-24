// OFFLINE REHEARSAL ONLY. No HTTP route, scheduler, or deploy script calls this.
// Source calendar SQLite is opened READ-ONLY. The central identity database
// must already have exactly one pre-provisioned, empty household. The source
// calendar, People, events, lists, uploads and LIVE/TEST cookies are untouched.
// An actual cutover needs a separate reviewed quiescence/session-cookie plan.
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const HOUSEHOLD = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const USERNAME = /^[a-zA-Z0-9._-]{3,40}$/
const PASSWORD_HASH = /^scrypt-v1:[a-f0-9]{32}:[a-f0-9]{128}$/
const TOKEN_HASH = /^[a-f0-9]{64}$/

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function columns(database, table) {
  return database.prepare("PRAGMA table_info('" + table + "')").all().map(row => row.name)
}

function requireColumns(database, table, required) {
  const existing = columns(database, table)
  assert(existing.length > 0, 'Missing legacy account table: ' + table)
  for (const column of required) {
    assert(existing.includes(column), 'Legacy account schema is incompatible.')
  }
  return existing
}

function validInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function readSourceSnapshot(sourcePath) {
  assert(typeof sourcePath === 'string' && fs.existsSync(sourcePath)
    && fs.statSync(sourcePath).isFile(), 'An existing source SQLite file is required.')
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    // A consistent snapshot, even if another process writes during this read.
    source.exec('BEGIN')
    assert(source.prepare('PRAGMA integrity_check').get().integrity_check === 'ok',
      'Source SQLite integrity failed.')
    assert(source.prepare('PRAGMA foreign_key_check').all().length === 0,
      'Source SQLite foreign keys are invalid.')
    assert(!columns(source, 'household_memberships').length,
      'Source already contains central household membership data.')

    const userColumns = requireColumns(source, 'family_users',
      ['id', 'username', 'display_name', 'password_hash', 'disabled'])
    requireColumns(source, 'family_sessions',
      ['id', 'user_id', 'token_hash', 'device_label', 'created_at',
        'last_seen_at', 'expires_at', 'revoked_at'])
    const kind = userColumns.includes('account_kind')
      ? 'account_kind' : "'person' AS account_kind"
    const users = source.prepare(
      'SELECT id, username, display_name, password_hash, disabled, ' + kind +
      ' FROM family_users ORDER BY id'
    ).all().map(row => ({ ...row }))
    const sessions = source.prepare(
      'SELECT id, user_id, token_hash, device_label, created_at, ' +
      'last_seen_at, expires_at, revoked_at FROM family_sessions ORDER BY id'
    ).all().map(row => ({ ...row }))
    assert(users.length > 0 && users.length <= 10000,
      'Source must contain a bounded, nonempty account set.')
    assert(sessions.length <= 100000, 'Source has too many sessions to rehearse.')

    const known = new Set()
    const usernames = new Set()
    for (const user of users) {
      assert(Number.isSafeInteger(user.id) && user.id > 0 &&
        typeof user.username === 'string' && USERNAME.test(user.username) &&
        user.username === user.username.toLowerCase(),
      'Legacy user identifier or username is invalid.')
      assert(!usernames.has(user.username), 'Legacy usernames conflict.')
      usernames.add(user.username)
      known.add(user.id)
      assert(typeof user.display_name === 'string' &&
        user.display_name.trim() === user.display_name &&
        user.display_name.length >= 1 && user.display_name.length <= 80,
      'Legacy account display name is invalid.')
      assert(typeof user.password_hash === 'string' &&
        PASSWORD_HASH.test(user.password_hash), 'Legacy password hash format is invalid.')
      assert(['person', 'hub'].includes(user.account_kind) &&
        [0, 1].includes(user.disabled), 'Legacy account type or status is invalid.')
    }
    for (const session of sessions) {
      assert(Number.isSafeInteger(session.id) && session.id > 0 &&
        known.has(session.user_id) && TOKEN_HASH.test(session.token_hash) &&
        typeof session.device_label === 'string' &&
        session.device_label.length > 0 && session.device_label.length <= 60 &&
        validInteger(session.created_at) && validInteger(session.last_seen_at) &&
        validInteger(session.expires_at) &&
        session.last_seen_at >= session.created_at &&
        session.expires_at >= session.created_at &&
        (session.revoked_at === null || validInteger(session.revoked_at)),
      'Legacy session record is invalid.')
    }

    // Never log, return or persist hashes from this source snapshot.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ users, sessions })).digest('hex')
    source.exec('COMMIT')
    return { users, sessions, fingerprint }
  } finally {
    source.close()
  }
}

function checkDestination(identityDatabase, sourcePath, householdId, ownerUsername, snapshot) {
  assert(identityDatabase instanceof DatabaseSync,
    'A separately provisioned central identity database is required.')
  assert(typeof householdId === 'string' && HOUSEHOLD.test(householdId),
    'Invalid trusted household ID.')
  assert(typeof ownerUsername === 'string' && USERNAME.test(ownerUsername) &&
    ownerUsername === ownerUsername.toLowerCase(), 'Invalid trusted owner username.')
  const owner = snapshot.users.find(row => row.username === ownerUsername)
  assert(owner && owner.disabled === 0 && owner.account_kind === 'person',
    'The designated household owner must be an active person account.')

  const main = identityDatabase.prepare('PRAGMA database_list').all()
    .find(row => row.name === 'main')?.file
  assert(!main || fs.realpathSync(main) !== fs.realpathSync(sourcePath),
    'Source and destination databases must be separate.')

  for (const table of ['family_users', 'family_sessions', 'household_registry',
    'household_memberships', 'household_session_selections']) {
    assert(columns(identityDatabase, table).length > 0,
      'Central identity schema must be provisioned in advance.')
  }
  assert(identityDatabase.prepare('PRAGMA integrity_check').get().integrity_check === 'ok' &&
    identityDatabase.prepare('PRAGMA foreign_key_check').all().length === 0,
  'Central identity integrity failed.')
  for (const table of ['family_users', 'family_sessions',
    'household_memberships', 'household_session_selections']) {
    assert(identityDatabase.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n === 0,
      'Destination already has accounts, sessions or memberships. Refusing overwrite.')
  }
  const householdRows = identityDatabase.prepare(
    'SELECT storage_id, disabled FROM household_registry'
  ).all()
  assert(householdRows.length === 1 &&
    householdRows[0].storage_id === householdId && householdRows[0].disabled === 0,
  'Destination must have exactly one approved active household.')
  return owner
}

function publicReport(snapshot, householdId, ownerUsername) {
  return {
    householdId, ownerUsername,
    accountCount: snapshot.users.length,
    disabledAccountCount: snapshot.users.filter(row => row.disabled).length,
    sessionCount: snapshot.sessions.length,
    fingerprint: snapshot.fingerprint,
  }
}

export function preflightLegacyHouseholdImport({
  sourcePath, identityDatabase, householdId, ownerUsername,
}) {
  const snapshot = readSourceSnapshot(sourcePath)
  checkDestination(identityDatabase, sourcePath, householdId, ownerUsername, snapshot)
  return publicReport(snapshot, householdId, ownerUsername)
}

/**
 * Rehearsal-only atomic import of legacy account/session records into an empty
 * central identity DB, retaining numeric IDs, password hashes and session
 * token hashes verbatim. No old browser cookie is made valid on a new gateway:
 * cutover and login continuity are separate, not provided by this module.
 * A human must approve an exact preflight fingerprint before this is called.
 */
export function rehearseLegacyHouseholdImport({
  sourcePath, identityDatabase, householdId, ownerUsername, expectedFingerprint,
}) {
  assert(typeof expectedFingerprint === 'string' &&
    TOKEN_HASH.test(expectedFingerprint), 'Approved preflight fingerprint required.')
  const snapshot = readSourceSnapshot(sourcePath)
  assert(snapshot.fingerprint === expectedFingerprint,
    'Legacy accounts or sessions changed since approved preflight.')
  // Reject any collision or drift BEFORE starting modifications.
  const owner = checkDestination(identityDatabase, sourcePath,
    householdId, ownerUsername, snapshot)
  identityDatabase.exec('BEGIN IMMEDIATE')
  try {
    // Check again under the central SQLite write lock.
    checkDestination(identityDatabase, sourcePath, householdId, ownerUsername, snapshot)
    const addUser = identityDatabase.prepare(
      'INSERT INTO family_users (id, username, display_name, password_hash, account_kind, disabled)' +
      ' VALUES (?, ?, ?, ?, ?, ?)'
    )
    const addSession = identityDatabase.prepare(
      'INSERT INTO family_sessions (id, user_id, token_hash, device_label,' +
      ' created_at, last_seen_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const householdKey = identityDatabase.prepare(
      'SELECT id FROM household_registry WHERE storage_id = ?'
    ).get(householdId).id
    const addMembership = identityDatabase.prepare(
      'INSERT INTO household_memberships (user_id, household_id, role, disabled)' +
      ' VALUES (?, ?, ?, ?)'
    )
    for (const user of snapshot.users) {
      addUser.run(user.id, user.username, user.display_name, user.password_hash,
        user.account_kind, user.disabled)
      addMembership.run(user.id, householdKey,
        user.id === owner.id ? 'owner' : 'member', user.disabled)
    }
    for (const session of snapshot.sessions) {
      addSession.run(session.id, session.user_id, session.token_hash,
        session.device_label, session.created_at, session.last_seen_at,
        session.expires_at, session.revoked_at)
    }
    assert(identityDatabase.prepare('PRAGMA foreign_key_check').all().length === 0,
      'Imported central identity foreign keys failed.')
    identityDatabase.exec('COMMIT')
    return publicReport(snapshot, householdId, ownerUsername)
  } catch (error) {
    identityDatabase.exec('ROLLBACK')
    throw error
  }
}
