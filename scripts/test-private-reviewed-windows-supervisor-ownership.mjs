// Real OS child-process tests, but all files are disposable and never connected
// to the installed Windows calendar, a Task, HTTPS, or production SQLite.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  createReviewedWindowsSupervisorOwnership,
  inspectReviewedWindowsSupervisorOwnership,
} from '../Server/private-reviewed-windows-supervisor-ownership.mjs'

const home = 'my-primary-family'
const invited = 'family-' + 'b'.repeat(24)

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-reviewed-supervisor-'))
  const stateDirectory = path.join(root, 'supervisor')
  fs.mkdirSync(stateDirectory)
  const children = []
  t.after(async () => {
    for (const child of children) await stop(child)
    fs.rmSync(root, { recursive: true, force: true })
  })
  function plan(ids = [home]) {
    return Object.freeze({
      kind: 'reviewed-private-test-startup-plan-v1',
      primaryHouseholdId: ids[0],
      householdIds: Object.freeze([...ids]),
      householdCount: ids.length,
      planVerifiedReadOnly: true,
      deploymentAuthorized: false,
      taskSchedulerInstalled: false,
    })
  }
  return { stateDirectory, plan, children }
}

async function start(f) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  f.children.push(child)
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  assert(child.connected)
  assert(Number.isSafeInteger(child.pid))
  return child
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve, reject) => {
    let finished = false
    const timer = setTimeout(() => done(new Error('Synthetic child refused exit.')), 12000)
    function done(error) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
      if (error) reject(error)
      else resolve()
    }
    function onExit() { done() }
    function onError(error) { done(error) }
    child.once('exit', onExit)
    child.once('error', onError)
    if (!child.kill()) done(new Error('Synthetic child could not be stopped.'))
  })
}

test('reviewed primary-only child starts, stops, and releases only its own lock', async t => {
  const f = fixture(t)
  const guard = createReviewedWindowsSupervisorOwnership({
    plan: f.plan(), stateDirectory: f.stateDirectory,
  })
  const c = await start(f)
  guard.captureBackend({ householdId: home, child: c })
  guard.markHealthy()
  const active = guard.snapshot()
  assert.equal(active.phase, 'running')
  assert.equal(active.taskSchedulerInstalled, false)
  assert.equal(active.automaticRestartAllowed, false)
  assert.deepEqual(inspectReviewedWindowsSupervisorOwnership(f.stateDirectory), {
    instanceLockPresent: true, crashHoldPresent: false,
    mayAutomaticallyRemoveLocks: false, mayAutomaticallyRestart: false,
    deploymentAuthorized: false,
  })
  guard.beginGracefulShutdown()
  assert.throws(() => guard.finishGracefulShutdown(), /child exits must be confirmed/)
  await stop(c)
  assert.equal(guard.snapshot().allCapturedChildrenExited, true)
  assert.deepEqual(guard.finishGracefulShutdown(), {
    capturedChildExitsConfirmed: true,
    instanceReleasedByOwner: true,
    osWideWriterFencingVerified: false,
    deploymentAuthorized: false,
  })
  assert.equal(guard.snapshot().phase, 'stopped')
  assert.equal(inspectReviewedWindowsSupervisorOwnership(f.stateDirectory)
    .instanceLockPresent, false)
})

test('operator-reviewed primary and invited owner each needs a captured OS child', async t => {
  const f = fixture(t)
  const guard = createReviewedWindowsSupervisorOwnership({
    plan: f.plan([home, invited]), stateDirectory: f.stateDirectory,
  })
  const a = await start(f)
  const b = await start(f)
  guard.captureBackend({ householdId: home, child: a })
  assert.throws(() => guard.markHealthy(), /every approved backend/)
  assert.throws(() => guard.captureBackend({ householdId: home, child: b }),
    /duplicate or already-exited/)
  assert.throws(() => guard.captureBackend({ householdId: 'family-a', child: b }),
    /unrecognized/)
  guard.captureBackend({ householdId: invited, child: b })
  guard.markHealthy()
  guard.beginGracefulShutdown()
  await stop(a)
  assert.throws(() => guard.finishGracefulShutdown(), /child exits must be confirmed/)
  await stop(b)
  assert.equal(guard.finishGracefulShutdown().instanceReleasedByOwner, true)
})

