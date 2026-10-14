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

function startHouseholdBackend(storageRoot, householdId, port) {
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
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
    logs: () => logs,
  }
}

async function awaitHealthy(backend) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (backend.child.exitCode !== null || backend.child.signalCode !== null) break
    try {
      const response = await fetch(backend.base + '/api/health', {
        signal: AbortSignal.timeout(1200),
      })
      if (response.ok && (await response.json()).status === 'ok') return
    } catch { /* startup, not yet listening */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(
    'Disposable ' + backend.householdId + ' backend failed to start: ' +
    backend.logs(),
  )
}

async function stopBackend(backend) {
  if (backend.child.exitCode !== null || backend.child.signalCode !== null) return
  const child = backend.child
  const finished = new Promise(resolve => child.once('exit', resolve))
  child.kill()
  const stopped = await Promise.race([
    finished.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 6000)),
  ])
  if (!stopped) throw new Error('Disposable backend did not stop: ' + backend.householdId)
}

async function seedEvent(base, event) {
  const response = await fetch(base + '/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
export async function startHouseholdBrowserDemo() {
  if (!fs.existsSync(path.join(checkout, 'dist', 'index.html'))) {
    throw new Error('Build this draft PR in the isolated preview checkout first.')
  }
  // No optional filesystem argument and no automatic use of live/test/preview.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'family-calendar-browser-demo-'))
  const storageRoot = path.join(root, 'storage')
  fs.mkdirSync(storageRoot, { mode: 0o700 })
  const central = new DatabaseSync(path.join(root, 'identity.db'))
  const backends = []
  let gateway = null
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    const errors = []
    if (gateway) {
      try { await gateway.close() } catch (error) { errors.push(error) }
    }
    for (const backend of backends) {
      try { await stopBackend(backend) } catch (error) { errors.push(error) }
    }
    try { central.close() } catch (error) { errors.push(error) }
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

    const accounts = [
      { username: 'demo-family-a', displayName: 'Demo Family A',
        householdId: 'family-a', password: 'Demo-' + randomBytes(20).toString('base64url') },
      { username: 'demo-family-b', displayName: 'Demo Family B',
        householdId: 'family-b', password: 'Demo-' + randomBytes(20).toString('base64url') },
    ]
    for (const account of accounts) {
      setFamilyAccount(central, account.username, account.displayName, account.password)
      registerHousehold(central, {
        householdId: account.householdId, displayName: account.displayName,
      })
      const row = central.prepare(
        'SELECT id FROM family_users WHERE username = ?'
      ).get(account.username)
      grantHouseholdMembership(central, {
        serverVerifiedUserId: row.id,
        householdId: account.householdId,
        role: 'owner',
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
    for (const account of accounts) {
      backends.push(startHouseholdBackend(
        storageRoot, account.householdId, ports[account.householdId],
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
    })
    await seedEvent(backends[0].base, {
      date: privateEventDate,
      title: 'DEMO A — PRIVATE appointment',
      time: '09:00',
      notes: 'Demo A confidential details.',
    })
    await seedEvent(backends[1].base, {
      date: privateEventDate,
      title: 'DEMO B — PRIVATE family event',
      time: '11:00',
      notes: 'Demo B confidential details.',
    })

    gateway = await startPrivateHouseholdGateway({
      identityDatabase: central,
      serverDirectory,
      storageRoot,
      backendPorts: ports,
    })
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

    return {
      base: gateway.base,
      gatewayPort: gateway.port,
      accounts,
      sample: { sharedCandidateDate, privateEventDate, sourceId },
      close,
      // Only expose listener ports to integration tests, never user browsers.
      privateBackendPorts: ports,
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
    console.log('Suggested event for sharing: DEMO A — BBQ to share (' +
      demo.sample.sharedCandidateDate + ')')
    console.log('')
    console.log('GATEWAY LOCAL PORT: ' + demo.gatewayPort)
    console.log('For secure HTTPS browser login, use an ADDITIONAL tailnet-only')
    console.log('Tailscale Serve HTTPS endpoint on port 8443 after checking')
    console.log('that port is not already used. Do NOT use Funnel or overwrite 443.')
    console.log('Preview the EXISTING Serve configuration before changes:')
    console.log('  tailscale serve status')
    console.log('DO NOT paste the temporary passwords into a chat.')
    console.log('Keep this terminal open during the test. Press Ctrl+C to stop.')
    console.log('Afterward, disable only the demo endpoint: tailscale serve --https=8443 off')
    console.log('NOTE: Turning off this demo does not affect existing HTTPS port 443.')
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
