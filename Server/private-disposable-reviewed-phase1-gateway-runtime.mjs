// SOURCE-ONLY DISPOSABLE Phase 1 integration: real calendar backend children,
// private gateway, reviewed supervisor ownership and a real signed Owner login.
//
// This runner REFUSES installed-site data and OS service activation: identity,
// household data and supervisor locks must be under a fresh OS-temp fixture.
// It neither registers Windows tasks, changes HTTPS/portproxy/firewall, nor
// attests OS-wide writer fencing. NEVER use as a TEST or LIVE deployment tool.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { planReviewedPrivateTestStartup } from './private-reviewed-test-startup-plan.mjs'
import { createReviewedWindowsSupervisorOwnership } from './private-reviewed-windows-supervisor-ownership.mjs'
import { startPrivateHouseholdGateway, verifyPrivateBackendBindings } from './private-household-gateway.mjs'
import { resolvePrivatePhase1GatewayLoopbackPort } from './private-household-gateway.mjs'

const PROTECTED = new Set([443, 8443, 3001, 11434, 13001, 13002, 13003])
function refuse(message) {
  throw new Error('Disposable Phase 1 gateway supervisor refused: ' + message)
}
function inside(parent, child) {
  const rel = path.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) &&
    !path.isAbsolute(rel)
}
function physicalDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) ||
      !fs.lstatSync(directory).isDirectory() ||
      fs.lstatSync(directory).isSymbolicLink()) {
    refuse('absolute physical fixture directories are required.')
  }
  return fs.realpathSync(directory)
}
function physicalFile(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) ||
      !fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) {
    refuse('an existing physical central identity SQLite file is required.')
  }
  return fs.realpathSync(filename)
}
function verifiedPaths({ fixtureRoot, storageRoot, stateDirectory, identityDatabasePath,
  serverDirectory }) {
  const temp = physicalDirectory(os.tmpdir())
  const root = physicalDirectory(fixtureRoot)
  const storage = physicalDirectory(storageRoot)
  const state = physicalDirectory(stateDirectory)
  const identity = physicalFile(identityDatabasePath)
  const server = physicalDirectory(serverDirectory)
  const checkout = path.dirname(server)
  if (!inside(temp, root) || !inside(root, storage) || !inside(root, state) ||
      !inside(root, identity) || inside(storage, state) || inside(state, storage) ||
      inside(storage, identity) || inside(state, identity) ||
      !fs.existsSync(path.join(server, 'index.mjs')) ||
      inside(root, checkout) || inside(checkout, root)) {
    refuse('central identity, storage, state and source must be separately contained.')
  }
  // A trusted checkout in the home Projects area may be an installed site.
  // Never spawn from one of these installed LIVE/TEST roots during a fixture.
  const projects = path.join(os.homedir(), 'Projects')
  const blocked = ['family-calendar', 'family-calendar-test',
    'family-calendar-test-security-stage', 'family-calendar-live-auth-candidate']
  if (blocked.some(name => path.resolve(checkout).toLowerCase() ===
      path.resolve(projects, name).toLowerCase())) {
    refuse('installed LIVE/TEST source checkout cannot run this fixture.')
  }
  return { root, storage, state, identity, server, checkout }
}

