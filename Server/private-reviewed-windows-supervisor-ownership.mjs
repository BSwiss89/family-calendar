// REVIEWED MULTIFAMILY TEST STARTUP — LOCAL SUPERVISOR OWNERSHIP PRIMITIVE.
// A future operator-approved Windows host may call this after the read-only
// planner, but this module DOES NOT register tasks, launch/kill processes,
// expose a gateway, acquire a backup, deploy code or clear orphaned locks.
// CI runs it solely against disposable OS-temp child processes and directories.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { ChildProcess } from 'node:child_process'

const INSTANCE = '.family-calendar-reviewed-supervisor-instance.lock'
const HOLD = '.family-calendar-private-supervisor-REQUIRES-REVIEW.json'
const PRIMARY_ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const FRIEND_ID = /^family-[a-f0-9]{24}$/

function refuse(message) {
  throw new Error('Reviewed Windows supervisor refused: ' + message)
}

function checkStateDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    refuse('an explicit absolute supervisor-state folder is required.')
  }
  const stat = fs.lstatSync(value)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    refuse('supervisor state must be a physical directory, not a link.')
  }
  return fs.realpathSync(value)
}

function approvedPlan(plan) {
  const ids = plan?.householdIds
  if (plan?.kind !== 'reviewed-private-test-startup-plan-v1' ||
      plan.planVerifiedReadOnly !== true ||
      plan.deploymentAuthorized !== false ||
      plan.taskSchedulerInstalled !== false ||
      !Object.isFrozen(plan) ||
      !Array.isArray(ids) || !Object.isFrozen(ids) ||
      ids.length < 1 || ids.length > 1000 ||
      plan.householdCount !== ids.length ||
      plan.primaryHouseholdId !== ids[0] ||
      !PRIMARY_ID.test(ids[0]) ||
      ids[0] === 'family-a' || ids[0] === 'family-b' ||
      FRIEND_ID.test(ids[0]) ||
      new Set(ids).size !== ids.length ||
      ids.slice(1).some(id => typeof id !== 'string' || !FRIEND_ID.test(id))) {
    refuse('reviewed non-demo primary and approved invited household plan is required.')
  }
  return ids
}

function isExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

/**
 * Reserve one durable local instance file BEFORE any family child is launched.
 * An abrupt parent termination deliberately leaves the file behind: boot must
 * refuse until an independent, offline operator confirms all OS writers are
 * fenced. NEVER auto-clear based on age/PID/port probes or reboot.
 *
 * Only exact child handles supplied by the trusted caller can be supervised.
 * The owner does not infer other OS processes or guarantee exclusive SQLite
 * writers. Real Windows Task Scheduler installation requires separate review.
 */
