// Regression fixtures use disposable SQLite and upload files only.
// Never read installed LIVE or TEST calendars or copy credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'
import { reconcileOfflineLegacyHousehold } from '../Server/private-legacy-household-reconciliation.mjs'

function fixture(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-legacy-reconciliation-'))
  t.after(() => fs.rmSync(work, { recursive: true, force: true }))
  const serverDirectory = path.join(work, 'checkout', 'Server')
  const legacyRoot = path.join(work, 'legacy-offline')
  const householdStorageRoot = path.join(work, 'households-offline')
  fs.mkdirSync(serverDirectory, { recursive: true })
  fs.mkdirSync(path.join(legacyRoot, 'data'), { recursive: true })
  fs.mkdirSync(path.join(legacyRoot, 'uploads', 'family'), { recursive: true })
  fs.mkdirSync(householdStorageRoot)
  fs.writeFileSync(path.join(legacyRoot, '.family-calendar-legacy-offline-review.json'),
    JSON.stringify({ kind: 'legacy-calendar-offline-review', version: 1 }))
  const originalPath = path.join(legacyRoot, 'data', 'calendar.db')
  const original = new DatabaseSync(originalPath)
  try {
    original.exec([
      'PRAGMA foreign_keys=ON;',
      'CREATE TABLE family_users(id INTEGER PRIMARY KEY, username TEXT);',
      'CREATE TABLE family_sessions(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES family_users(id));',
      'CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      'CREATE TABLE events(id INTEGER PRIMARY KEY, title TEXT NOT NULL, content BLOB);',
      'CREATE TABLE event_people(event_id INTEGER REFERENCES events(id), person_id INTEGER REFERENCES people(id));',
      'CREATE TABLE lists(id INTEGER PRIMARY KEY, name TEXT);',
      'CREATE TABLE list_items(id INTEGER PRIMARY KEY, list_id INTEGER REFERENCES lists(id), name TEXT);',
      'CREATE TABLE recipes(id INTEGER PRIMARY KEY, name TEXT);',
      'CREATE TABLE meal_plan_items(id INTEGER PRIMARY KEY, recipe_id INTEGER REFERENCES recipes(id));',
      "INSERT INTO family_users VALUES (1,'owner');",
      'INSERT INTO family_sessions VALUES (1,1);',
      "INSERT INTO people VALUES (7,'Existing person');",
      "INSERT INTO events(id,title) VALUES (31,'Existing calendar event');",
      'INSERT INTO event_people VALUES (31,7);',
      "INSERT INTO lists VALUES (1,'Family groceries');",
      "INSERT INTO list_items VALUES (1,1,'Milk');",
      "INSERT INTO recipes VALUES (1,'Dinner');",
      'INSERT INTO meal_plan_items VALUES (1,1);',
    ].join('\n'))
    original.prepare('UPDATE events SET content=? WHERE id=31')
      .run(new Uint8Array([0, 4, 255]))
  } finally {
    original.close()
  }
  const householdId = 'offline-family'
  const household = provisionEmptyHousehold({
    serverDirectory, storageRoot: householdStorageRoot, householdId,
  })
  fs.copyFileSync(originalPath, household.databasePath)
  const target = new DatabaseSync(household.databasePath)
  try {
    target.exec('ALTER TABLE events ADD COLUMN event_uid TEXT')
    target.exec("UPDATE events SET event_uid='0123456789abcdef0123456789abcdef'")
    target.exec('CREATE TABLE new_household_only_table(id INTEGER PRIMARY KEY)')
  } finally {
    target.close()
  }
  fs.mkdirSync(path.join(household.uploadFolder, 'family'))
  fs.writeFileSync(path.join(legacyRoot, 'uploads', 'family', 'photo.png'),
    Buffer.from([1, 2, 3, 250]))
  fs.writeFileSync(path.join(household.uploadFolder, 'family', 'photo.png'),
    Buffer.from([1, 2, 3, 250]))
  const options = { serverDirectory, legacyRoot, householdStorageRoot, householdId }
  return { ...options, originalPath, household, work }
}

function audit(f) {
  return reconcileOfflineLegacyHousehold(f)
}

function fingerprint(filename) {
  return createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}

test('read-only offline audit retains legacy columns, every original row and nested uploads', t => {
  const f = fixture(t)
  const before = fingerprint(f.originalPath)
  assert.deepEqual(audit(f), {
    ok: true,
    originalTablesChecked: 9,
    originalRecordsPreserved: 9,
    uploadFilesPreserved: 1,
    productionDeploymentAuthorized: false,
  })
  assert.equal(fingerprint(f.originalPath), before)
  const db = new DatabaseSync(f.household.databasePath, { readOnly: true })
  try {
    assert.equal(db.prepare('SELECT event_uid FROM events').get().event_uid,
      '0123456789abcdef0123456789abcdef')
  } finally {
    db.close()
  }
})

test('existing event edits and extra legacy-column rows are rejected', t => {
  const f = fixture(t)
  const changed = new DatabaseSync(f.household.databasePath)
  try {
    changed.prepare('UPDATE events SET title=? WHERE id=31').run('Wrong event')
  } finally { changed.close() }
  assert.throws(() => audit(f), /existing row values or counts changed in events/)
})

test('deleted legacy columns and missing old tables cannot pass reconciliation', t => {
  const f = fixture(t)
  const changed = new DatabaseSync(f.household.databasePath)
  try { changed.exec('DROP TABLE meal_plan_items') }
  finally { changed.close() }
  assert.throws(() => audit(f), /legacy table missing/)
})

test('changed upload bytes and missing uploads fail closed', t => {
  const f = fixture(t)
  const photo = path.join(f.household.uploadFolder, 'family', 'photo.png')
  fs.writeFileSync(photo, 'CORRUPTED')
  assert.throws(() => audit(f), /uploaded files are missing or modified/)
  fs.unlinkSync(photo)
  assert.throws(() => audit(f), /uploaded files are missing or modified/)
})

test('unexpected WAL sidecar and invalid offline source marker refuse audit', t => {
  const f = fixture(t)
  fs.writeFileSync(f.household.databasePath + '-wal', 'UNCHECKPOINTED')
  assert.throws(() => audit(f), /unexpected offline staging files/)
  fs.unlinkSync(f.household.databasePath + '-wal')
  fs.unlinkSync(path.join(f.legacyRoot, '.family-calendar-legacy-offline-review.json'))
  assert.throws(() => audit(f), /incomplete or unexpected offline staging files/)
})

test('relative source paths and stages nested under the checkout refuse audit', t => {
  const f = fixture(t)
  assert.throws(() => audit({ ...f, legacyRoot: 'relative' }),
    /absolute staging paths/)
  assert.throws(() => audit({ ...f, householdStorageRoot: f.work }),
    /staging must be separate/)
})
