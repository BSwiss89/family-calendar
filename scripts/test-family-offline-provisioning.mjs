import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setFamilyAccount } from '../Server/family-auth.mjs'
import {
  inspectExistingTestFamilyPlan, provisionFreshTestFamilyIdentity,
} from '../Server/test-family-offline-provisioning.mjs'
import { runOfflineTestFamilyPlan } from './prepare-test-family-identity.mjs'
import { getFamilyMemberAuthorization, canFamilyMemberAct } from '../Server/family-member-access.mjs'

const examplePassword = 'Disposable-Test-Only-Account-Passphrase-2026'
const plan = () => ({
  householdId: 'family-test', householdName: 'Example family',
  ownerUsername: 'sampleowner', ownerPersonId: 3,
  members: [
    { username: 'sampleadult', memberType: 'adult', personId: 1 },
    { username: 'samplechild', memberType: 'child', personId: 2 },
  ],
})

function sourceFixture(t, filename = ':memory:') {
  const source = new DatabaseSync(filename)
  t.after(() => source.close())
  source.exec([
    'CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT NOT NULL);',
    "INSERT INTO people VALUES(1,'Adult'),(2,'Child'),(3,'Owner');",
  ].join(' '))
  for (const username of [
    'sampleowner', 'sampleadult', 'samplechild', 'disabledaccount',
  ]) setFamilyAccount(source, username, username, examplePassword)
  setFamilyAccount(source, 'hubdevice', 'Countertop Hub', examplePassword, {
    accountKind: 'hub',
  })
  source.prepare('UPDATE family_users SET disabled=1 WHERE username=?')
    .run('disabledaccount')
  const sourceSummary = () => ({
    accountCount: source.prepare('SELECT COUNT(*) AS n FROM family_users').get().n,
    sessions: source.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n,
    passwordHashes: source.prepare('SELECT password_hash FROM family_users ORDER BY id').all(),
    peopleCount: source.prepare('SELECT COUNT(*) AS n FROM people').get().n,
  })
  return { source, sourceSummary }
}

test('explicit offline plan includes one Owner, all active human TEST accounts, and existing People', t => {
  const { source, sourceSummary } = sourceFixture(t)
  const before = sourceSummary()
  const inspected = inspectExistingTestFamilyPlan(source, plan())
  assert.equal(inspected.accountCount, 3)
  assert.equal(inspected.linkedPeopleCount, 3)
  assert.deepEqual(inspected.people.map(x => [x.membershipRole, x.memberType]),
    [['owner', 'adult'], ['member', 'adult'], ['member', 'child']])
  assert.deepEqual(sourceSummary(), before)
})

test('unknown Owner, missing account, hub account, duplicate Person and unreviewed fields are denied', t => {
  const { source } = sourceFixture(t)
  const changed = (mutate) => {
    const p = plan()
    mutate(p)
    assert.throws(() => inspectExistingTestFamilyPlan(source, p))
  }
  changed(p => { p.ownerUsername = 'nonexistent' })
  changed(p => { p.ownerUsername = 'hubdevice' })
  changed(p => { p.members.pop() })
  changed(p => { p.members[0].personId = 3 })
  changed(p => { p.members[0].personId = 111111 })
  changed(p => { p.members[1].memberType = 'owner' })
  changed(p => { p.members.push({ username: 'sampleowner', memberType: 'child' }) })
  changed(p => { p.members[0].ownerPassword = examplePassword })
  changed(p => { p.password = examplePassword })
  changed(p => { p.ownerPersonId = -3 })
  changed(p => { p.ownerUsername = 'disabledaccount' })
})

