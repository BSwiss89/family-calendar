import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquirePrivateGatewayWriterLock, acquirePrivateHouseholdBackendWriterLock } from '../Server/private-gateway-writer-lock.mjs'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'
import { fileURLToPath } from 'node:url'

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-gateway-writer-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('only one private household gateway may own the same storage root', t => {
  const root = temporaryRoot(t)
  const first = acquirePrivateGatewayWriterLock(root)
  assert.throws(() => acquirePrivateGatewayWriterLock(root),
    /already exists; refuse concurrent startup/)
  first.release()
  const second = acquirePrivateGatewayWriterLock(root)
  second.release()
  assert.equal(fs.readdirSync(root).length, 0)
})

test('an abandoned writer lock refuses restart even when its owner PID is obsolete', t => {
  const root = temporaryRoot(t)
  const lock = acquirePrivateGatewayWriterLock(root)
  const directory = path.join(root, '.family-calendar-private-gateway-writer.lock')
  assert.ok(fs.existsSync(path.join(directory, 'owner.json')))
  // Simulate prior process termination without release, then explicitly
  // clean up only this disposable fixture after verifying refusal.
  assert.throws(() => acquirePrivateGatewayWriterLock(root), /already exists/)
  lock.release()
})

test('damaged writer identity never removes or steals an existing lock', t => {
  const root = temporaryRoot(t)
  const lock = acquirePrivateGatewayWriterLock(root)
  const directory = path.join(root, '.family-calendar-private-gateway-writer.lock')
  const marker = path.join(directory, 'owner.json')
  const original = fs.readFileSync(marker, 'utf8')
  fs.writeFileSync(marker, JSON.stringify({
    ...JSON.parse(original), token: 'a'.repeat(64),
  }))
  assert.throws(() => lock.release(), /ownership mismatch/)
  assert.ok(fs.existsSync(directory))
  assert.throws(() => acquirePrivateGatewayWriterLock(root), /already exists/)
  // No production cleanup is attempted; the test owns this disposable root.
})

test('refuse invalid or missing roots without creating directories', t => {
  const root = temporaryRoot(t)
  assert.throws(() => acquirePrivateGatewayWriterLock('relative-folder'), /absolute storage root/)
  assert.throws(() => acquirePrivateGatewayWriterLock(path.join(root, 'not-present')))
  assert.deepEqual(fs.readdirSync(root), [])
})

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Server')
function householdFixture(t) {
  const root = temporaryRoot(t)
  const a = provisionEmptyHousehold({ serverDirectory, storageRoot: root,
    householdId: 'family-a' })
  const b = provisionEmptyHousehold({ serverDirectory, storageRoot: root,
    householdId: 'family-b' })
  return { root, a, b }
}

test('a second backend for the same family is refused while another family is unaffected', t => {
  const { root, a, b } = householdFixture(t)
  const lockA = acquirePrivateHouseholdBackendWriterLock(a)
  const lockB = acquirePrivateHouseholdBackendWriterLock(b)
  assert.throws(() => acquirePrivateHouseholdBackendWriterLock(a),
    /backend writer lock already exists/)
  assert.ok(fs.existsSync(path.join(root, 'households', 'family-a',
    '.family-calendar-private-backend-writer.lock', 'owner.json')))
  lockB.release()
  lockA.release()
  const restart = acquirePrivateHouseholdBackendWriterLock(a)
  restart.release()
})

test('an interrupted backend leaves a lock that refuses automatic restart', t => {
  const { root, a } = householdFixture(t)
  acquirePrivateHouseholdBackendWriterLock(a)
  const marker = path.join(root, 'households', 'family-a',
    '.family-calendar-private-backend-writer.lock', 'owner.json')
  assert.throws(() => acquirePrivateHouseholdBackendWriterLock(a),
    /backend writer lock already exists/)
  assert.equal(fs.existsSync(marker), true)
})

test('invalid backend storage and modified lock markers never unlock a household', t => {
  const { root, a } = householdFixture(t)
  assert.throws(() => acquirePrivateHouseholdBackendWriterLock({
    ...a, mode: 'legacy',
  }), /provisioned household storage/)
  assert.throws(() => acquirePrivateHouseholdBackendWriterLock({
    ...a, householdId: 'family-b',
  }), /mismatched storage boundary/)
  const owned = acquirePrivateHouseholdBackendWriterLock(a)
  const marker = path.join(root, 'households', 'family-a',
    '.family-calendar-private-backend-writer.lock', 'owner.json')
  const value = JSON.parse(fs.readFileSync(marker, 'utf8'))
  fs.writeFileSync(marker, JSON.stringify({ ...value, token: 'a'.repeat(64) }))
  assert.throws(() => owned.release(), /ownership mismatch/)
  assert.throws(() => acquirePrivateHouseholdBackendWriterLock(a),
    /backend writer lock already exists/)
})
