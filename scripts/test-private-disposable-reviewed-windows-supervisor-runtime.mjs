// Windows CI runs real Node child processes but ONLY OS-temp fixture roots.
// Never attaches to the installed calendar's listeners, tasks, or SQLite.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  launchDisposableReviewedWindowsHouseholds,
} from '../Server/private-disposable-reviewed-windows-supervisor-runtime.mjs'
import {
  inspectReviewedWindowsSupervisorOwnership,
} from '../Server/private-reviewed-windows-supervisor-ownership.mjs'

const primary = 'my-home-calendar'
const friend = 'family-' + 'f'.repeat(24)
function plan(ids = [primary]) {
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
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-real-disposable-windows-supervisor-'))
  const state = path.join(root, 'state')
  fs.mkdirSync(state)
  const runtimes = []
  t.after(async () => {
    for (const runtime of runtimes) {
      runtime.terminateRemainingSyntheticChildrenForTest()
    }
    // Removing temporary synthetic fixtures is only a test teardown action.
    // It is NEVER a production orphan-lock recovery technique.
    fs.rmSync(root, { recursive: true, force: true })
  })
  async function start(ids = [primary]) {
    const runtime = await launchDisposableReviewedWindowsHouseholds({
      plan: plan(ids), fixtureRoot: root, stateDirectory: state,
    })
    runtimes.push(runtime)
    return runtime
  }
  return { root, state, runtimes, start }
}

test('actual Node worker is supervised, health-checked and exits gracefully', async t => {
  const f = fixture(t)
  const runtime = await f.start()
  const result = runtime.snapshot()
  assert.equal(result.phase, 'running')
  assert.deepEqual(result.householdIds, [primary])
  assert.equal(result.actualChildHandlesCaptured, true)
  assert.equal(result.authenticatedLoopbackHealthChecked, true)
  assert.equal(result.usesOnlyOsTempFixture, true)
  assert.equal(result.safeToDeployTest, false)
  assert.equal(result.windowsTaskInstalled, false)
  assert.equal(result.allOsWritersFenced, false)
  assert.equal(inspectReviewedWindowsSupervisorOwnership(f.state)
    .instanceLockPresent, true)
  const done = await runtime.shutdown()
  assert.equal(done.supervisedChildrenExited, true)
  assert.equal(done.safeToDeployTest, false)
  assert.equal(runtime.snapshot().phase, 'stopped')
  assert.equal(inspectReviewedWindowsSupervisorOwnership(f.state)
    .instanceLockPresent, false)
})

test('primary and invited friend require distinct real captured children', async t => {
  const f = fixture(t)
  const runtime = await f.start([primary, friend])
  const snapshot = runtime.snapshot()
  assert.deepEqual(snapshot.householdIds, [primary, friend])
  assert.equal(snapshot.householdCount, 2)
  assert.equal(snapshot.capturedCount, 2)
  await runtime.shutdown()
  assert.equal(runtime.snapshot().allCapturedChildrenExited, true)
})

test('a second simultaneous startup cannot steal the owner lock', async t => {
  const f = fixture(t)
  const first = await f.start()
  await assert.rejects(f.start(), /manual review/)
  assert.equal(first.snapshot().phase, 'running')
  await first.shutdown()
  assert.equal(inspectReviewedWindowsSupervisorOwnership(f.state)
    .instanceLockPresent, false)
})

test('unexpected real child death creates durable hold and refuses restart', async t => {
  const f = fixture(t)
  const runtime = await f.start([primary, friend])
  assert.equal(runtime.crashSyntheticHouseholdForTest(friend), true)
  const deadline = Date.now() + 4000
  while (runtime.snapshot().phase !== 'held' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(runtime.snapshot().phase, 'held')
  assert.equal(runtime.snapshot().durableHoldPresent, true)
  await assert.rejects(runtime.shutdown(), /crashed|held|graceful stop|cannot replace/)
  await assert.rejects(f.start([primary, friend]), /manual review/)
  const inspected = inspectReviewedWindowsSupervisorOwnership(f.state)
  assert.equal(inspected.instanceLockPresent, true)
  assert.equal(inspected.crashHoldPresent, true)
  assert.equal(inspected.mayAutomaticallyRestart, false)
})

test('a forged or demo-only household plan is rejected without launching', async t => {
  const f = fixture(t)
  await assert.rejects(
    launchDisposableReviewedWindowsHouseholds({
      plan: plan(['family-a']), fixtureRoot: f.root, stateDirectory: f.state,
    }),
    /non-demo primary/,
  )
  assert.equal(inspectReviewedWindowsSupervisorOwnership(f.state)
    .instanceLockPresent, false)
})

test('existing synthetic crash-hold prevents a new startup', async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.state,
    '.family-calendar-private-supervisor-REQUIRES-REVIEW.json'), 'synthetic hold')
  await assert.rejects(f.start(), /manual review/)
})

test('non-temp source directory cannot run a worker or claim an owner', async t => {
  const f = fixture(t)
  await assert.rejects(
    launchDisposableReviewedWindowsHouseholds({
      plan: plan(), fixtureRoot: process.cwd(), stateDirectory: f.state,
    }),
    /OS-temp fixtures/,
  )
  assert.equal(inspectReviewedWindowsSupervisorOwnership(f.state)
    .instanceLockPresent, false)
})

test('a second shutdown cannot restart or release the same supervisor twice', async t => {
  const f = fixture(t)
  const runtime = await f.start()
  await runtime.shutdown()
  await assert.rejects(runtime.shutdown(), /shutdown already requested/)
})
