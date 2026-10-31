// DEVELOPMENT ONLY: disposable Windows scheduler handoff around reviewed Node workers.
// This adapter never reads or changes real Windows tasks, ports, databases or deployments.
// Its supplied scheduler snapshots are synthetic; no production cutover is authorized.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchDisposableReviewedWindowsHouseholds } from './private-disposable-reviewed-windows-supervisor-runtime.mjs'

const SHA = /^[a-f0-9]{40}$/
const REQUIRED = new Map([
  ['family calendar server', 3],
  ['family calendar secure test', 3],
  ['family calendar ollama server', 3],
  ['family calendar watchdog', null],
  ['family calendar secure test auto deploy', null],
])

function refuse(message) {
  throw new Error('Disposable Windows scheduler handoff refused: ' + message)
}

function inDirectory(base, child) {
  const relative = path.relative(base, child)
  return relative.length > 0 && relative !== '..' &&
    !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

function checkedPhysicalTempDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    refuse('an explicit absolute OS-temp directory is required.')
  }
  let real
  try {
    if (!fs.lstatSync(directory).isDirectory() ||
        fs.lstatSync(directory).isSymbolicLink()) {
      refuse('a physical directory rather than a link is required.')
    }
    real = fs.realpathSync(directory)
  } catch {
    refuse('the physical directory cannot be verified.')
  }
  if (!inDirectory(fs.realpathSync(os.tmpdir()), real)) {
    refuse('real calendar checkout and non-temporary paths are forbidden.')
  }
  return real
}

function gitRead(checkout, args) {
  try {
    return execFileSync('git', ['-C', checkout, ...args], {
      encoding: 'utf8', timeout: 7000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    refuse('the disposable checkout Git identity could not be verified.')
  }
}

function assertDisposableCheckout(checkout, expectedSha) {
  if (typeof expectedSha !== 'string' || !SHA.test(expectedSha)) {
    refuse('a complete pinned commit SHA is required.')
  }
  const root = checkedPhysicalTempDirectory(checkout)
  const top = gitRead(root, ['rev-parse', '--show-toplevel'])
  if (path.resolve(top).toLowerCase() !== root.toLowerCase() ||
      gitRead(root, ['rev-parse', 'HEAD']) !== expectedSha ||
      gitRead(root, ['status', '--porcelain', '--untracked-files=all']) !== '') {
    refuse('the disposable candidate checkout differs from its reviewed clean commit.')
  }
  return root
}

/**
 * Validate the observed scheduler collision surface before and after a
 * synthetic start/stop. It is NEVER a proof of host task ownership or
 * permission to disable the enabled TEST deployer or watchdog.
 */
function fingerprintTaskSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== 1 ||
      snapshot.enumerationSucceeded !== true ||
      !Array.isArray(snapshot.tasks) || snapshot.tasks.length > 128) {
    refuse('the synthetic task inventory is missing or incomplete.')
  }
  const tasks = []
  const seen = new Set()
  for (const task of snapshot.tasks) {
    if (!task || typeof task.name !== 'string' ||
        !/^Family Calendar(?:[ -][a-zA-Z0-9 -]+)?$/i.test(task.name) ||
        typeof task.enabled !== 'boolean' ||
        !Number.isSafeInteger(task.restartCount) || task.restartCount < 0 ||
        !['IgnoreNew', 'Parallel', 'Queue', 'StopExisting'].includes(task.multipleInstances) ||
        !Number.isSafeInteger(task.triggerCount) || task.triggerCount < 0) {
      refuse('synthetic task metadata is malformed.')
    }
    const name = task.name.trim().toLowerCase().replace(/ +/g, ' ')
    if (seen.has(name)) refuse('duplicate protected scheduler task.')
    seen.add(name)
    if (/supervisor/.test(name)) {
      refuse('a competing private supervisor task is already present.')
    }
    if ((/watchdog|auto deploy|secure test|server/.test(name)) &&
        !REQUIRED.has(name) &&
        name !== 'family calendar auto deploy') {
      refuse('an unreviewed writer, watchdog or deploy task is present.')
    }
    tasks.push([name, task.enabled, task.restartCount,
      task.multipleInstances, task.triggerCount])
  }
  for (const [name, restartCount] of REQUIRED) {
    const task = tasks.find(x => x[0] === name)
    if (!task || task[1] !== true ||
        (restartCount !== null &&
          (task[2] !== restartCount || task[3] !== 'IgnoreNew'))) {
      refuse('the observed existing task configuration does not match the reviewed baseline.')
    }
  }
  const legacyAutoDeploy = tasks.find(x => x[0] === 'family calendar auto deploy')
  if (legacyAutoDeploy && legacyAutoDeploy[1] !== false) {
    refuse('the existing LIVE auto-deployer unexpectedly became enabled.')
  }
  // Compare sanitized task attributes, not credentials or task action text.
  return JSON.stringify(tasks.sort((a, b) => a[0].localeCompare(b[0])))
}