export function createReviewedWindowsSupervisorOwnership({ plan, stateDirectory }) {
  const ids = approvedPlan(plan)
  const root = checkStateDirectory(stateDirectory)
  const marker = path.join(root, HOLD)
  const instance = path.join(root, INSTANCE)
  if (fs.existsSync(marker) || fs.existsSync(instance)) {
    refuse('persistent crash hold or existing supervisor instance requires manual review.')
  }
  const nonce = randomBytes(32).toString('hex')
  const owner = JSON.stringify({
    schemaVersion: 1,
    type: 'reviewed-multifamily-supervisor-instance',
    nonce, pid: process.pid, startedAt: new Date().toISOString(),
    householdCount: ids.length,
  }) + '\n'
  // 'wx' atomically refuses another instance. Persist before child startup.
  const fd = fs.openSync(instance, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, owner)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }

  let phase = 'starting'
  let failureReason = null
  const captured = new Map()

  function checkOwnership() {
    if (checkStateDirectory(stateDirectory) !== root ||
        !fs.existsSync(instance) || fs.lstatSync(instance).isSymbolicLink() ||
        fs.readFileSync(instance, 'utf8') !== owner) {
      refuse('instance ownership changed; only manual recovery is permitted.')
    }
  }

  function hold(reason, householdId) {
    if (phase === 'held' || phase === 'stopping' || phase === 'stopped') return
    phase = 'held'
    failureReason = reason
    // Attempt durable write; if this fails, the unchanged instance lock still
    // blocks a later automatic boot. Never unlink a prior hold or instance.
    checkOwnership()
    const h = fs.openSync(marker, 'wx', 0o600)
    try {
      fs.writeFileSync(h, JSON.stringify({
        schemaVersion: 1, state: 'requires-operator-review',
        reason, householdId, at: new Date().toISOString(),
      }) + '\n')
      fs.fsyncSync(h)
    } finally { fs.closeSync(h) }
  }

  function captureBackend({ householdId, child }) {
    if (phase !== 'starting' || !ids.includes(householdId) ||
        captured.has(householdId) || !(child instanceof ChildProcess) ||
        !Number.isSafeInteger(child.pid) || child.pid <= 0 ||
        isExited(child) || child.connected !== true ||
        fs.existsSync(marker)) {
      refuse('unrecognized, disconnected, duplicate or already-exited child.')
    }
    checkOwnership()
    const item = { child, exited: false }
    captured.set(householdId, item)
    child.once('exit', () => {
      item.exited = true
      hold('unexpected-child-exit', householdId)
    })
    child.once('disconnect', () => {
      hold('supervisor-ipc-disconnect', householdId)
    })
    child.once('error', () => {
      hold('supervised-child-error', householdId)
    })
  }

  function markHealthy() {
    if (phase !== 'starting' || captured.size !== ids.length ||
        ids.some(id => {
          const entry = captured.get(id)
          return !entry || entry.exited || isExited(entry.child) ||
            entry.child.connected !== true
        }) ||
        fs.existsSync(marker)) {
      refuse('every approved backend must be captured, connected and healthy.')
    }
    checkOwnership()
    // The caller must independently confirm each upstream health/binding.
    // This transition only attests to process handles, never HTTP health.
    phase = 'running'
  }

  function beginGracefulShutdown() {
    if (phase !== 'running' || fs.existsSync(marker)) {
      refuse('graceful stop cannot replace crash recovery or incomplete startup.')
    }
    checkOwnership()
    phase = 'stopping'
  }

  // EXCLUSIVE OFFLINE CAPTURE WINDOW, disposable fixtures only.
  // Keep this owner's durable instance lock in place across snapshot copy:
  // no competing supervised start or graceful release can occur while copying.
  // A failed/abandoned capture intentionally remains locked for manual review.
  function beginDisposableOfflineCapture(householdIds) {
    if (phase !== 'stopping' || fs.existsSync(marker) ||
        !Array.isArray(householdIds) ||
        JSON.stringify(householdIds) !== JSON.stringify(ids) ||
        captured.size !== ids.length ||
        ids.some(id => !captured.get(id)?.exited ||
          !isExited(captured.get(id).child))) {
      refuse('all reviewed child exits and exact household scope are required before offline capture.')
    }
    checkOwnership()
    phase = 'capturing'
    return Object.freeze({
      exclusiveSupervisorInstanceHeld: true,
      capturedChildrenExited: true,
      osWideWriterFencingVerified: false,
      productionBackupAuthorized: false,
    })
  }

  function completeDisposableOfflineCapture() {
    if (phase !== 'capturing' || fs.existsSync(marker)) {
      refuse('only an active reviewed offline capture can be completed.')
    }
    checkOwnership()
    phase = 'stopping'
    return Object.freeze({
      captureWindowClosed: true,
      supervisorInstanceStillHeld: true,
      productionBackupAuthorized: false,
    })
  }

  function finishGracefulShutdown() {
    if (phase !== 'stopping' || fs.existsSync(marker) ||
        captured.size !== ids.length ||
        ids.some(id => !captured.get(id)?.exited ||
          !isExited(captured.get(id).child))) {
      refuse('supervised child exits must be confirmed before releasing ownership.')
    }
    checkOwnership()
    // The caller must separately verify gateway closed, network listeners,
    // SQLite handles and all writer locks. This is not OS-wide fencing.
    fs.unlinkSync(instance)
    phase = 'stopped'
    return Object.freeze({
      capturedChildExitsConfirmed: true,
      instanceReleasedByOwner: true,
      osWideWriterFencingVerified: false,
      deploymentAuthorized: false,
    })
  }

  function snapshot() {
    return Object.freeze({
      phase, householdCount: ids.length, capturedCount: captured.size,
      allCapturedChildrenExited: captured.size === ids.length &&
        [...captured.values()].every(item => item.exited && isExited(item.child)),
      durableHoldPresent: fs.existsSync(marker),
      failureReason, automaticRestartAllowed: false,
      taskSchedulerInstalled: false, deploymentAuthorized: false,
    })
  }
  return Object.freeze({
    captureBackend, markHealthy, beginGracefulShutdown,
    beginDisposableOfflineCapture, completeDisposableOfflineCapture,
    finishGracefulShutdown, snapshot,
  })
}

/** Read-only. Missing/corrupt instance/hold contents never authorize cleanup. */
export function inspectReviewedWindowsSupervisorOwnership(stateDirectory) {
  const root = checkStateDirectory(stateDirectory)
  return Object.freeze({
    instanceLockPresent: fs.existsSync(path.join(root, INSTANCE)),
    crashHoldPresent: fs.existsSync(path.join(root, HOLD)),
    mayAutomaticallyRemoveLocks: false,
    mayAutomaticallyRestart: false,
    deploymentAuthorized: false,
  })
}
