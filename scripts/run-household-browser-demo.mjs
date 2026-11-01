// Disposable, localhost-only, two-family BROWSER demo for draft PR #46.
// No changes to live/test/preview SQLite or Tailscale configuration.
// Never use this process as a public production gateway.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startPrivateHouseholdGateway } from '../Server/private-household-gateway.mjs'
import { createPrivateWindowsSupervisorCrashHold } from '../Server/private-windows-supervisor-crash-hold.mjs'
import {
  planApprovedPrivateHouseholdStartup, assertPrivateStartupLocksClear,
  launchApprovedPrivateHouseholdBackends,
} from '../Server/private-approved-household-startup.mjs'
import { assertDisposableSupervisedWritersStopped } from '../Server/private-supervised-writer-quiescence.mjs'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'
import {
  createHouseholdMembershipTables,
  registerHousehold,
  grantHouseholdMembership,
} from '../Server/household-memberships.mjs'
import { setFamilyAccount } from '../Server/family-auth.mjs'
import {
  createEventShareTables,
  registerTrustedShareConnection,
} from '../Server/event-only-shares.mjs'

const filePath = fileURLToPath(import.meta.url)
const checkout = path.resolve(path.dirname(filePath), '..')
const serverDirectory = path.join(checkout, 'Server')
const entry = path.join(serverDirectory, 'index.mjs')
const forbiddenPorts = new Set([3001, 13001, 13002, 13003, 11434, 443, 8443])

function localDateKey(daysAhead) {
  const date = new Date()
  date.setHours(12, 0, 0, 0)
  date.setDate(date.getDate() + daysAhead)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

async function chooseFreeLoopbackPort(used) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const listener = createServer()
    const port = await new Promise((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', () => resolve(listener.address().port))
    })
    await new Promise((resolve, reject) =>
      listener.close(error => error ? reject(error) : resolve()))
    if (port >= 1024 && !forbiddenPorts.has(port) && !used.has(port)) {
      used.add(port)
      return port
    }
  }
  throw new Error('Could not allocate distinct non-production ports.')
}

function startHouseholdBackend(storageRoot, householdId, port, serviceToken) {
  const child = spawn(process.execPath, [entry], {
    cwd: checkout,
    windowsHide: true,
    env: {
      ...process.env,
      FAMILY_CALENDAR_HOST: '127.0.0.1',
      FAMILY_CALENDAR_PORT: String(port),
      FAMILY_CALENDAR_AUTH_MODE: 'disabled',
      FAMILY_CALENDAR_HOUSEHOLD_STORAGE_ROOT: storageRoot,
      FAMILY_CALENDAR_HOUSEHOLD_ID: householdId,
      FAMILY_CALENDAR_HOUSEHOLD_TEST_ONLY: 'YES',
      FAMILY_CALENDAR_PRIVATE_UPSTREAM_TOKEN: serviceToken,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let logs = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', bytes => {
      logs = (logs + bytes.toString('utf8')).slice(-6000)
    })
  }
  return {
    child,
    householdId,
    base: 'http://127.0.0.1:' + port,
    serviceToken,
    logs: () => logs,
  }
}

async function awaitHealthy(backend) {
  let lastProbe = 'no HTTP response yet'
  for (let attempt = 0; attempt < 60; attempt++) {
    if (backend.child.exitCode !== null || backend.child.signalCode !== null) break
    try {
      const response = await fetch(backend.base + '/api/health', {
        headers: { 'x-family-calendar-upstream-token': backend.serviceToken },
        signal: AbortSignal.timeout(1200),
      })
      lastProbe = 'HTTP ' + response.status
      if (response.ok && (await response.json()).status === 'ok') return
    } catch (error) {
      // Only report the error TYPE, never capability tokens or request headers.
      lastProbe = error?.name === 'TimeoutError' ? 'health timeout'
        : error?.cause?.code === 'ECONNREFUSED' ? 'connection refused'
          : 'health unavailable'
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  const child = backend.child
  throw new Error(
    'Disposable ' + backend.householdId +
    ' backend failed to start (exitCode=' + String(child.exitCode) +
    ', signalCode=' + String(child.signalCode) +
    ', ipcConnected=' + String(child.connected) +
    ', lastHealth=' + lastProbe + '): ' + backend.logs(),
  )
}

// A disconnected IPC channel is NOT evidence that a process has exited.
// Wait for the exact captured child handle; never kill or reclaim a writer
// lock automatically, even when a disposable browser-demo startup fails.
function waitForConfirmedChildExit(child, timeoutMs) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
    let settled = false
    let timeout
    function finish(exited) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.off('exit', onExit)
      child.off('error', onError)
      resolve(exited)
    }
    function onExit() { finish(true) }
    function onError() { finish(false) }
    child.once('exit', onExit)
    child.once('error', onError)
    timeout = setTimeout(() => finish(false), timeoutMs)
  })
}

