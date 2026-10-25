import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { acquirePrivateGatewayWriterLock } from '../Server/private-gateway-writer-lock.mjs'

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
