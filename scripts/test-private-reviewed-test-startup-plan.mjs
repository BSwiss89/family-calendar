// All fixtures live under fresh OS temp directories. Never point these tests
// at an installed calendar, Task Scheduler, network listener, or real login.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  createHouseholdMembershipTables, registerHousehold, grantHouseholdMembership,
} from '../Server/household-memberships.mjs'
import { createPrivateActivationRecords } from '../Server/private-household-activation-records.mjs'
import { createIndependentHouseholdInvitationTables } from '../Server/independent-household-invitations.mjs'
import { setFamilyAccount } from '../Server/family-auth.mjs'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'
import { planReviewedPrivateTestStartup } from '../Server/private-reviewed-test-startup-plan.mjs'

const primary = 'home-family'
const friend = 'family-' + 'a'.repeat(24)
const passwd = 'Synthetic-Reviewed-Startup-Password-2026!'

function fixture(t, { addFriend = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-reviewed-startup-'))
  const serverDirectory = path.join(temp, 'checkout', 'Server')
  const storageRoot = path.join(temp, 'private-households')
  const stateDirectory = path.join(temp, 'supervisor-state')
  fs.mkdirSync(serverDirectory, { recursive: true })
  fs.mkdirSync(storageRoot)
  fs.mkdirSync(stateDirectory)
  const identityDatabase = new DatabaseSync(path.join(temp, 'identity.db'))
  t.after(() => {
    identityDatabase.close()
    fs.rmSync(temp, { recursive: true, force: true })
  })
  createHouseholdMembershipTables(identityDatabase)
  createIndependentHouseholdInvitationTables(identityDatabase)
  createPrivateActivationRecords(identityDatabase)
  setFamilyAccount(identityDatabase, 'primary-owner', 'Owner Home', passwd)
  registerHousehold(identityDatabase, { householdId: primary, displayName: 'My home' })
  const primaryUser = identityDatabase.prepare(
    "SELECT id FROM family_users WHERE username = 'primary-owner'").get().id
  grantHouseholdMembership(identityDatabase, {
    serverVerifiedUserId: primaryUser, householdId: primary, role: 'owner',
  })
  const home = provisionEmptyHousehold({ serverDirectory, storageRoot, householdId: primary })
  let friendStorage = null
  if (addFriend) {
    setFamilyAccount(identityDatabase, 'friend-owner', 'Friend Owner', passwd)
    registerHousehold(identityDatabase, { householdId: friend, displayName: 'Friend family' })
    const friendUser = identityDatabase.prepare(
      "SELECT id FROM family_users WHERE username = 'friend-owner'").get().id
    const householdKey = identityDatabase.prepare(
      'SELECT id FROM household_registry WHERE storage_id = ?').get(friend).id
    grantHouseholdMembership(identityDatabase, {
      serverVerifiedUserId: friendUser, householdId: friend, role: 'owner',
    })
    // This is a synthetic, already-redeemed invite created only in temp SQLite.
    identityDatabase.prepare([
      'INSERT INTO independent_household_invitations',
      '(issuer_user_id, token_hash, created_at, expires_at, redeemed_at,',
      'redeemed_user_id, household_id)',
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ].join(' ')).run(primaryUser, 'a'.repeat(64), 1, 2, 1, friendUser, householdKey)
    identityDatabase.prepare(
      'INSERT INTO private_activated_households(household_id, approved_at) VALUES (?, ?)'
    ).run(householdKey, 1)
    friendStorage = provisionEmptyHousehold({ serverDirectory, storageRoot, householdId: friend })
  }
  const args = { identityDatabase, serverDirectory, storageRoot, stateDirectory,
    primaryHouseholdId: primary }
  return { args, home, friendStorage, primaryUser, temp }
}

function sha(filename) {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}

test('one real primary is selected without demo family-a/b defaults and without writes', t => {
  const f = fixture(t)
  const before = sha(f.home.databasePath)
  const plan = planReviewedPrivateTestStartup(f.args)
  assert.deepEqual(plan.householdIds, [primary])
  assert.equal(plan.householdCount, 1)
  assert.equal(plan.primaryHouseholdId, primary)
  assert.equal(plan.deploymentAuthorized, false)
  assert.equal(plan.taskSchedulerInstalled, false)
  assert.equal(plan.osWideWriterOwnershipVerified, false)
  assert(Object.isFrozen(plan) && Object.isFrozen(plan.householdIds))
  assert.equal(sha(f.home.databasePath), before)
})

test('approved invited family is included with separate SQLite and explicit owner', t => {
  const f = fixture(t, { addFriend: true })
  const result = planReviewedPrivateTestStartup(f.args)
  assert.deepEqual(result.householdIds, [primary, friend])
  assert.notEqual(f.home.databasePath, f.friendStorage.databasePath)
})

test('a new household registry entry without activation blocks startup', t => {
  const f = fixture(t)
  registerHousehold(f.args.identityDatabase, {
    householdId: friend, displayName: 'Unapproved new family',
  })
  provisionEmptyHousehold({ serverDirectory: f.args.serverDirectory,
    storageRoot: f.args.storageRoot, householdId: friend })
  assert.throws(() => planReviewedPrivateTestStartup(f.args),
    /missing an active owner|explicit trusted activation/)
})

test('disabled invited owners and revoked approvals refuse restart for all', t => {
  const f = fixture(t, { addFriend: true })
  f.args.identityDatabase.prepare(
    "UPDATE family_users SET disabled=1 WHERE username='friend-owner'"
  ).run()
  assert.throws(() => planReviewedPrivateTestStartup(f.args),
    /missing an active owner|stale/)
})

test('stale activation on inactive registry and multi-membership refuse startup', t => {
  const f = fixture(t, { addFriend: true })
  f.args.identityDatabase.prepare(
    'UPDATE household_registry SET disabled=1 WHERE storage_id=?'
  ).run(friend)
  assert.throws(() => planReviewedPrivateTestStartup(f.args), /disabled or invalid/)
  f.args.identityDatabase.prepare(
    'UPDATE household_registry SET disabled=0 WHERE storage_id=?'
  ).run(friend)
  const user = f.args.primaryUser
  f.args.identityDatabase.exec('DROP INDEX household_memberships_one_household_per_user')
  const id = f.args.identityDatabase.prepare(
    'SELECT id FROM household_registry WHERE storage_id=?').get(friend).id
  f.args.identityDatabase.prepare(
    "INSERT INTO household_memberships(user_id,household_id,role) VALUES (?,?,'member')"
  ).run(user,id)
  assert.throws(() => planReviewedPrivateTestStartup(f.args),
    /one login is linked to more than one household/)
})

test('existing backend and gateway locks and durable supervisor hold are never cleared', t => {
  const f = fixture(t)
  const backend = path.join(f.args.storageRoot, 'households', primary,
    '.family-calendar-private-backend-writer.lock')
  fs.writeFileSync(backend, 'foreign lock')
  assert.throws(() => planReviewedPrivateTestStartup(f.args), /household writer lock/)
  assert(fs.existsSync(backend))
  fs.unlinkSync(backend)
  const gateway = path.join(f.args.storageRoot,
    '.family-calendar-private-gateway-writer.lock')
  fs.writeFileSync(gateway, 'foreign gateway lock')
  assert.throws(() => planReviewedPrivateTestStartup(f.args), /gateway writer lock/)
  assert(fs.existsSync(gateway))
  fs.unlinkSync(gateway)
  const hold = path.join(f.args.stateDirectory,
    '.family-calendar-private-supervisor-REQUIRES-REVIEW.json')
  fs.writeFileSync(hold, 'corrupt or crash hold')
  assert.throws(() => planReviewedPrivateTestStartup(f.args), /crash hold/)
  assert(fs.existsSync(hold))
})

test('wrong primary, demo IDs, overlapping roots and absent data fail closed', t => {
  const f = fixture(t)
  assert.throws(() => planReviewedPrivateTestStartup({
    ...f.args, primaryHouseholdId: 'family-a',
  }), /non-demo primary/)
  assert.throws(() => planReviewedPrivateTestStartup({
    ...f.args, primaryHouseholdId: friend,
  }), /non-demo primary/)
  assert.throws(() => planReviewedPrivateTestStartup({
    ...f.args, primaryHouseholdId: 'someone-else',
  }), /reviewed primary is absent/)
  assert.throws(() => planReviewedPrivateTestStartup({
    ...f.args, stateDirectory: f.args.storageRoot,
  }), /must be separate/)
  fs.unlinkSync(f.home.databasePath)
  assert.throws(() => planReviewedPrivateTestStartup(f.args), /ENOENT|missing/i)
})

test('SQLite corruption or invalid foreign keys cannot be waved through', t => {
  const f = fixture(t)
  const db = new DatabaseSync(f.home.databasePath)
  try {
    db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY)')
    db.exec('CREATE TABLE child(pid INTEGER REFERENCES parent(id))')
    db.exec('PRAGMA foreign_keys=OFF')
    db.prepare('INSERT INTO child(pid) VALUES(7)').run()
  } finally { db.close() }
  assert.throws(() => planReviewedPrivateTestStartup(f.args),
    /SQLite integrity/)
})
