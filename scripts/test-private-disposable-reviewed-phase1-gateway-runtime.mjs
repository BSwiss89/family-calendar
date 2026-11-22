// Real calendar Node child + central private gateway, but OS-TEMP DATA ONLY.
// No Windows task, public endpoint, existing TEST/LIVE DB or listener is used.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { setFamilyAccount } from '../Server/family-auth.mjs'
import { createHouseholdMembershipTables, registerHousehold,
  grantHouseholdMembership } from '../Server/household-memberships.mjs'
import { createPrivateActivationRecords } from '../Server/private-household-activation-records.mjs'
import { createIndependentHouseholdInvitationTables } from '../Server/independent-household-invitations.mjs'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'
import { launchDisposableReviewedPhase1Gateway } from '../Server/private-disposable-reviewed-phase1-gateway-runtime.mjs'
import { inspectReviewedWindowsSupervisorOwnership } from '../Server/private-reviewed-windows-supervisor-ownership.mjs'

const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'Server')
const password = 'Disposable-Primary-Owner-Only-2026!'
const primaryHouseholdId = 'household-primary-phase1'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-phase1-real-gateway-host-'))
  const storageRoot = path.join(root, 'families')
  const stateDirectory = path.join(root, 'supervisor-state')
  fs.mkdirSync(storageRoot)
  fs.mkdirSync(stateDirectory)
  const identityDatabasePath = path.join(root, 'central.db')
  const db = new DatabaseSync(identityDatabasePath)
  try {
    createHouseholdMembershipTables(db)
    createIndependentHouseholdInvitationTables(db)
    createPrivateActivationRecords(db)
    setFamilyAccount(db, 'phase1systemoperator', 'Operator', password)
    setFamilyAccount(db, 'phase1primaryowner', 'Primary Owner', password)
    registerHousehold(db, {
      householdId: primaryHouseholdId, displayName: 'Primary family',
    })
    const operatorId = db.prepare(
      "SELECT id FROM family_users WHERE username='phase1systemoperator'").get().id
    const ownerId = db.prepare(
      "SELECT id FROM family_users WHERE username='phase1primaryowner'").get().id
    grantHouseholdMembership(db, {
      serverVerifiedUserId: ownerId, householdId: primaryHouseholdId,
      role: 'owner',
    })
    provisionEmptyHousehold({
      serverDirectory, storageRoot, householdId: primaryHouseholdId,
    })
    t.after(() => fs.rmSync(root, {
      recursive: true, force: true, maxRetries: 6, retryDelay: 150,
    }))
    return {
      fixtureRoot: root, storageRoot, stateDirectory,
      identityDatabasePath, serverDirectory,
      primaryHouseholdId, operatorUserIds: [operatorId],
    }
  } finally {
    db.close()
  }
}
async function request(base, route, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(base + route, {
    method, redirect: 'manual', signal: AbortSignal.timeout(7000),
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { Origin: 'https://' + new URL(base).host } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const content = response.headers.get('content-type')?.includes('application/json')
    ? await response.json() : await response.text()
  return { response, content }
}

test('real Phase 1 Owner gateway runs only after supervised localhost backend proof and closes cleanly', {
  timeout: 100000,
}, async t => {
  const options = fixture(t)
  const before = fs.readdirSync(options.stateDirectory)
  assert.deepEqual(before, [])
  const runtime = await launchDisposableReviewedPhase1Gateway(options)
  let shutdown = false
  try {
    const snapshot = runtime.snapshot()
    assert.equal(snapshot.phase, 'running')
    assert.deepEqual(snapshot.householdIds, [primaryHouseholdId])
    assert.equal(snapshot.capturedCount, 1)
    assert.equal(snapshot.gatewayLocalhostOnly, true)
    assert.equal(snapshot.realCalendarBackendsStarted, true)
    assert.equal(snapshot.realGatewayStarted, true)
    assert.equal(snapshot.osTempFixtureOnly, true)
    assert.equal(snapshot.testDeploymentAuthorized, false)
    assert.equal(snapshot.windowsTaskInstalled, false)
    assert.equal(snapshot.osWideWriterFencingVerified, false)
    assert.equal(snapshot.childPorts.length, 1)
    const ownerLock = inspectReviewedWindowsSupervisorOwnership(options.stateDirectory)
    assert.equal(ownerLock.instanceLockPresent, true)
    assert.equal(ownerLock.crashHoldPresent, false)

    const anon = await request(runtime.base, '/api/events')
    assert.equal(anon.response.status, 401,
      'private gateway does not expose anonymous household events')
    const health = await request(runtime.base, '/api/health')
    assert.equal(health.response.status, 200)
    const direct = await fetch('http://127.0.0.1:' +
      snapshot.childPorts[0] + '/api/events', { signal: AbortSignal.timeout(5000) })
    assert.equal(direct.status, 403,
      'direct localhost household backend has no browser access')

    const signedIn = await request(runtime.base, '/api/auth/login', {
      method: 'POST',
      body: {
        username: 'phase1primaryowner', password,
        deviceLabel: 'Disposable test phone',
      },
    })
    assert.equal(signedIn.response.status, 200)
    const cookie = signedIn.response.headers.get('set-cookie')
    assert.match(cookie, /__Host-fc_gateway_session=/)
    const ownerCookie = cookie.split(';')[0]
    const phase1 = await request(runtime.base, '/phase1', { cookie: ownerCookie })
    assert.equal(phase1.response.status, 200)
    assert.match(phase1.content, /Phase 1: household account isolation/)
    const events = await request(runtime.base, '/api/events', { cookie: ownerCookie })
    assert.equal(events.response.status, 200)
    assert(Array.isArray(events.content))
    const deniedToSystem = await request(runtime.base, '/api/admin/household-overview',
      { cookie: ownerCookie })
    assert.equal(deniedToSystem.response.status, 404,
      'family Owner cannot access system operator routes during pilot')

    const closed = await runtime.shutdown()
    shutdown = true
    assert.deepEqual(closed, {
      allChildrenExited: true, gatewayClosed: true,
      ownerInstanceReleased: true, osWideWriterFencingVerified: false,
      testDeploymentAuthorized: false,
    })
    assert.equal(inspectReviewedWindowsSupervisorOwnership(
      options.stateDirectory).instanceLockPresent, false)
    assert.equal(inspectReviewedWindowsSupervisorOwnership(
      options.stateDirectory).crashHoldPresent, false)
  } finally {
    // If a failure precedes an orderly shutdown, DO NOT clear the lock or
    // kill an unrelated process. The fixture remains quarantined for review.
    if (!shutdown) {
      try { await runtime.shutdown() } catch { /* retain failure evidence */ }
    }
  }
})

test('invalid identity, protected ports or non-temporary fixture never start a private gateway', {
  timeout: 10000,
}, async t => {
  const options = fixture(t)
  const unsafe = [
    { ...options, primaryHouseholdId: 'family-a' },
    { ...options, operatorUserIds: [] },
    { ...options, trustedPhase1GatewayPort: 13002 },
    { ...options, trustedPhase1GatewayPort: 3001 },
    { ...options, fixtureRoot: path.dirname(options.fixtureRoot) },
  ]
  for (const input of unsafe) {
    await assert.rejects(launchDisposableReviewedPhase1Gateway(input))
    assert.equal(inspectReviewedWindowsSupervisorOwnership(
      options.stateDirectory).instanceLockPresent, false,
    'invalid preflight must fail before supervisor acquires ownership')
  }
})