async function choosePort(used) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const listener = net.createServer()
    let port
    try {
      await new Promise((resolve, reject) => {
        listener.once('error', reject)
        listener.listen(0, '127.0.0.1', resolve)
      })
      port = listener.address().port
    } finally {
      if (listener.listening) {
        await new Promise((resolve, reject) => listener.close(error =>
          error ? reject(error) : resolve()))
      }
    }
    if (port >= 1024 && port <= 65535 && !used.has(port) &&
        !PROTECTED.has(port)) {
      used.add(port)
      return port
    }
  }
  refuse('no distinct private loopback backend port available.')
}
function childEnvironment(storageRoot, householdId, port, token) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^FAMILY_CALENDAR_/i.test(key) &&
    !['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())))
  return {
    ...env,
    FAMILY_CALENDAR_HOST: '127.0.0.1',
    FAMILY_CALENDAR_PORT: String(port),
    FAMILY_CALENDAR_AUTH_MODE: 'disabled',
    FAMILY_CALENDAR_HOUSEHOLD_STORAGE_ROOT: storageRoot,
    FAMILY_CALENDAR_HOUSEHOLD_ID: householdId,
    FAMILY_CALENDAR_HOUSEHOLD_TEST_ONLY: 'YES',
    FAMILY_CALENDAR_PRIVATE_UPSTREAM_TOKEN: token,
  }
}
async function spawnBackend(paths, householdId, port, token, guard) {
  const child = fork(path.join(paths.server, 'index.mjs'), [], {
    cwd: paths.checkout,
    env: childEnvironment(paths.storage, householdId, port, token),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const closed = new Promise(resolve => child.once('close', resolve))
  const backend = { householdId, port, token, child, closed }
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    guard.captureBackend({ householdId, child })
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/api/health', {
          headers: { 'x-family-calendar-upstream-token': token },
          signal: AbortSignal.timeout(1000),
        })
        if (response.status === 200 && (await response.json()).status === 'ok') {
          const direct = await fetch('http://127.0.0.1:' + port + '/api/events', {
            signal: AbortSignal.timeout(1000),
          })
          if (direct.status !== 403) refuse('direct household backend bypass detected.')
          return backend
        }
      } catch {
        // Startup attempts may encounter an unopened listener; never relax
        // the authenticated health, direct-denial or later identity proof.
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    refuse('private household backend did not prove authenticated health.')
  } catch (error) {
    // Let the coordinator explicitly reconcile this captured child; do not
    // auto-delete any writer lock or assume an exit after process.kill().
    error.capturedBackend = backend
    throw error
  }
}
async function stopCaptured(backend) {
  const { child, closed, householdId } = backend
  if (child.exitCode === null && child.signalCode === null) {
    if (!child.connected) refuse('supervised backend IPC disconnected unexpectedly.')
    await new Promise((resolve, reject) => child.send({
      type: 'private-household-test-shutdown', householdId,
    }, error => error ? reject(error) : resolve()))
  }
  let timer
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          'Private child did not confirm exit; manual fixture review required.')), 12000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (child.exitCode !== 0) {
    refuse('private backend did not exit cleanly; retain supervisor lock.')
  }
}

/**
 * Real Node household backend + gateway integration, but only within an
 * independently disposable OS-temp fixture. Exactly the planner's approved
 * primary/invited families are eligible. Never use installed calendar DBs.
 */