async function holdSyntheticStartup(runtime, householdId) {
  // Deliberately crash only a captured DISPOSABLE worker, leaving its durable
  // owner lock and crash marker for review. No real process can be targeted.
  runtime.crashSyntheticHouseholdForTest(householdId)
  for (let i = 0; i < 200 && runtime.snapshot().phase !== 'held'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await runtime.terminateRemainingSyntheticChildrenForTest()
  if (runtime.snapshot().phase !== 'held') {
    refuse('synthetic stop could not be proven; owner lock remains reserved.')
  }
}

/**
 * Rehearses a pinned, clean disposable Git checkout and synthetic Task
 * Scheduler coexistence around the already-reviewed real Node child runner.
 * snapshotProvider is a test-only reader returning sanitized synthetic data.
 * NEVER inject Get-ScheduledTask here or use an installed checkout.
 */
export async function launchDisposablePinnedWindowsHostHandoff({
  plan, fixtureRoot, stateDirectory, candidateCheckoutDirectory,
  expectedCommitSha, snapshotProvider,
}) {
  if (typeof snapshotProvider !== 'function' ||
      !Array.isArray(plan?.householdIds) || !plan.householdIds.length) {
    refuse('an approved fixture plan and synthetic task observer are required.')
  }
  const fixture = checkedPhysicalTempDirectory(fixtureRoot)
  const state = checkedPhysicalTempDirectory(stateDirectory)
  const checkout = assertDisposableCheckout(candidateCheckoutDirectory, expectedCommitSha)
  if (!inDirectory(fixture, state) || fixture === checkout ||
      inDirectory(fixture, checkout) || inDirectory(checkout, fixture)) {
    refuse('disposable source, worker and state directories must be separate.')
  }
  const baseline = fingerprintTaskSnapshot(await snapshotProvider())
  const runtime = await launchDisposableReviewedWindowsHouseholds({
    plan, fixtureRoot: fixture, stateDirectory: state,
  })
  let stopped = false
  try {
    if (fingerprintTaskSnapshot(await snapshotProvider()) !== baseline) {
      refuse('scheduler task drift while synthetic children were starting.')
    }
  } catch {
    await holdSyntheticStartup(runtime, plan.householdIds[0])
    refuse('scheduler task identity or state changed during fixture startup; durable hold retained.')
  }
  return Object.freeze({
    snapshot() {
      return Object.freeze({
        ...runtime.snapshot(),
        pinnedDisposableCheckoutChecked: true,
        syntheticSchedulerSnapshotChecked: true,
        realHostTaskOwnershipProven: false,
        installedWindowsSupervisor: false,
        osWideSqliteWriterFenceProven: false,
        authorizedToDeployTest: false,
        authorizedToDeployLive: false,
      })
    },
    async shutdown() {
      if (stopped) refuse('synthetic handoff has already stopped.')
      stopped = true
      try {
        if (fingerprintTaskSnapshot(await snapshotProvider()) !== baseline) {
          refuse('protected scheduler tasks changed before fixture shutdown.')
        }
      } catch {
        await holdSyntheticStartup(runtime, plan.householdIds[0])
        refuse('scheduler task drift at shutdown; manual recovery hold retained.')
      }
      return runtime.shutdown()
    },
    terminateRemainingSyntheticChildrenForTest: () =>
      runtime.terminateRemainingSyntheticChildrenForTest(),
  })
}
