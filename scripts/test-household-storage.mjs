import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  provisionEmptyHousehold,
  resolveHouseholdStorage,
} from '../Server/household-storage.mjs'

function fixture(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-household-test-'))
  t.after(() => fs.rmSync(work, { recursive: true, force: true }))
  const serverDirectory = path.join(work, 'checkout', 'Server')
  const storageRoot = path.join(work, 'private-storage')
  fs.mkdirSync(serverDirectory, { recursive: true })
  fs.mkdirSync(storageRoot)
  return { work, serverDirectory, storageRoot }
}

test('unconfigured storage preserves the legacy local calendar paths', t => {
  const { serverDirectory } = fixture(t)
  const result = resolveHouseholdStorage({ serverDirectory })
  assert.equal(result.mode, 'legacy')
  assert.equal(result.householdId, null)
  assert.equal(result.databasePath, path.join(serverDirectory, 'data', 'calendar.db'))
  assert.equal(result.uploadFolder, path.join(serverDirectory, 'uploads'))
  assert.equal(fs.existsSync(result.databasePath), false)
})

test('provisioned households have independent empty SQLite databases and uploads', t => {
  const settings = fixture(t)
  const familyA = provisionEmptyHousehold({ ...settings, householdId: 'family-a' })
  const familyB = provisionEmptyHousehold({ ...settings, householdId: 'friends-b' })

  assert.equal(familyA.mode, 'household')
  assert.equal(familyB.mode, 'household')
  assert.notEqual(familyA.databasePath, familyB.databasePath)
  assert.notEqual(familyA.uploadFolder, familyB.uploadFolder)
  assert.ok(fs.existsSync(familyA.databasePath))
  assert.ok(fs.existsSync(familyB.databasePath))
  assert.equal(fs.statSync(familyA.uploadFolder).isDirectory(), true)

  const first = new DatabaseSync(familyA.databasePath)
  const second = new DatabaseSync(familyB.databasePath)
  try {
    first.exec('CREATE TABLE private_fixture (secret TEXT NOT NULL) STRICT')
    first.prepare('INSERT INTO private_fixture(secret) VALUES (?)').run('only family A')
    assert.equal(first.prepare('SELECT secret FROM private_fixture').get().secret, 'only family A')
    const secondTables = second.prepare("SELECT name FROM sqlite_master WHERE name = 'private_fixture'").all()
    assert.deepEqual(secondTables, [])
    assert.equal(first.prepare("SELECT COUNT(*) AS total FROM event_people").get().total, 0)
    assert.equal(second.prepare("SELECT COUNT(*) AS total FROM event_people").get().total, 0)
  } finally {
    first.close()
    second.close()
  }

  fs.writeFileSync(path.join(familyA.uploadFolder, 'private-photo.txt'), 'family A')
  assert.equal(fs.existsSync(path.join(familyB.uploadFolder, 'private-photo.txt')), false)

  assert.deepEqual(
    resolveHouseholdStorage({ ...settings, householdId: 'family-a' }),
    familyA,
  )
})

test('a second provisioning request cannot overwrite an existing household', t => {
  const settings = fixture(t)
  const one = provisionEmptyHousehold({ ...settings, householdId: 'family-a' })
  const before = fs.readFileSync(one.databasePath)
  assert.throws(() => provisionEmptyHousehold({ ...settings, householdId: 'family-a' }), /EEXIST/)
  assert.deepEqual(fs.readFileSync(one.databasePath), before)
})

test('partial, unknown or malformed tenant configuration fails closed', t => {
  const settings = fixture(t)
  const all = { ...settings, householdId: 'family-a' }
  assert.throws(() => resolveHouseholdStorage(all), /households|ENOENT/)
  assert.throws(
    () => resolveHouseholdStorage({ serverDirectory: settings.serverDirectory, householdId: 'family-a' }),
    /Both household/,
  )
  assert.throws(
    () => resolveHouseholdStorage({ serverDirectory: settings.serverDirectory, storageRoot: settings.storageRoot }),
    /Both household/,
  )

  for (const householdId of ['../family-a', '..', 'Family-A', 'a/b', 'a\\b', 'aa', '', 'x'.repeat(41)]) {
    assert.throws(
      () => provisionEmptyHousehold({ ...settings, householdId }),
      /Invalid household ID/,
    )
  }
})

test('mismatched marker and missing database are rejected without creating replacements', t => {
  const settings = fixture(t)
  const home = provisionEmptyHousehold({ ...settings, householdId: 'family-a' })
  const marker = path.join(settings.storageRoot, 'households', 'family-a', '.family-calendar-household.json')
  fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, householdId: 'somebody-else' }))
  assert.throws(
    () => resolveHouseholdStorage({ ...settings, householdId: 'family-a' }),
    /marker does not match/,
  )
  fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 1, householdId: 'family-a' }))
  fs.unlinkSync(home.databasePath)
  assert.throws(
    () => resolveHouseholdStorage({ ...settings, householdId: 'family-a' }),
    /ENOENT|missing/,
  )
  assert.equal(fs.existsSync(home.databasePath), false)
})

test('storage cannot be inside or above the application checkout', t => {
  const settings = fixture(t)
  const checkoutRoot = path.dirname(settings.serverDirectory)
  for (const storageRoot of [
    checkoutRoot,
    path.join(checkoutRoot, 'private-storage'),
    settings.work,
  ]) {
    if (storageRoot.endsWith('private-storage')) fs.mkdirSync(storageRoot)
    assert.throws(
      () => provisionEmptyHousehold({ ...settings, storageRoot, householdId: 'family-a' }),
      /outside the application checkout/,
    )
  }
})

test('a dangling or incomplete household is never treated as initialized', t => {
  const settings = fixture(t)
  const house = path.join(settings.storageRoot, 'households', 'abandoned')
  fs.mkdirSync(house, { recursive: true })
  fs.mkdirSync(path.join(house, 'data'))
  fs.mkdirSync(path.join(house, 'uploads'))
  assert.throws(
    () => resolveHouseholdStorage({ ...settings, householdId: 'abandoned' }),
    /ENOENT|missing/,
  )
})
