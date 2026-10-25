import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { provisionEmptyHousehold, resolveHouseholdStorage } from '../Server/household-storage.mjs'
import { acquirePrivateGatewayWriterLock } from '../Server/private-gateway-writer-lock.mjs'
import { auditPrivateGatewayAbandonedLock } from '../Server/private-gateway-recovery-audit.mjs'

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Server')

function makeFixture(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-gateway-recovery-audit-'))
  t.after(() => fs.rmSync(work, { recursive: true, force: true }))
  const storageRoot = path.join(work, 'storage')
  fs.mkdirSync(storageRoot)
  for (const id of ['family-a', 'family-b']) {
    provisionEmptyHousehold({ serverDirectory, storageRoot, householdId: id })
  }
  const centralDatabasePath = path.join(work, 'identity.db')
  const db = new DatabaseSync(centralDatabasePath)
  db.exec("CREATE TABLE household_registry (storage_id TEXT PRIMARY KEY);"
    + "INSERT INTO household_registry VALUES ('family-a'), ('family-b');"
    + "CREATE TABLE event_share_sync_pending (source_event_id INTEGER PRIMARY KEY);")
  db.close()
  const lock = acquirePrivateGatewayWriterLock(storageRoot)
  const lockPath = path.join(storageRoot, '.family-calendar-private-gateway-writer.lock')
  return {
    work, storageRoot, centralDatabasePath, lockPath, lock,
    args: { serverDirectory, storageRoot, centralDatabasePath },
  }
}

test('read-only recovery inspection refuses to certify an active process and retains the lock', t => {
  const f = makeFixture(t)
  const marker = path.join(f.lockPath, 'owner.json')
  const before = fs.readFileSync(marker, 'utf8')
  const a = auditPrivateGatewayAbandonedLock(f.args)
  assert.equal(a.ownerProcess, 'running-or-access-denied')
  assert.equal(a.centralIntegrity, true)
  assert.deepEqual(a.householdChecks.map(x => x.intact), [true, true])
  assert.equal(a.pendingSourceSync, 0)
  assert.equal(a.canAutomaticallyReclaim, false)
  assert.equal(a.requiresOperatorFencing, true)
  assert.equal(fs.readFileSync(marker, 'utf8'), before)
  f.lock.release()
})

test('missing owner process still cannot authorize automatic lock removal', t => {
  const f = makeFixture(t)
  const marker = path.join(f.lockPath, 'owner.json')
  const owner = JSON.parse(fs.readFileSync(marker, 'utf8'))
  owner.pid = 2147483647
  fs.writeFileSync(marker, JSON.stringify(owner))
  const a = auditPrivateGatewayAbandonedLock(f.args)
  assert.equal(a.canAutomaticallyReclaim, false)
  assert.equal(a.lockPresent, true)
  assert.ok(fs.existsSync(marker))
  assert.throws(() => acquirePrivateGatewayWriterLock(f.storageRoot), /already exists/)
})

test('pending sync and damaged household database make recovery inspection report danger', t => {
  const f = makeFixture(t)
  const central = new DatabaseSync(f.centralDatabasePath)
  central.exec('INSERT INTO event_share_sync_pending VALUES (123)')
  central.close()
  const household = resolveHouseholdStorage({
    serverDirectory, storageRoot: f.storageRoot, householdId: 'family-b',
  })
  fs.writeFileSync(household.databasePath, 'not-a-database')
  const a = auditPrivateGatewayAbandonedLock(f.args)
  assert.equal(a.pendingSourceSync, 1)
  assert.equal(a.centralIntegrity, true)
  assert.ok(a.issues.some(x => x.includes('await verified replay')))
  assert.ok(a.issues.some(x => x.includes('family-b')))
  assert.equal(a.canAutomaticallyReclaim, false)
})

test('unknown or altered lock marker is never trusted, modified or cleared', t => {
  const f = makeFixture(t)
  const marker = path.join(f.lockPath, 'owner.json')
  const original = fs.readFileSync(marker, 'utf8')
  fs.writeFileSync(marker, '{"kind":"bad","pid":123}')
  assert.throws(() => auditPrivateGatewayAbandonedLock(f.args), /malformed/)
  assert.ok(fs.existsSync(marker))
  fs.writeFileSync(marker, original)
  fs.writeFileSync(path.join(f.lockPath, 'unexpected'), 'x')
  assert.throws(() => auditPrivateGatewayAbandonedLock(f.args), /incomplete or modified/)
})

test('missing and mismatched household marker refuses preflight without provisioning data', t => {
  const f = makeFixture(t)
  const marker = path.join(f.storageRoot, 'households', 'family-a',
    '.family-calendar-household.json')
  fs.rmSync(marker)
  const a = auditPrivateGatewayAbandonedLock(f.args)
  assert.ok(a.issues.some(x => x.includes('family-a')))
  assert.equal(a.canAutomaticallyReclaim, false)
  assert.equal(fs.existsSync(marker), false)
})

test('audit never invents a lock or touches nonexisting fixture roots', t => {
  const f = makeFixture(t)
  f.lock.release()
  assert.throws(() => auditPrivateGatewayAbandonedLock(f.args))
  assert.equal(fs.existsSync(f.lockPath), false)
  assert.throws(() => auditPrivateGatewayAbandonedLock({
    ...f.args, storageRoot: path.join(f.work, 'absent'),
  }))
})
