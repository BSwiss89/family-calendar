// End-to-end Git + Task Scheduler coexistence rehearsal: temp-only fixtures.
// Does not enumerate or change the real laptop or invoke installed tasks.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  launchDisposablePinnedWindowsHostHandoff,
} from '../Server/private-disposable-pinned-windows-host-handoff.mjs'
import {
  inspectReviewedWindowsSupervisorOwnership,
} from '../Server/private-reviewed-windows-supervisor-ownership.mjs'

const primary = 'my-home-calendar'
const friend = 'family-' + 'c'.repeat(24)
function plan(ids = [primary, friend]) {
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
function task(name, enabled = true, restartCount = 0) {
  return { name, enabled, restartCount, multipleInstances: 'IgnoreNew',
    triggerCount: 1 }
}
function snapshot() {
  return {
    schemaVersion: 1, enumerationSucceeded: true,
    tasks: [
      task('Family Calendar Server', true, 3),
      task('Family Calendar Secure TEST', true, 3),
      task('Family Calendar Ollama Server', true, 3),
      task('Family Calendar Watchdog'),
      task('Family Calendar Secure TEST Auto Deploy'),
      task('Family Calendar Auto Deploy', false),
      task('Family Calendar Backup Sender', true),
    ],
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 7000,
  }).trim()
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-windows-host-handoff-'))
  const worker = path.join(root, 'worker')
  const state = path.join(worker, 'state')
  const checkout = path.join(root, 'candidate')
  fs.mkdirSync(worker)
  fs.mkdirSync(state)
  fs.mkdirSync(checkout)
  git(checkout, 'init', '-q')
  git(checkout, 'config', 'user.name', 'Fixture')
  git(checkout, 'config', 'user.email', 'fixture@example.invalid')
  fs.writeFileSync(path.join(checkout, 'candidate.txt'), 'known disposable candidate\\n')
  git(checkout, 'add', 'candidate.txt')
  git(checkout, 'commit', '-q', '-m', 'Synthetic pinned code')
  const commit = git(checkout, 'rev-parse', 'HEAD')
  const runtimes = []
  t.after(async () => {
    for (const runtime of runtimes) {
      await runtime.terminateRemainingSyntheticChildrenForTest()
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8,
      retryDelay: 200 })
  })
  async function start(options = {}) {
    const observer = options.snapshotProvider ??
      (async () => snapshot())
    const runtime = await launchDisposablePinnedWindowsHostHandoff({
      plan: plan(),
      fixtureRoot: worker,
      stateDirectory: state,
      candidateCheckoutDirectory: checkout,
      expectedCommitSha: commit,
      snapshotProvider: observer,
      ...options,
    })
    runtimes.push(runtime)
    return runtime
  }
  return { root, worker, state, checkout, commit, start }
}

test('pinned clean disposable checkout starts two healthy real Node children despite enabled TEST auto-deploy', async t => {
  const f = fixture(t)
  const runtime = await f.start()
  const current = runtime.snapshot()
  assert.equal(current.phase, 'running')
  assert.equal(current.householdCount, 2)
  assert.equal(current.pinnedDisposableCheckoutChecked, true)
  assert.equal(current.syntheticSchedulerSnapshotChecked, true)
  assert.equal(current.realHostTaskOwnershipProven, false)
  assert.equal(current.osWideSqliteWriterFenceProven, false)
  assert.equal(current.authorizedToDeployTest, false)
  assert.equal(current.authorizedToDeployLive, false)
  assert.equal(current.installedWindowsSupervisor, false)
  assert.equal(inspectReviewedWindowsSupervisorOwnership(f.state)
    .instanceLockPresent, true)
  await runtime.shutdown()
  assert.equal(inspectReviewedWindowsSupervisorOwnership(f.state)
    .instanceLockPresent, false)
})

test('wrong full SHA or an uncommitted candidate is rejected before any ownership claim', async t => {
  const f = fixture(t)
  await assert.rejects(f.start({ expectedCommitSha: 'a'.repeat(40) }),
    /reviewed pinned commit/)
  assert.equal(inspectReviewedWindowsSupervisorOwnership(f.state)
    .instanceLockPresent, false)
  fs.writeFileSync(path.join(f.checkout, 'untracked.txt'), 'dirty')
  await assert.rejects(f.start(), /unreviewed local changes/)
  assert.equal(inspectReviewedWindowsSupervisorOwnership(f.state)
    .instanceLockPresent, false)
})

test('missing or corrupt task inventory cannot start a synthetic supervisor', async t => {
  const f = fixture(t)
  await assert.rejects(f.start({
    snapshotProvider: async () => ({ ...snapshot(),
      enumerationSucceeded: false }),
  }), /inventory/)
  await assert.rejects(f.start({
    snapshotProvider: async () => ({ ...snapshot(),
      tasks: snapshot().tasks.filter(x => x.name !== 'Family Calendar Watchdog') }),
  }), /baseline/)
  assert.equal(inspectReviewedWindowsSupervisorOwnership(f.state)
    .instanceLockPresent, false)
})

test('enabled LIVE deployer, competing supervisor and duplicate tasks block before startup', async t => {
  const f = fixture(t)
  for (const change of [
    s => { s.tasks.find(x => x.name === 'Family Calendar Auto Deploy').enabled = true },
    s => s.tasks.push(task('Family Calendar Private Household Supervisor', true, 3)),
    s => s.tasks.push({ ...s.tasks[0] }),
    s => { s.tasks.find(x => x.name === 'Family Calendar Server').restartCount = 5 },
  ]) {
    const input = snapshot()
    change(input)
    await assert.rejects(f.start({ snapshotProvider: async () => input }),
      /deployer|supervisor|duplicate|baseline/)
    assert.equal(inspectReviewedWindowsSupervisorOwnership(f.state)
      .instanceLockPresent, false)
  }
})

test('scheduler drift during Node startup retains durable synthetic crash hold', async t => {
  const f = fixture(t)
  let count = 0
  await assert.rejects(f.start({
    snapshotProvider: async () => {
      const s = snapshot()
      if (++count === 2) {
        s.tasks.find(x => x.name === 'Family Calendar Secure TEST Auto Deploy')
          .triggerCount = 2
      }
      return s
    },
  }), /drift|changed/)
  const result = inspectReviewedWindowsSupervisorOwnership(f.state)
  assert.equal(result.instanceLockPresent, true)
  assert.equal(result.crashHoldPresent, true)
  assert.equal(result.mayAutomaticallyRestart, false)
  await assert.rejects(f.start(), /manual review/)
})

test('scheduler drift before approved shutdown refuses normal owner-lock release', async t => {
  const f = fixture(t)
  let count = 0
  const runtime = await f.start({
    snapshotProvider: async () => {
      const s = snapshot()
      if (++count === 3) s.tasks.find(x => x.name === 'Family Calendar Watchdog')
        .triggerCount = 2
      return s
    },
  })
  await assert.rejects(runtime.shutdown(), /drift/)
  const held = inspectReviewedWindowsSupervisorOwnership(f.state)
  assert.equal(held.crashHoldPresent, true)
  assert.equal(held.instanceLockPresent, true)
})

test('installed checkout and non-temp source are never allowed into fixture worker', async t => {
  const f = fixture(t)
  await assert.rejects(f.start({
    candidateCheckoutDirectory: process.cwd(),
  }), /non-temporary|forbidden/)
  await assert.rejects(f.start({
    fixtureRoot: f.checkout,
  }), /separate|nested|OS-temp/)
  assert.equal(inspectReviewedWindowsSupervisorOwnership(f.state)
    .instanceLockPresent, false)
})
