// Integration rehearsal with a real independent Node process.
// All paths are newly created OS temporary fixtures, never LIVE/TEST data.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'
import { acquirePrivateGatewayWriterLock } from '../Server/private-gateway-writer-lock.mjs'
import { auditPrivateGatewayAbandonedLock } from '../Server/private-gateway-recovery-audit.mjs'

const folder = path.dirname(fileURLToPath(import.meta.url))
const serverDirectory = path.resolve(folder, '../Server')
const holderScript = path.join(folder, 'fixtures/private-gateway-lock-holder.mjs')

function makeFixture(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'family-calendar-crash-lock-'))
  t.after(() => fs.rmSync(work, { recursive: true, force: true }))
  const storageRoot = path.join(work, 'storage')
  fs.mkdirSync(storageRoot)
  for (const householdId of ['family-a', 'family-b']) {
    provisionEmptyHousehold({ serverDirectory, storageRoot, householdId })
  }
  const centralDatabasePath = path.join(work, 'central.db')
  const db = new DatabaseSync(centralDatabasePath)
  try {
    db.exec("CREATE TABLE household_registry (storage_id TEXT PRIMARY KEY);"
      + "INSERT INTO household_registry VALUES ('family-a'),('family-b');"
      + "CREATE TABLE event_share_sync_pending (source_event_id INTEGER PRIMARY KEY);")
  } finally { db.close() }
  return { work, storageRoot, centralDatabasePath, serverDirectory }
}

function startHolder(root) {
  return spawn(process.execPath, [holderScript, root], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env },
  })
}

function waitReady(child) {
  return new Promise((resolve, reject) => {
    let output = ''
    let err = ''
    const timer = setTimeout(() => finish(new Error('Lock holder did not start within 15 seconds. ' + err.slice(-300))), 15000)
    const data = chunk => {
      output += chunk.toString('utf8')
      if (output.includes('PRIVATE_LOCK_ACQUIRED')) finish()
    }
    const stderr = chunk => { err += chunk.toString('utf8') }
    const exited = (code, signal) => finish(new Error('Lock holder exited early (' + code + ', ' + signal + '): ' + err.slice(-300)))
    const failed = error => finish(error)
    function finish(error) {
      clearTimeout(timer)
      child.stdout.off('data', data)
      child.stderr.off('data', stderr)
      child.off('exit', exited)
      child.off('error', failed)
      if (error) reject(error)
      else resolve()
    }
    child.stdout.on('data', data)
    child.stderr.on('data', stderr)
    child.once('exit', exited)
    child.once('error', failed)
  })
}

async function forceStop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Child process remained alive after force termination.')), 10000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
  if (!child.kill('SIGKILL')) throw new Error('Could not force-terminate synthetic child.')
  await exited
}

test('an actual killed lock-owner process leaves a non-reclaimable quarantine', async t => {
  const f = makeFixture(t)
  const ownerPath = path.join(f.storageRoot, '.family-calendar-private-gateway-writer.lock', 'owner.json')
  const child = startHolder(f.storageRoot)
  // Always terminate the disposable child before temporary files are removed.
  t.after(async () => { await forceStop(child) })
  await waitReady(child)
  const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'))
  assert.equal(owner.pid, child.pid)
  assert.notEqual(owner.pid, process.pid)
  assert.throws(() => acquirePrivateGatewayWriterLock(f.storageRoot), /already exists/)
  await forceStop(child)
  const unchanged = fs.readFileSync(ownerPath, 'utf8')
  assert.throws(() => acquirePrivateGatewayWriterLock(f.storageRoot), /already exists/)
  const report = auditPrivateGatewayAbandonedLock(f)
  assert.equal(report.lockPresent, true)
  assert.equal(report.centralIntegrity, true)
  assert.deepEqual(report.householdChecks.map(row => row.intact), [true, true])
  assert.equal(report.pendingSourceSync, 0)
  assert.equal(report.requiresOperatorFencing, true)
  assert.equal(report.canAutomaticallyReclaim, false)
  assert.equal(fs.readFileSync(ownerPath, 'utf8'), unchanged)
})

test('orphaned lock is never self-healed by a later independent startup', async t => {
  const f = makeFixture(t)
  const first = startHolder(f.storageRoot)
  t.after(async () => { await forceStop(first) })
  await waitReady(first)
  await forceStop(first)
  // The second independently launched Node process has its own PID and
  // must fail rather than reusing a lock left by the dead first owner.
  const second = startHolder(f.storageRoot)
  t.after(async () => { await forceStop(second) })
  const result = await new Promise((resolve, reject) => {
    let diagnostic = ''
    const timer = setTimeout(() => {
      second.kill('SIGKILL')
      reject(new Error('Second holder unexpectedly survived the lock conflict.'))
    }, 15000)
    second.stderr.on('data', x => { diagnostic += x.toString('utf8') })
    second.once('error', error => { clearTimeout(timer); reject(error) })
    second.once('exit', code => {
      clearTimeout(timer)
      resolve({ code, diagnostic })
    })
  })
  assert.notEqual(result.code, 0)
  assert.match(result.diagnostic, /writer lock already exists/)
  const report = auditPrivateGatewayAbandonedLock(f)
  assert.equal(report.canAutomaticallyReclaim, false)
  assert.equal(report.lockPresent, true)
})


test('orphaned SQLite shared-memory sidecars are flagged in central and household recovery audits', async t => {
  const f = makeFixture(t)
  const holder = startHolder(f.storageRoot)
  t.after(async () => { await forceStop(holder) })
  await waitReady(holder)
  await forceStop(holder)

  const ownerPath = path.join(f.storageRoot,
    '.family-calendar-private-gateway-writer.lock', 'owner.json')
  const originalOwner = fs.readFileSync(ownerPath, 'utf8')
  const databases = [
    f.centralDatabasePath,
    path.join(f.storageRoot, 'households', 'family-a', 'data', 'calendar.db'),
    path.join(f.storageRoot, 'households', 'family-b', 'data', 'calendar.db'),
  ]

  for (const databaseFile of databases) {
    const sidecar = databaseFile + '-shm'
    assert.equal(fs.existsSync(sidecar), false,
      'Disposable fixture should start without a SQLite shared-memory sidecar.')
    fs.writeFileSync(sidecar, 'SYNTHETIC ORPHANED SQLITE SHARED MEMORY')
    try {
      const report = auditPrivateGatewayAbandonedLock(f)
      assert.equal(report.lockPresent, true)
      assert.equal(report.requiresOperatorFencing, true)
      assert.equal(report.canAutomaticallyReclaim, false)
      assert.ok(report.issues.some(item =>
        item.includes('SQLite recovery sidecar requires offline operator review.')),
      'Expected an explicit sidecar warning for ' + path.basename(databaseFile))
      assert.equal(fs.readFileSync(ownerPath, 'utf8'), originalOwner,
        'Recovery inspection must never rewrite the orphaned lock.')
    } finally {
      fs.rmSync(sidecar, { force: true })
    }
  }

  assert.equal(fs.readFileSync(ownerPath, 'utf8'), originalOwner)
  assert.throws(() => acquirePrivateGatewayWriterLock(f.storageRoot),
    /writer lock already exists/)
})
