// Review-only disposable Windows-style supervisor integration exercise.
// Real Node child processes + loopback HTTP health, but ALWAYS OS-temp fixtures.
// This IS NOT the calendar backend, Task Scheduler launcher, public gateway,
// or production writer-fencing proof. No automatic recovery or lock clearing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  createReviewedWindowsSupervisorOwnership,
} from './private-reviewed-windows-supervisor-ownership.mjs'

const WORKER = fileURLToPath(new URL('./private-disposable-supervisor-health-worker.mjs', import.meta.url))
const BLOCKED = new Set([443, 8443, 3001, 11434, 13001, 13002, 13003])

function refuse(reason) {
  throw new Error('Disposable supervised startup refused: ' + reason)
}

function fixturePaths(fixtureRoot, stateDirectory) {
  if (!path.isAbsolute(fixtureRoot ?? '') || !path.isAbsolute(stateDirectory ?? '')) {
    refuse('absolute fixture and state directories are required.')
  }
  const temp = fs.realpathSync(os.tmpdir())
  const root = fs.realpathSync(fixtureRoot)
  const state = fs.realpathSync(stateDirectory)
  for (const p of [fixtureRoot, stateDirectory]) {
    if (!fs.lstatSync(p).isDirectory() || fs.lstatSync(p).isSymbolicLink()) {
      refuse('fixture roots must be physical directories, not links.')
    }
  }
  const inDirectory = (base, child) => {
    const rel = path.relative(base, child)
    return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) &&
      !path.isAbsolute(rel)
  }
  if (!inDirectory(temp, root) || !inDirectory(root, state)) {
    refuse('only nested OS-temp fixtures are allowed; installed sites are forbidden.')
  }
  return { root, state }
}

async function spawnSyntheticWorker(householdId, token, root) {
  const child = fork(WORKER, [], {
    cwd: root,
    env: {
      ...process.env,
      FC_DISPOSABLE_HOUSEHOLD_ID: householdId,
      FC_DISPOSABLE_HEALTH_TOKEN: token,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  })
  // The close event (rather than only exit) must finish before deleting the
  // worker's current directory on Windows, or rmSync can fail with EPERM.
  const closed = new Promise(resolve => child.once('close', resolve))
  // Subscribe to the actual child message immediately, before it can report
  // ready, and verify the exact reviewed family identity and a safe port.
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('Synthetic loopback startup timed out.')), 8000)
    function done(error, value) {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
      child.off('error', onError)
      if (error) reject(error)
      else resolve(value)
    }
    function onMessage(message) {
      if (message?.kind !== 'ready' || message.householdId !== householdId ||
          !Number.isSafeInteger(message.port) ||
          message.port < 1024 || message.port > 65535 || BLOCKED.has(message.port)) {
        done(new Error('Synthetic worker announced a foreign or reserved endpoint.'))
        return
      }
      done(null, message.port)
    }
    function onExit() { done(new Error('Synthetic worker exited before reporting ready.')) }
    function onError(error) { done(error) }
    child.once('message', onMessage)
    child.once('exit', onExit)
    child.once('error', onError)
  })
  // Attach a catch now so an early process/spawn error cannot cause unhandled
  // rejection while we await the Node 'spawn' event below.
  ready.catch(() => {})
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
  } catch (error) {
    child.kill()
    throw error
  }
  return { child, ready, closed }
}

async function probeAuthorizedLoopback(port, householdId, token) {
  await new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1', port, path: '/health', timeout: 3000,
      headers: { 'x-disposable-health-token': token },
      agent: false,
    }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', part => {
        body += part
        if (body.length > 2048) req.destroy(new Error('Health response is too large.'))
      })
      res.on('end', () => {
        try {
          const payload = JSON.parse(body)
          if (res.statusCode !== 200 || payload.healthy !== true ||
              payload.householdId !== householdId) {
            reject(new Error('Synthetic worker health identity mismatch.'))
          } else resolve()
        } catch {
          reject(new Error('Synthetic worker health endpoint was invalid.'))
        }
      })
      res.once('error', reject)
    })
    req.once('error', reject)
    req.once('timeout', () => req.destroy(new Error('Health probe timed out.')))
  })
}

