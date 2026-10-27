import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  createPrivateWindowsSupervisorCrashHold,
  inspectPrivateWindowsSupervisorHold,
} from '../Server/private-windows-supervisor-crash-hold.mjs'

const BASE = ['family-a', 'family-b']
const FRIEND = 'family-' + 'a'.repeat(24)
const script = 'process.on("message", message => { if (message === "close") process.exit(0); if (message === "crash") process.exit(29) }); setInterval(() => {}, 250)'
function startChild() {
  return spawn(process.execPath, ['-e', script], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = once(child, 'exit')
  if (child.connected) child.send('close')
  else child.kill('SIGKILL') // Only this exact disposable test child.
  await done
}
function stateFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-private-supervisor-crash-hold-'))
  return { dir, remove: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('unexpected backend exit creates a durable quarantine and prevents automatic reboot', {
  timeout: 15000,
}, async () => {
  const fixture = stateFixture()
  const a = startChild()
  const b = startChild()
  try {
    const guard = createPrivateWindowsSupervisorCrashHold({
      stateDirectory: fixture.dir, householdIds: BASE,
    })
    guard.attachCapturedBackend({ householdId: 'family-a', child: a })
    guard.attachCapturedBackend({ householdId: 'family-b', child: b })
    guard.markHealthy()
    assert.equal(guard.snapshot().phase, 'running')
    const crashed = once(a, 'exit')
    a.send('crash')
    await crashed
    assert.equal(a.exitCode, 29)
    assert.deepEqual({ ...guard.snapshot() }, {
      phase: 'held', held: true, reason: 'unexpected-exit',
      allCaptured: true, capturedExited: false,
      approvedForAutomaticRecovery: false, taskSchedulerInstalled: false,
    })
    const audit = inspectPrivateWindowsSupervisorHold(fixture.dir)
    assert.equal(audit.held, true)
    assert.equal(audit.automaticRestartAllowed, false)
    assert.throws(() => createPrivateWindowsSupervisorCrashHold({
      stateDirectory: fixture.dir, householdIds: BASE,
    }), /held for operator recovery review/)
    assert.throws(() => guard.beginGracefulShutdown(),
      /cannot replace a crashed/)
    const saved = fs.readFileSync(path.join(fixture.dir,
      '.family-calendar-private-supervisor-REQUIRES-REVIEW.json'), 'utf8')
    const metadata = JSON.parse(saved)
    assert.deepEqual(Object.keys(metadata),
      ['schemaVersion', 'state', 'reason', 'householdId', 'occurredAt'])
    assert.equal(metadata.householdId, 'family-a')
    assert(!saved.includes('token'))
    assert(!saved.includes('pid'))
    assert(!saved.includes('storage'))
  } finally {
    await stopChild(a)
    await stopChild(b)
    fixture.remove()
  }
})

test('clean shutdown waits on captured processes and writes no recovery hold', {
  timeout: 15000,
}, async () => {
  const fixture = stateFixture()
  const children = [startChild(), startChild()]
  try {
    const guard = createPrivateWindowsSupervisorCrashHold({
      stateDirectory: fixture.dir, householdIds: BASE,
    })
    guard.attachCapturedBackend({ householdId: BASE[0], child: children[0] })
    assert.throws(() => guard.markHealthy(), /every captured private backend/)
    guard.attachCapturedBackend({ householdId: BASE[1], child: children[1] })
    guard.markHealthy()
    guard.beginGracefulShutdown()
    await Promise.all(children.map(stopChild))
    const state = guard.snapshot()
    assert.equal(state.phase, 'stopping')
    assert.equal(state.held, false)
    assert.equal(state.capturedExited, true)
    assert.equal(state.approvedForAutomaticRecovery, false)
    assert.equal(inspectPrivateWindowsSupervisorHold(fixture.dir).held, false)
  } finally {
    await Promise.all(children.map(stopChild))
    fixture.remove()
  }
})

test('IPC disconnect without process exit also quarantines writer', {
  timeout: 15000,
}, async () => {
  const fixture = stateFixture()
  const a = startChild()
  const b = startChild()
  try {
    const guard = createPrivateWindowsSupervisorCrashHold({
      stateDirectory: fixture.dir, householdIds: BASE,
    })
    guard.attachCapturedBackend({ householdId: BASE[0], child: a })
    guard.attachCapturedBackend({ householdId: BASE[1], child: b })
    guard.markHealthy()
    const lost = once(a, 'disconnect')
    a.disconnect()
    await lost
    assert.equal(guard.snapshot().phase, 'held')
    assert.equal(guard.snapshot().reason, 'lost-control')
    assert.equal(a.exitCode, null)
    assert.equal(inspectPrivateWindowsSupervisorHold(fixture.dir).held, true)
  } finally {
    await Promise.all([stopChild(a), stopChild(b)])
    fixture.remove()
  }
})

test('corrupt old hold still blocks reboot; untrusted child and identities rejected', {
  timeout: 15000,
}, async () => {
  const fixture = stateFixture()
  const c = startChild()
  try {
    assert.throws(() => createPrivateWindowsSupervisorCrashHold({
      stateDirectory: fixture.dir, householdIds: [...BASE, 'family-pending'],
    }), /reviewed baseline/)
    const guard = createPrivateWindowsSupervisorCrashHold({
      stateDirectory: fixture.dir, householdIds: [...BASE, FRIEND],
    })
    assert.throws(() => guard.attachCapturedBackend({
      householdId: 'family-unapproved', child: c,
    }), /unknown or already-exited/)
    assert.throws(() => guard.attachCapturedBackend({
      householdId: BASE[0], child: { pid: c.pid },
    }), /unknown or already-exited/)
    await stopChild(c)
    fs.writeFileSync(path.join(fixture.dir,
      '.family-calendar-private-supervisor-REQUIRES-REVIEW.json'), '{broken',
      { flag: 'wx' })
    assert.throws(() => createPrivateWindowsSupervisorCrashHold({
      stateDirectory: fixture.dir, householdIds: BASE,
    }), /held for operator/)
  } finally {
    await stopChild(c)
    fixture.remove()
  }
})