test('unexpected actual child exit writes durable hold and blocks new ownership', async t => {
  const f = fixture(t)
  const guard = createReviewedWindowsSupervisorOwnership({
    plan: f.plan(), stateDirectory: f.stateDirectory,
  })
  const child = await start(f)
  guard.captureBackend({ householdId: home, child })
  guard.markHealthy()
  await stop(child)
  assert.equal(guard.snapshot().phase, 'held')
  // Windows can report IPC disconnect before the process exit event. Both
  // are durable crash-hold reasons and must refuse another automatic owner.
  assert.ok(['unexpected-child-exit', 'supervisor-ipc-disconnect']
    .includes(guard.snapshot().failureReason))
  const inspect = inspectReviewedWindowsSupervisorOwnership(f.stateDirectory)
  assert.equal(inspect.instanceLockPresent, true)
  assert.equal(inspect.crashHoldPresent, true)
  assert.throws(() => createReviewedWindowsSupervisorOwnership({
    plan: f.plan(), stateDirectory: f.stateDirectory,
  }), /manual review/)
  assert.throws(() => guard.beginGracefulShutdown(), /cannot replace crash recovery/)
})

test('disconnected IPC is held even before the child exits', async t => {
  const f = fixture(t)
  const guard = createReviewedWindowsSupervisorOwnership({
    plan: f.plan(), stateDirectory: f.stateDirectory,
  })
  const child = await start(f)
  guard.captureBackend({ householdId: home, child })
  guard.markHealthy()
  await new Promise(resolve => {
    child.once('disconnect', resolve)
    child.disconnect()
  })
  assert.equal(guard.snapshot().failureReason, 'supervisor-ipc-disconnect')
  assert.equal(guard.snapshot().durableHoldPresent, true)
  assert.equal(guard.snapshot().automaticRestartAllowed, false)
  await stop(child)
})

test('second supervisor, stale lock or existing durable hold blocks startup', t => {
  const f = fixture(t)
  const args = { plan: f.plan(), stateDirectory: f.stateDirectory }
  createReviewedWindowsSupervisorOwnership(args)
  assert.throws(() => createReviewedWindowsSupervisorOwnership(args), /manual review/)
  const lock = path.join(f.stateDirectory, '.family-calendar-reviewed-supervisor-instance.lock')
  assert(fs.existsSync(lock))
  fs.unlinkSync(lock) // only synthetic fixture operator mutation
  fs.writeFileSync(path.join(f.stateDirectory,
    '.family-calendar-private-supervisor-REQUIRES-REVIEW.json'), 'stale hold')
  assert.throws(() => createReviewedWindowsSupervisorOwnership(args), /manual review/)
})

test('altering another process ownership lock prevents clean release', async t => {
  const f = fixture(t)
  const guard = createReviewedWindowsSupervisorOwnership({
    plan: f.plan(), stateDirectory: f.stateDirectory,
  })
  const child = await start(f)
  guard.captureBackend({ householdId: home, child })
  guard.markHealthy()
  guard.beginGracefulShutdown()
  await stop(child)
  const lock = path.join(f.stateDirectory, '.family-calendar-reviewed-supervisor-instance.lock')
  fs.writeFileSync(lock, 'FOREIGN OWNER')
  assert.throws(() => guard.finishGracefulShutdown(), /ownership changed/)
  assert(fs.existsSync(lock))
})

test('demo IDs, impersonated plans, overlapping family IDs and unlocked paths fail closed', t => {
  const f = fixture(t)
  const act = plan => createReviewedWindowsSupervisorOwnership({
    plan, stateDirectory: f.stateDirectory,
  })
  assert.throws(() => act(f.plan(['family-a'])), /non-demo primary/)
  assert.throws(() => act(f.plan([invited])), /non-demo primary/)
  assert.throws(() => act(f.plan([home,home])), /non-demo primary/)
  const spoof = { ...f.plan() }
  assert.throws(() => act(spoof), /non-demo primary/)
  const forged = Object.freeze({
    ...f.plan(), deploymentAuthorized: true,
  })
  assert.throws(() => act(forged), /non-demo primary/)
  assert.equal(fs.readdirSync(f.stateDirectory).length, 0)
})

test('non-physical state path is rejected without writing any lock', t => {
  const f = fixture(t)
  const file = path.join(f.stateDirectory, 'not-a-directory')
  fs.writeFileSync(file, 'sentinel')
  assert.throws(() => createReviewedWindowsSupervisorOwnership({
    plan: f.plan(), stateDirectory: file,
  }), /physical directory/)
  assert.equal(fs.readFileSync(file,'utf8'),'sentinel')
})