export async function stopDisposableHouseholdBackend(backend) {
  const child = backend.child
  if (child.exitCode !== null || child.signalCode !== null) return
  const wasConnected = child.connected
  if (wasConnected) {
    // send() can race against the child's voluntary IPC disconnect.
    // Its callback absorbs channel errors; exit confirmation is still required.
    try {
      child.send({ type: 'private-household-test-shutdown',
        householdId: backend.householdId }, () => {})
    } catch {
      // Do not treat a failed IPC send as a successful process shutdown.
    }
  }
  const stopped = await waitForConfirmedChildExit(child, wasConnected ? 6000 : 1500)
  if (!stopped) {
    throw new Error('Disposable backend shutdown unverified (process still alive or exit unknown): ' +
      backend.householdId)
  }
}

async function seedEvent(base, event, serviceToken) {
  const response = await fetch(base + '/api/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-family-calendar-upstream-token': serviceToken,
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(6000),
  })
  if (response.status !== 201) {
    throw new Error('Disposable demo event setup failed: ' + response.status)
  }
  const created = await response.json()
  assert(Number.isSafeInteger(created.id) && created.id > 0)
  return created.id
}

/**
 * Each call provisions two empty, synthetic household databases, two
 * independent account passwords, and private localhost backend processes.
 * The gateway and all child ports listen on 127.0.0.1 ONLY.
 *
 * Returns close() to stop the three servers and erase ONLY the unique temp
 * fixture created for this specific invocation.
 */