test('new central identity maps original TEST user IDs with no password hashes, sessions or People writes', t => {
  const { source, sourceSummary } = sourceFixture(t)
  const before = sourceSummary()
  const destination = new DatabaseSync(':memory:')
  t.after(() => destination.close())
  const result = provisionFreshTestFamilyIdentity(source, destination, plan())
  assert.equal(result.accounts, 3)
  assert.equal(result.owners, 1)
  assert.equal(result.linkedPeople, 3)
  assert.equal(result.sessionsCopied, 0)
  assert.equal(result.realPasswordHashesCopied, 0)
  assert.deepEqual(sourceSummary(), before)
  const original = source.prepare('SELECT id FROM family_users WHERE username = ?')
  const owner = original.get('sampleowner').id
  const child = original.get('samplechild').id
  const actorOwner = getFamilyMemberAuthorization(destination, {
    householdId: 'family-test', serverVerifiedUserId: owner,
  })
  const actorChild = getFamilyMemberAuthorization(destination, {
    householdId: 'family-test', serverVerifiedUserId: child,
  })
  assert.equal(actorOwner.role, 'owner')
  assert.equal(actorChild.role, 'child')
  assert.equal(actorChild.personId, 2)
  assert.equal(canFamilyMemberAct(actorChild, 'events.create'), false)
  assert.equal(canFamilyMemberAct(actorChild, 'tasks.completeAssigned',
    { assignedPersonId: 2 }), true)
  assert.equal(canFamilyMemberAct(actorChild, 'tasks.completeAssigned',
    { assignedPersonId: 1 }), false)
  assert.equal(destination.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n, 0)
  assert.equal(destination.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='people'").get().n, 0)
  assert.throws(() => provisionFreshTestFamilyIdentity(source, destination, plan()),
    /completely empty/)
})

test('offline CLI preflight fingerprints account inventory, creates new external SQLite only after exact approval', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'family-test-offline-plan-'))
  const sourceFolder = path.join(root, 'existing-test-data')
  fs.mkdirSync(sourceFolder)
  const sourceFile = path.join(sourceFolder, 'test-source.sqlite')
  const planFile = path.join(root, 'private-plan.json')
  const outputDirectory = path.join(root, 'separate-private-permissions')
  fs.mkdirSync(outputDirectory)
  const outputFile = path.join(outputDirectory, 'new-central-identity.sqlite')
  const { source, sourceSummary } = sourceFixture(t, sourceFile)
  // Windows cannot delete an open SQLite directory. Register cleanup AFTER
  // sourceFixture's t.after(close) so it executes after connection closure.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(planFile, JSON.stringify(plan()), { mode: 0o600 })
  const before = sourceSummary()
  const args = ['--test-db', sourceFile, '--plan', planFile,
    '--identity-out', outputFile]
  const dry = runOfflineTestFamilyPlan(args)
  assert.equal(dry.mode, 'read-only-preflight')
  assert.equal(dry.accounts, 3)
  assert.equal(dry.childMembers, 1)
  assert.equal(dry.adultMembers, 1)
  assert.match(dry.fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(fs.existsSync(outputFile), false)
  assert.deepEqual(sourceSummary(), before)
  assert.throws(() => runOfflineTestFamilyPlan([
    ...args, '--execute-new', '--approve-fingerprint', 'f'.repeat(64),
  ]), /changed since preflight/)
  assert.equal(fs.existsSync(outputFile), false)
  const applied = runOfflineTestFamilyPlan([
    ...args, '--execute-new', '--approve-fingerprint', dry.fingerprint,
  ])
  assert.equal(applied.created, true)
  assert.equal(applied.noExistingLoginOrCalendarChanged, true)
  assert.deepEqual(sourceSummary(), before)
  assert.throws(() => runOfflineTestFamilyPlan(args), /already exists/)
  const readBack = new DatabaseSync(outputFile, { readOnly: true })
  try {
    assert.equal(readBack.prepare('SELECT COUNT(*) AS n FROM family_users').get().n, 3)
    assert.equal(readBack.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n, 0)
    assert.equal(readBack.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally { readBack.close() }
})

test('changed existing TEST identity inventory invalidates a previously approved plan', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'family-test-plan-snapshot-'))
  const sourceFolder = path.join(root, 'existing-test-data')
  fs.mkdirSync(sourceFolder)
  const sourceFile = path.join(sourceFolder, 'source.sqlite')
  const planFile = path.join(root, 'plan.json')
  const outputDirectory = path.join(root, 'separate-private-permissions')
  fs.mkdirSync(outputDirectory)
  const outputFile = path.join(outputDirectory, 'identity.sqlite')
  const { source } = sourceFixture(t, sourceFile)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(planFile, JSON.stringify(plan()))
  const args = ['--test-db', sourceFile, '--plan', planFile,
    '--identity-out', outputFile]
  const old = runOfflineTestFamilyPlan(args)
  source.prepare('UPDATE family_users SET display_name = ? WHERE username = ?')
    .run('Renamed adult', 'sampleadult')
  assert.throws(() => runOfflineTestFamilyPlan([
    ...args, '--execute-new', '--approve-fingerprint', old.fingerprint,
  ]), /changed since preflight/)
  assert.equal(fs.existsSync(outputFile), false)
})