export async function launchDisposableReviewedPhase1Gateway({
  fixtureRoot, storageRoot, stateDirectory, identityDatabasePath,
  serverDirectory, primaryHouseholdId, operatorUserIds,
  trustedPhase1GatewayPort = null,
}) {
  const paths = verifiedPaths({
    fixtureRoot, storageRoot, stateDirectory, identityDatabasePath,
    serverDirectory,
  })
  if (!Array.isArray(operatorUserIds) || operatorUserIds.length !== 1 ||
      !Number.isSafeInteger(operatorUserIds[0]) || operatorUserIds[0] < 1) {
    refuse('one independently trusted operator ID must be supplied.')
  }
  const gatewayPort = resolvePrivatePhase1GatewayLoopbackPort({
    port: trustedPhase1GatewayPort, phase1OwnerPilotOnly: true,
  })
  const central = new DatabaseSync(paths.identity)
  let guard = null
  const backends = []
  let gateway = null
  try {
    const plan = planReviewedPrivateTestStartup({
      identityDatabase: central,
      serverDirectory: paths.server, storageRoot: paths.storage,
      stateDirectory: paths.state, primaryHouseholdId,
    })
    guard = createReviewedWindowsSupervisorOwnership({
      plan, stateDirectory: paths.state,
    })
    const used = new Set(PROTECTED)
    if (gatewayPort !== 0) used.add(gatewayPort)
    const backendPorts = {}
    const backendTokens = {}
    for (const householdId of plan.householdIds) {
      const port = await choosePort(used)
      const token = randomBytes(32).toString('hex')
      const backend = await spawnBackend(paths, householdId, port, token, guard)
        .catch(error => {
          if (error.capturedBackend) backends.push(error.capturedBackend)
          throw error
        })
      backends.push(backend)
      backendPorts[householdId] = port
      backendTokens[householdId] = token
    }
    // Recheck tenant identity of EACH real child before central gateway boot.
    await verifyPrivateBackendBindings(
      new Map(Object.entries(backendPorts)),
      new Map(Object.entries(backendTokens)),
    )
    gateway = await startPrivateHouseholdGateway({
      identityDatabase: central, serverDirectory: paths.server,
      storageRoot: paths.storage, backendPorts, backendTokens,
      independentHouseholdAdministratorUserIds: operatorUserIds,
      enforceFamilyMemberPermissions: true,
      phase1OwnerPilotOnly: true,
      trustedPhase1GatewayPort,
      supervisorAdmissionCheck: () => guard.snapshot().phase === 'running' &&
        backends.every(({child}) => child.exitCode === null && child.signalCode === null && child.connected === true),
    })
    guard.markHealthy()
    let shutdownRequested = false
    return Object.freeze({
      base: gateway.base,
      snapshot: () => Object.freeze({
        ...guard.snapshot(),
        householdIds: Object.freeze([...plan.householdIds]),
        gatewayLocalhostOnly: new URL(gateway.base).hostname === '127.0.0.1',
        gatewayPort: gateway.port,
        childPorts: Object.freeze([...Object.values(backendPorts)]),
        realCalendarBackendsStarted: true,
        realGatewayStarted: true,
        supervisorAdmissionOpen: guard.snapshot().phase === 'running' &&
          backends.every(({child}) => child.exitCode === null && child.signalCode === null && child.connected === true),
        osTempFixtureOnly: true,
        testDeploymentAuthorized: false,
        liveDeploymentAuthorized: false,
        osWideWriterFencingVerified: false,
        windowsTaskInstalled: false,
      }),
      // Fault injection is restricted to the captured OS-temp fixture child.
      crashCapturedBackendForTest(householdId) {
        if (shutdownRequested || guard.snapshot().phase !== 'running') refuse('fixture not running.')
        const backend = backends.find(item => item.householdId === householdId)
        if (!backend) refuse('unknown captured fixture child.')
        return backend.child.kill()
      },
      // Explicit fixture-only cleanup after a hold. Never clear supervisor
      // ownership or a crash marker; no automatic restart or rollback.
      async closeHeldFixtureForTest() {
        if (shutdownRequested || guard.snapshot().phase !== 'held') refuse('held fixture required.')
        shutdownRequested = true
        await gateway.close()
        const failures = []
        for (const backend of [...backends].reverse()) {
          try {
            if (backend.child.exitCode !== null || backend.child.signalCode !== null) await backend.closed
            else await stopCaptured(backend)
          } catch (error) { failures.push(error) }
        }
        central.close()
        if (failures.length) throw new AggregateError(failures,'Held fixture cleanup requires review.')
        return Object.freeze({gatewayClosed:true, allCapturedChildrenExited:true,
          ownerInstanceRetained:true, testDeploymentAuthorized:false})
      },
      async shutdown() {
        if (shutdownRequested) refuse('reviewed fixture shutdown already requested.')
        shutdownRequested = true
        guard.beginGracefulShutdown()
        await gateway.close()
        for (const backend of [...backends].reverse()) {
          await stopCaptured(backend)
        }
        guard.finishGracefulShutdown()
        central.close()
        return Object.freeze({
          allChildrenExited: true, gatewayClosed: true,
          ownerInstanceReleased: true, osWideWriterFencingVerified: false,
          testDeploymentAuthorized: false,
        })
      },
    })
  } catch (error) {
    // A failed boot retains the supervisor instance lock. Never automatically
    // re-enable an old service, reclaim a lock or infer safe OS-wide recovery.
    const failures = [error]
    if (gateway) {
      try { await gateway.close() } catch (failure) { failures.push(failure) }
    }
    for (const backend of [...backends].reverse()) {
      try { await stopCaptured(backend) }
      catch (failure) { failures.push(failure) }
    }
    try { central.close() } catch (failure) { failures.push(failure) }
    if (failures.length > 1) {
      throw new AggregateError(failures,
        'Disposable private boot failed; supervised recovery requires operator review.')
    }
    throw error
  }
}