export async function startHouseholdBrowserDemo({ enableIndependentHouseholdInvitations = false } = {}) {
  if (!fs.existsSync(path.join(checkout, 'dist', 'index.html'))) {
    throw new Error('Build this draft PR in the isolated preview checkout first.')
  }
  // No optional filesystem argument and no automatic use of live/test/preview.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'family-calendar-browser-demo-'))
  const storageRoot = path.join(root, 'storage')
  fs.mkdirSync(storageRoot, { mode: 0o700 })
  const central = new DatabaseSync(path.join(root, 'identity.db'))
  const stateDirectory = path.join(root, 'private-supervisor-state')
  fs.mkdirSync(stateDirectory, { mode: 0o700 })
  const backends = []
  let gateway = null
  let restartedSupervisor = null
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    const errors = []
    if (restartedSupervisor?.snapshot().phase === 'running') {
      try { restartedSupervisor.beginGracefulShutdown() }
      catch (error) { errors.push(error) }
    }
    if (gateway) {
      try { await gateway.close() } catch (error) { errors.push(error) }
    }
    for (const backend of backends) {
      try { await stopDisposableHouseholdBackend(backend) } catch (error) { errors.push(error) }
    }
    try { central.close() } catch (error) { errors.push(error) }
    // Before deleting disposable SQLite and uploads, ensure BOTH captured
    // child handles have exited and no gateway/backend loopback port remains
    // occupied. A different process that reused a port also blocks cleanup.
    if (errors.length === 0 && gateway && backends.length >= 2) {
      try {
        await assertDisposableSupervisedWritersStopped({
          backends,
          backendPorts: Object.fromEntries(backends.map(b => [
            b.householdId, Number(new URL(b.base).port),
          ])),
          gatewayPort: gateway.port,
          gatewayClosed: true,
          expectedHouseholdIds: backends.map(b => b.householdId),
        })
      } catch (error) { errors.push(error) }
    }
    if (errors.length === 0 && backends.length >= 2) {
      for (const backend of backends) {
        const lock = path.join(storageRoot, 'households', backend.householdId,
          '.family-calendar-private-backend-writer.lock')
        if (fs.existsSync(lock)) {
          errors.push(new Error('Disposable backend writer lock survived clean shutdown: ' +
            backend.householdId))
        }
      }
    }
    if (errors.length === 0) {
      fs.rmSync(root, { recursive: true, force: true })
    } else {
      throw new AggregateError(errors, 'Failed to stop disposable browser demo safely.')
    }
  }

  try {
    provisionEmptyHousehold({
      serverDirectory, storageRoot, householdId: 'family-a',
    })
    provisionEmptyHousehold({
      serverDirectory, storageRoot, householdId: 'family-b',
    })
    createHouseholdMembershipTables(central)
    createEventShareTables(central)

    registerHousehold(central, {
      householdId: 'family-a', displayName: 'Demo Family A',
    })
    registerHousehold(central, {
      householdId: 'family-b', displayName: 'Demo Family B',
    })
    // Distinct personal users share Family A's calendar by explicit
    // membership; its hub has a separate authenticated identity.
    const accounts = [
      { username: 'demo-family-a', displayName: 'Family A Member One',
        householdId: 'family-a', accountKind: 'person', role: 'owner' },
      { username: 'demo-family-b', displayName: 'Family B Member',
        householdId: 'family-b', accountKind: 'person', role: 'owner' },
      { username: 'demo-family-a-member', displayName: 'Family A Member Two',
        householdId: 'family-a', accountKind: 'person', role: 'member' },
      { username: 'demo-family-a-hub', displayName: 'Family A Hub',
        householdId: 'family-a', accountKind: 'hub', role: 'member' },
    ].map(account => ({
      ...account,
      password: 'Demo-' + randomBytes(20).toString('base64url'),
    }))
    for (const account of accounts) {
      setFamilyAccount(central, account.username, account.displayName,
        account.password, { accountKind: account.accountKind })
      const row = central.prepare(
        'SELECT id FROM family_users WHERE username = ?'
      ).get(account.username)
      grantHouseholdMembership(central, {
        serverVerifiedUserId: row.id,
        householdId: account.householdId,
        role: account.role,
      })
    }
    // Both families are preapproved contacts, but NO events are pre-shared.
    // Users must select exactly which events to invite.
    registerTrustedShareConnection(central, {
      sourceHouseholdId: 'family-a', recipientHouseholdId: 'family-b',
    })
    registerTrustedShareConnection(central, {
      sourceHouseholdId: 'family-b', recipientHouseholdId: 'family-a',
    })

    const used = new Set()
    const ports = {
      'family-a': await chooseFreeLoopbackPort(used),
      'family-b': await chooseFreeLoopbackPort(used),
    }
    const backendTokens = {
      'family-a': randomBytes(32).toString('hex'),
      'family-b': randomBytes(32).toString('hex'),
    }
    for (const householdId of ['family-a', 'family-b']) {
      backends.push(startHouseholdBackend(
        storageRoot, householdId, ports[householdId],
        backendTokens[householdId],
      ))
    }
    await Promise.all(backends.map(awaitHealthy))

    const sharedCandidateDate = localDateKey(2)
    const privateEventDate = localDateKey(3)
    const sourceId = await seedEvent(backends[0].base, {
      date: sharedCandidateDate,
      title: 'DEMO A — BBQ to share',
      time: '17:00',
      notes: 'Demo A private notes: must not be sent to Family B.',
    }, backendTokens['family-a'])
    await seedEvent(backends[0].base, {
      date: privateEventDate,
      title: 'DEMO A — PRIVATE appointment',
      time: '09:00',
      notes: 'Demo A confidential details.',
    }, backendTokens['family-a'])
    await seedEvent(backends[1].base, {
      date: privateEventDate,
      title: 'DEMO B — PRIVATE family event',
      time: '11:00',
      notes: 'Demo B confidential details.',
    }, backendTokens['family-b'])

    const launchTrustedGateway = () => startPrivateHouseholdGateway({
      identityDatabase: central,
      serverDirectory,
      storageRoot,
      backendPorts: ports,
      backendTokens,
      independentHouseholdAdministratorUserIds: enableIndependentHouseholdInvitations
        ? [central.prepare('SELECT id FROM family_users WHERE username = ?')
          .get(accounts[0].username).id]
        : [],
    })
    gateway = await launchTrustedGateway()
    // The gateway itself must never be directly reachable on a Tailscale or
    // LAN adapter. HTTPS for browser auth will be Tailscale Serve only.
    const url = new URL(gateway.base)
    assert.equal(url.hostname, '127.0.0.1')
    assert(!forbiddenPorts.has(gateway.port))
    const unauth = await fetch(gateway.base + '/api/events', {
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
    })
    assert.equal(unauth.status, 401)
    const check = await fetch(gateway.base + '/api/health', {
      signal: AbortSignal.timeout(6000),
    })
    assert.equal((await check.json()).status, 'ok')

    // Test-only supervisor hook. Launches a brand-new pre-provisioned family
    // backend but NEVER enrolls it automatically. No browser route for this.
    async function startPendingHouseholdBackend(householdId) {
      if (closed) throw new Error('Disposable demo is closed.')
      if (backends.some(b => b.householdId === householdId)) {
        throw new Error('Household backend is already started.')
      }
      const present = central.prepare([
        'SELECT h.id FROM household_registry h',
        'JOIN independent_household_invitations i ON i.household_id = h.id',
        'WHERE h.storage_id = ? AND i.redeemed_at IS NOT NULL',
      ].join(' ')).get(householdId)
      if (!present) throw new Error('Unknown independent household.')
      const port = await chooseFreeLoopbackPort(used)
      const upstreamToken = randomBytes(32).toString('hex')
      const backend = startHouseholdBackend(storageRoot, householdId, port, upstreamToken)
      backends.push(backend)
      await awaitHealthy(backend)
      return { householdId, port, upstreamToken }
    }

    // Simulates an ENTIRE supervised backend + gateway restart while keeping
    // synthetic SQLite and signed-in sessions. Only CENTRAL approved household
    // IDs are restarted; fresh unguessable backend credentials and different
    // reserved test ports are used. An unactivated signup is never started.
    async function restartApprovedBackendsAndGateway() {
      if (closed || !gateway) throw new Error('Disposable gateway is unavailable.')
      // PREPARE: only the two explicit fixture baselines plus CENTRAL
      // approved invited-family IDs may enter the supervisor restart plan.
      // Complete all trust/disk checks before closing a healthy gateway.
      const plan = planApprovedPrivateHouseholdStartup({
        identityDatabase: central, serverDirectory, storageRoot,
      })
      const expected = [...plan.householdIds]
      assert.deepEqual(Object.keys(ports).sort(), [...expected].sort(),
        'Trusted restart refused unapproved or missing household backend.')
      assert.deepEqual(backends.map(b => b.householdId).sort(), [...expected].sort(),
        'Trusted restart refused untracked or pending backend process.')

      const lastTokens = { ...backendTokens }
      const oldGatewayPort = gateway.port
      const oldBackendPorts = { ...ports }
      const oldBackends = [...backends]
      if (restartedSupervisor?.snapshot().held) {
        throw new Error('Private supervisor crash hold blocks automatic restart.')
      }
      if (restartedSupervisor?.snapshot().phase === 'running') {
        restartedSupervisor.beginGracefulShutdown()
      }
      await gateway.close()
      gateway = null
      for (const backend of oldBackends) {
        await stopDisposableHouseholdBackend(backend)
      }
      // Prove exactly the captured handles exited and every old service port
      // is closed. No PID/time-based lock reclaim or guessed cleanup.
      await assertDisposableSupervisedWritersStopped({
        backends: oldBackends, backendPorts: oldBackendPorts,
        gatewayPort: oldGatewayPort, gatewayClosed: true,
        expectedHouseholdIds: expected,
      })
      assertPrivateStartupLocksClear({
        serverDirectory, storageRoot, householdIds: expected,
      })
      // START: rotate secrets and ports; never start a gateway after a
      // failed child/health check. Only our captured children may be stopped.
      const replacement = await launchApprovedPrivateHouseholdBackends({
        plan, usedPorts: used, allocateLoopbackPort: chooseFreeLoopbackPort,
        launchBackend: ({ householdId, port, upstreamToken }) =>
          startHouseholdBackend(storageRoot, householdId, port, upstreamToken),
        awaitHealthyBackend: awaitHealthy,
        stopBackend: stopDisposableHouseholdBackend,
        previousTokens: lastTokens,
      })
      backends.splice(0, backends.length, ...replacement.backends)
      for (const id of Object.keys(ports)) delete ports[id]
      for (const id of Object.keys(backendTokens)) delete backendTokens[id]
      Object.assign(ports, replacement.backendPorts)
      Object.assign(backendTokens, replacement.backendTokens)
      try {
        gateway = await launchTrustedGateway()
        // Observe REAL captured Windows/Node child handles after verified
        // restart. Unexpected exit or IPC loss creates a durable private
        // fixture hold; a subsequent restart is never silently attempted.
        restartedSupervisor = createPrivateWindowsSupervisorCrashHold({
          stateDirectory, householdIds: expected,
        })
        for (const backend of replacement.backends) {
          restartedSupervisor.attachCapturedBackend(backend)
        }
        restartedSupervisor.markHealthy()
      } catch (error) {
        const failures = [error]
        if (gateway) {
          try { await gateway.close(); gateway = null }
          catch (closeError) { failures.push(closeError) }
        }
        for (const backend of [...replacement.backends].reverse()) {
          try { await stopDisposableHouseholdBackend(backend) }
          catch (shutdownError) { failures.push(shutdownError) }
        }
        if (failures.length > 1) {
          throw new AggregateError(failures,
            'Private gateway failed to restart and child shutdown is unverified.')
        }
        throw error
      }
      return { activeHouseholdIds: expected, gatewayPort: gateway.port }
    }

    return {
      get base() { return gateway?.base ?? null },
      get gatewayPort() { return gateway?.port ?? null },
      accounts,
      sample: { sharedCandidateDate, privateEventDate, sourceId },
      close,
      // Only expose listener ports to integration tests, never user browsers.
      privateBackendPorts: ports,
      startPendingHouseholdBackend,
      async enrollHouseholdBackend(details) {
        const outcome = await gateway.enrollHouseholdBackend(details)
        ports[details.householdId] = details.port
        backendTokens[details.householdId] = details.upstreamToken
        return outcome
      },
      restartApprovedBackendsAndGateway,
      get restartedSupervisorStatus() {
        return restartedSupervisor?.snapshot() ?? null
      },
    }
  } catch (error) {
    try { await close() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        'Demo startup failed, and safe child cleanup also failed.')
    }
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === filePath) {
  try {
    const demo = await startHouseholdBrowserDemo()
    console.log('')
    console.log('=== PRIVATE TWO-FAMILY BROWSER DEMO (NOT PRODUCTION) ===')
    console.log('All three Node servers are localhost-only; no Tailscale settings were changed.')
    console.log('All calendars, accounts, uploads and sessions are disposable.')
    console.log('Family A username: ' + demo.accounts[0].username)
    console.log('Family A TEMPORARY password: ' + demo.accounts[0].password)
    console.log('Family B username: ' + demo.accounts[1].username)
    console.log('Family B TEMPORARY password: ' + demo.accounts[1].password)
    console.log('Family A second member username: ' + demo.accounts[2].username)
    console.log('Family A second member TEMPORARY password: ' + demo.accounts[2].password)
    console.log('Family A HUB username: ' + demo.accounts[3].username)
    console.log('Family A HUB TEMPORARY password: ' + demo.accounts[3].password)
    console.log('Suggested event for sharing: DEMO A — BBQ to share (' +
      demo.sample.sharedCandidateDate + ')')
    console.log('')
    console.log('GATEWAY LOCAL PORT: ' + demo.gatewayPort)
    console.log('INTEGRATION TEST ONLY: no public or Tailscale HTTPS address was created.')
    console.log('Do NOT point Tailscale Serve to this demo or change its HTTPS ports.')
    console.log('This temporary HTTP loopback is for automated API checks, not phone login.')
    console.log('The existing LIVE and TEST sites must remain the only HTTPS sites.')
    console.log('Do not paste the generated temporary passwords into a chat.')
    console.log('Keep this terminal open for local automated checking. Ctrl+C stops it.')
    console.log('')

    let stopping = false
    async function shutdown() {
      if (stopping) return
      stopping = true
      try {
        await demo.close()
        console.log('Disposable family demo servers stopped and temporary data erased.')
        process.exitCode = 0
      } catch (error) {
        console.error('Could not completely clean up disposable demo:', error)
        process.exitCode = 1
      }
    }
    process.once('SIGINT', () => { void shutdown() })
    process.once('SIGTERM', () => { void shutdown() })
  } catch (error) {
    console.error('Private browser demo startup failed:', error)
    process.exitCode = 1
  }
}
