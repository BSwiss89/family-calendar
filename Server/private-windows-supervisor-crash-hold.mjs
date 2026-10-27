// PRIVATE MULTI-HOUSEHOLD PREVIEW ONLY. This is a fail-closed supervision
// primitive, NOT a Windows service, scheduler installer or recovery mechanism.
// Only an explicitly trusted parent may attach captured child process handles.
// A crashed/disconnected writer is quarantined. No automatic restart/unlock.
import fs from 'node:fs'
import path from 'node:path'
import { ChildProcess } from 'node:child_process'

const MARKER = '.family-calendar-private-supervisor-REQUIRES-REVIEW.json'
const GENERATED_ID = /^family-[0-9a-f]{24}$/
const BASE = ['family-a', 'family-b']
const REASONS = new Set(['unexpected-exit', 'lost-control', 'child-error'])

function verifyIds(ids) {
  return Array.isArray(ids) && ids.length >= 2 &&
    ids[0] === BASE[0] && ids[1] === BASE[1] &&
    new Set(ids).size === ids.length &&
    ids.slice(2).every(id => typeof id === 'string' && GENERATED_ID.test(id))
}

function checkedDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new Error('Private supervisor needs an explicit absolute state directory.')
  }
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Private supervisor refused non-directory or symlink state.')
  }
  return fs.realpathSync(directory)
}

// The marker is intentionally separate from backend locks. Even if Windows
// Task Scheduler starts the parent again, a persisted hold refuses startup.
// Existing markers, including truncated/corrupt ones, always block. There is
// deliberately NO exported reset, delete, force or PID-based reclaim method.
export function createPrivateWindowsSupervisorCrashHold({
  stateDirectory, householdIds,
}) {
  if (!verifyIds(householdIds)) {
    throw new Error('Private supervisor requires reviewed baseline and approved household IDs.')
  }
  const root = checkedDirectory(stateDirectory)
  const marker = path.join(root, MARKER)
  if (fs.existsSync(marker)) {
    throw new Error('Private supervisor is held for operator recovery review.')
  }
  const known = new Map()
  let phase = 'starting'
  let failure = null

  function quarantine(reason, householdId) {
    if (!REASONS.has(reason) || !householdIds.includes(householdId)) {
      throw new Error('Invalid supervisor failure report.')
    }
    if (phase === 'stopping' || phase === 'held') return
    phase = 'held'
    failure = { reason, householdId }
    // Enforce durable, exclusive marker creation. Never overwrite a previous
    // hold, and never include upstream tokens, paths, credentials or PIDs.
    if (checkedDirectory(stateDirectory) !== root) {
      throw new Error('Supervisor state boundary changed; startup forbidden.')
    }
    const fd = fs.openSync(marker, 'wx', 0o600)
    try {
      const summary = { schemaVersion: 1, state: 'requires-operator-review',
        reason, householdId, occurredAt: new Date().toISOString() }
      fs.writeFileSync(fd, JSON.stringify(summary) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  function attachCapturedBackend({ householdId, child }) {
    if (phase !== 'starting' || !householdIds.includes(householdId) ||
        known.has(householdId) || !(child instanceof ChildProcess) ||
        !Number.isSafeInteger(child.pid) || child.pid < 1 ||
        child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Private supervisor refused unknown or already-exited child handle.')
    }
    const entry = { child, exited: false }
    known.set(householdId, entry)
    child.once('exit', () => {
      entry.exited = true
      if (phase !== 'stopping') quarantine('unexpected-exit', householdId)
    })
    // Loss of the supervised IPC channel is not proof of child exit.
    // Refuse automated restart even if the process later reports an exit.
    child.once('disconnect', () => {
      if (phase !== 'stopping') quarantine('lost-control', householdId)
    })
    child.once('error', () => {
      if (phase !== 'stopping') quarantine('child-error', householdId)
    })
  }

  function markHealthy() {
    if (phase !== 'starting' || known.size !== householdIds.length ||
        [...known.values()].some(entry => entry.exited) || fs.existsSync(marker)) {
      throw new Error('Cannot publish gateway before every captured private backend is healthy.')
    }
    phase = 'running'
  }

  function beginGracefulShutdown() {
    if (phase !== 'running' && phase !== 'starting') {
      throw new Error('Private supervisor cannot replace a crashed or already-stopping writer.')
    }
    phase = 'stopping'
  }

  function snapshot() {
    return Object.freeze({
      phase, held: phase === 'held' || fs.existsSync(marker),
      reason: failure?.reason ?? null,
      allCaptured: known.size === householdIds.length,
      capturedExited: [...known.values()].every(entry => entry.exited),
      // Even clean exits DO NOT establish OS-wide writer fencing; the
      // separately verified lock/port checks from PR #96 remain required.
      approvedForAutomaticRecovery: false,
      taskSchedulerInstalled: false,
    })
  }

  return Object.freeze({
    attachCapturedBackend, markHealthy, beginGracefulShutdown, snapshot,
  })
}

export function inspectPrivateWindowsSupervisorHold(stateDirectory) {
  const root = checkedDirectory(stateDirectory)
  const marker = path.join(root, MARKER)
  return { held: fs.existsSync(marker), requiresOperatorReview: fs.existsSync(marker),
    automaticUnlockAllowed: false, automaticRestartAllowed: false }
}