async function stopSyntheticWorker(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Synthetic worker did not exit.')), 6000)
    function finish(error) {
      clearTimeout(timeout)
      child.off('exit', onExit)
      child.off('error', onError)
      if (error) reject(error)
      else resolve()
    }
    function onExit() { finish() }
    function onError(error) { finish(error) }
    child.once('exit', onExit)
    child.once('error', onError)
    try {
      if (!child.connected) throw new Error('Synthetic IPC channel was lost.')
      child.send({ kind: 'stop' }, error => { if (error) finish(error) })
    } catch (error) { finish(error) }
  })
}

/**
 * Executes the previously reviewed ownership primitive with real OS child
 * processes, exact household IDs and authenticated loopback health checks.
 * No interaction with LIVE/TEST, registry, services or production databases.
 * Failures deliberately preserve the owner lock and require operator review.
 */
export async function launchDisposableReviewedWindowsHouseholds({
  plan, fixtureRoot, stateDirectory,
}) {
  const { root, state } = fixturePaths(fixtureRoot, stateDirectory)
  const guard = createReviewedWindowsSupervisorOwnership({
    plan, stateDirectory: state,
  })
  const children = []
  const ports = new Map()
  const tokens = new Map()
  try {
    for (const householdId of plan.householdIds) {
      const token = randomBytes(32).toString('hex')
      const { child, ready, closed } = await spawnSyntheticWorker(householdId, token, root)
      children.push({ householdId, child, closed })
      // Capture the actual OS handle before declaring it healthy.
      guard.captureBackend({ householdId, child })
      const port = await ready
      if ([...ports.values()].includes(port)) refuse('duplicate loopback listener.')
      await probeAuthorizedLoopback(port, householdId, token)
      ports.set(householdId, port)
      tokens.set(householdId, token)
    }
    guard.markHealthy()
  } catch (error) {
    // The uncompleted reviewed instance lock is intentionally NOT released.
    // Stopping only our own fixture processes does not prove all OS writers
    // are fenced and never authorizes unattended startup.
    await Promise.allSettled(children.map(async ({ child, closed }) => {
      try { await stopSyntheticWorker(child) }
      catch { if (child.exitCode === null && child.signalCode === null) child.kill() }
      await closed
    }))
    throw error
  }

  let shutdownStarted = false
  return Object.freeze({
    snapshot: () => Object.freeze({
      ...guard.snapshot(),
      householdIds: Object.freeze([...ports.keys()]),
      actualChildHandlesCaptured: children.length === plan.householdIds.length,
      authenticatedLoopbackHealthChecked: true,
      usesOnlyOsTempFixture: true,
      windowsTaskInstalled: false,
      allOsWritersFenced: false,
      safeToDeployTest: false,
    }),
    async shutdown() {
      if (shutdownStarted) refuse('shutdown already requested.')
      guard.beginGracefulShutdown()
      shutdownStarted = true
      await Promise.all(children.map(({ child }) => stopSyntheticWorker(child)))
      guard.finishGracefulShutdown()
      return Object.freeze({
        supervisedChildrenExited: true,
        instanceReleasedByOwner: true,
        allOsWritersFenced: false,
        safeToDeployTest: false,
      })
    },
    // Test-only fault injection: never expose arbitrary PID or port killing.
    crashSyntheticHouseholdForTest(householdId) {
      const item = children.find(x => x.householdId === householdId)
      if (!item) refuse('foreign fixture child cannot be terminated.')
      return item.child.kill()
    },
    // Purely for fixture test cleanup; never interpret as permission to
    // automatically clear a durable owner lock.
    async terminateRemainingSyntheticChildrenForTest() {
      // Tests never remove a synthetic directory while a child still holds it
      // as its cwd. This is deliberately NOT an automatic production unlock.
      await Promise.all(children.map(async ({ child, closed }) => {
        try { await stopSyntheticWorker(child) }
        catch { if (child.exitCode === null && child.signalCode === null) child.kill() }
        await closed
      }))
    },
  })
}
