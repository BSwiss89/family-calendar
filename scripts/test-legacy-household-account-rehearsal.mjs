// Disposable-only proof of the account import plan. No LIVE/TEST database,
// deployed application, upload, cookie or user account is accessed.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createHouseholdMembershipTables, registerHousehold,
  listGrantedHouseholdsForSessionUser } from '../Server/household-memberships.mjs'
import { hashFamilyPassword, verifyFamilyPassword } from '../Server/family-auth.mjs'
import { preflightLegacyHouseholdImport, rehearseLegacyHouseholdImport,
} from '../Server/legacy-household-account-rehearsal.mjs'

const password = 'SyntheticTestPassword-Only-2026'
const secret = hashFamilyPassword(password)
const fileHash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function fixture(t, { modernSource = false } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-account-import-rehearsal-'))
  let central = null
  t.after(() => {
    central?.close()
    fs.rmSync(folder, { recursive: true, force: true })
  })
  const sourcePath = path.join(folder, 'legacy-calendar.db')
  const destinationPath = path.join(folder, 'central-identity.db')
  const uploads = path.join(folder, 'legacy-uploads')
  fs.mkdirSync(uploads)
  fs.writeFileSync(path.join(uploads, 'family-photo.jpg'), 'KEEP EXISTING UPLOAD')
  const source = new DatabaseSync(sourcePath)
  source.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE family_users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE family_sessions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES family_users(id),
      token_hash TEXT NOT NULL UNIQUE,
      device_label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    ) STRICT;
    CREATE TABLE events (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE lists (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE list_items (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO events VALUES (8, 'Legacy Event');
    INSERT INTO people VALUES (9, 'Legacy Person');
    INSERT INTO lists VALUES (10, 'Existing Groceries');
    INSERT INTO list_items VALUES (11, 'Milk');
  `)
  if (modernSource) source.exec(
    "ALTER TABLE family_users ADD COLUMN account_kind TEXT DEFAULT 'person'"
  )
  const add = source.prepare(
    'INSERT INTO family_users (id, username, display_name, password_hash, disabled)' +
    ' VALUES (?, ?, ?, ?, ?)'
  )
  add.run(11, 'ownerone', 'Owner One', secret, 0)
  add.run(12, 'personone', 'Person One', secret, 0)
  add.run(13, 'oldaccount', 'Disabled One', secret, 1)
  const now = 1782340000000
  const session = source.prepare(
    'INSERT INTO family_sessions (id,user_id,token_hash,device_label,' +
    'created_at,last_seen_at,expires_at,revoked_at) VALUES (?,?,?,?,?,?,?,?)'
  )
  session.run(21, 11, 'a'.repeat(64), 'Kitchen display', now, now + 1, now + 10000, null)
  session.run(22, 12, 'b'.repeat(64), 'Phone', now, now + 1, now + 10000, now + 2)
  if (modernSource) {
    add.run(14, 'hubdevice', 'Wall Hub', secret, 0)
    source.prepare(
      "UPDATE family_users SET account_kind = 'hub' WHERE id = 14"
    ).run()
  }
  source.close()

  central = new DatabaseSync(destinationPath)
  createHouseholdMembershipTables(central)
  registerHousehold(central, { householdId: 'test-family', displayName: 'Test Family' })
  const args = { sourcePath, identityDatabase: central,
    householdId: 'test-family', ownerUsername: 'ownerone' }
  const before = fileHash(sourcePath)
  return { folder, sourcePath, central, args, uploads, before }
}

function centralCounts(central) {
  return ['family_users', 'family_sessions', 'household_memberships'].map(table =>
    central.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n)
}

test('copy legacy usernames, IDs, working password hashes, disabled state and sessions without touching calendar data', async t => {
  const { args, central, sourcePath, before, uploads } = fixture(t)
  const dry = preflightLegacyHouseholdImport(args)
  assert.deepEqual(centralCounts(central), [0, 0, 0], 'preflight must not write')
  assert.equal(dry.accountCount, 3)
  assert.equal(dry.disabledAccountCount, 1)
  assert.equal(dry.sessionCount, 2)
  assert.match(dry.fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(dry).includes(secret), false, 'no secrets in report')

  const imported = rehearseLegacyHouseholdImport({
    ...args, expectedFingerprint: dry.fingerprint,
  })
  assert.deepEqual(imported, dry)
  assert.deepEqual(centralCounts(central), [3, 2, 3])
  const users = central.prepare(
    'SELECT id,username,display_name,password_hash,account_kind,disabled FROM family_users ORDER BY id'
  ).all()
  assert.deepEqual(users.map(u => [u.id, u.username, u.disabled, u.account_kind]), [
    [11, 'ownerone', 0, 'person'], [12, 'personone', 0, 'person'],
    [13, 'oldaccount', 1, 'person'],
  ])
  for (const user of users) {
    assert.equal(user.password_hash, secret)
    assert.equal(await verifyFamilyPassword(password, user.password_hash), true)
  }
  assert.deepEqual(central.prepare(
    'SELECT id,user_id,token_hash,device_label,revoked_at FROM family_sessions ORDER BY id'
  ).all().map(s => [s.id, s.user_id, s.token_hash, s.device_label, s.revoked_at]), [
    [21, 11, 'a'.repeat(64), 'Kitchen display', null],
    [22, 12, 'b'.repeat(64), 'Phone', 1782340000002],
  ])
  assert.deepEqual(central.prepare(
    'SELECT user_id,role,disabled FROM household_memberships ORDER BY user_id'
  ).all().map(m => [m.user_id, m.role, m.disabled]), [
    [11, 'owner', 0], [12, 'member', 0], [13, 'member', 1],
  ])
  assert.deepEqual(listGrantedHouseholdsForSessionUser(central, {
    serverVerifiedUserId: 12,
  }), [{ householdId: 'test-family', displayName: 'Test Family', role: 'member' }])
  assert.deepEqual(listGrantedHouseholdsForSessionUser(central, {
    serverVerifiedUserId: 13,
  }), [])
  assert.equal(fileHash(sourcePath), before, 'source database bytes not changed')
  assert.equal(fs.readFileSync(path.join(uploads, 'family-photo.jpg'), 'utf8'),
    'KEEP EXISTING UPLOAD')
  const untouched = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    for (const [table, label] of [
      ['events', 'Legacy Event'], ['people', 'Legacy Person'],
      ['lists', 'Existing Groceries'], ['list_items', 'Milk'],
    ]) {
      assert.equal(untouched.prepare('SELECT ' +
        (table === 'people' ? 'name' : table === 'events' ? 'title' : 'name') +
        ' AS value FROM ' + table).get().value, label)
    }
  } finally { untouched.close() }
})

test('modern synthetic source preserves account-kind while hubs never become household owners', t => {
  const { args, central } = fixture(t, { modernSource: true })
  const dry = preflightLegacyHouseholdImport(args)
  rehearseLegacyHouseholdImport({ ...args, expectedFingerprint: dry.fingerprint })
  assert.equal(central.prepare("SELECT account_kind FROM family_users WHERE username = 'hubdevice'")
    .get().account_kind, 'hub')
  assert.equal(central.prepare("SELECT role FROM household_memberships WHERE user_id = 14")
    .get().role, 'member')
})

test('fingerprint rejects intervening username or session changes without changing destination', t => {
  const { args, central, sourcePath } = fixture(t)
  const before = preflightLegacyHouseholdImport(args)
  const source = new DatabaseSync(sourcePath)
  try {
    source.prepare("UPDATE family_users SET display_name = 'Edited' WHERE id = 12").run()
  } finally { source.close() }
  assert.throws(() => rehearseLegacyHouseholdImport({
    ...args, expectedFingerprint: before.fingerprint,
  }), /changed since approved preflight/)
  assert.deepEqual(centralCounts(central), [0, 0, 0])
})

test('wrong owner, destination collisions, and repeat migration fail closed', t => {
  const { args, central, sourcePath } = fixture(t)
  assert.throws(() => preflightLegacyHouseholdImport({
    ...args, ownerUsername: 'oldaccount',
  }), /active person account/)
  assert.throws(() => preflightLegacyHouseholdImport({
    ...args, householdId: 'another-family',
  }), /exactly one approved/)
  assert.throws(() => preflightLegacyHouseholdImport({
    ...args, sourcePath: 'missing.db',
  }), /existing source/)
  const fingerprint = preflightLegacyHouseholdImport(args).fingerprint
  rehearseLegacyHouseholdImport({ ...args, expectedFingerprint: fingerprint })
  assert.throws(() => rehearseLegacyHouseholdImport({
    ...args, expectedFingerprint: fingerprint,
  }), /already has accounts/)
  assert.deepEqual(centralCounts(central), [3, 2, 3])
  assert.ok(fs.existsSync(sourcePath))
})

test('SQLite insertion failure rolls back ALL imported identities and memberships', t => {
  const { args, central } = fixture(t)
  const approved = preflightLegacyHouseholdImport(args)
  central.exec(`
    CREATE TRIGGER synthetic_session_abort BEFORE INSERT ON family_sessions
    BEGIN SELECT RAISE(ABORT,'synthetic insertion rejected'); END;
  `)
  assert.throws(() => rehearseLegacyHouseholdImport({
    ...args, expectedFingerprint: approved.fingerprint,
  }), /synthetic insertion rejected/)
  assert.deepEqual(centralCounts(central), [0, 0, 0])
  assert.deepEqual(central.prepare('SELECT storage_id FROM household_registry').all()
    .map(row => row.storage_id), ['test-family'])
})

test('malformed password hash, source ownership, and unsupported source shape fail closed', t => {
  const { args, central, sourcePath } = fixture(t)
  const db = new DatabaseSync(sourcePath)
  try {
    db.prepare("UPDATE family_users SET password_hash = 'not a hash' WHERE id = 12").run()
  } finally { db.close() }
  assert.throws(() => preflightLegacyHouseholdImport(args), /password hash format/)
  assert.deepEqual(centralCounts(central), [0, 0, 0])
  assert.throws(() => preflightLegacyHouseholdImport({
    ...args, sourcePath: central.prepare('PRAGMA database_list').all()[0].file,
  }), /Legacy account schema is incompatible|Source already contains central household/)
})
