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
import { createPrivateActivationRecords, approvePrivateHouseholdActivation } from '../Server/private-household-activation-records.mjs'
import { createIndependentHouseholdInvitationTables,
  issueIndependentHouseholdInvitation, redeemIndependentHouseholdInvitation }
  from '../Server/independent-household-invitations.mjs'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'
import { launchDisposableReviewedPhase1Gateway } from '../Server/private-disposable-reviewed-phase1-gateway-runtime.mjs'
import { inspectReviewedWindowsSupervisorOwnership } from '../Server/private-reviewed-windows-supervisor-ownership.mjs'

const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'Server')
const password = 'Disposable-Primary-Owner-Only-2026!'
const primaryHouseholdId = 'household-primary-phase1'

function fixture(t, { invited = false } = {}) {
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
    // Exactly one invitation may create a second independent Owner in this
    // disposable fixture. No backend boot is triggered by registration.
    let invitedHouseholdId = null
    if (invited) {
      const invitation = issueIndependentHouseholdInvitation(db, {
        serverVerifiedAdministratorUserId: operatorId,
        trustedAdministratorUserIds: [operatorId],
      })
      const redeemed = redeemIndependentHouseholdInvitation(db, {
        token: invitation.token,
        username: 'phase1invitedowner',
        displayName: 'Invited Owner',
        password,
        householdName: 'Invited private family',
        trustedAdministratorUserIds: [operatorId],
        serverDirectory, storageRoot,
      })
      invitedHouseholdId = redeemed.householdId
      assert.match(invitedHouseholdId, /^family-[0-9a-f]{24}$/)
      assert.equal(redeemed.activation, 'pending')
      approvePrivateHouseholdActivation(db, { householdId: invitedHouseholdId })
    }
    t.after(() => fs.rmSync(root, {
      recursive: true, force: true, maxRetries: 6, retryDelay: 150,
    }))
    return {
      fixtureRoot: root, storageRoot, stateDirectory,
      identityDatabasePath, serverDirectory,
      primaryHouseholdId, operatorUserIds: [operatorId], invitedHouseholdId,
    }
  } finally {
    db.close()
  }
}
async function request(base, route, { method = 'GET', cookie, body, headers = {} } = {}) {
  const response = await fetch(base + route, {
    method, redirect: 'manual', signal: AbortSignal.timeout(7000),
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { Origin: 'https://' + new URL(base).host } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
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


test('two supervised real families remain isolated by signed Owner session and backend storage', {
  timeout: 120000,
}, async t => {
  const options = fixture(t, { invited: true })
  const privateId = options.invitedHouseholdId
  const runtime = await launchDisposableReviewedPhase1Gateway(options)
  let closed = false
  try {
    const snapshot = runtime.snapshot()
    assert.deepEqual(snapshot.householdIds, [primaryHouseholdId, privateId])
    assert.equal(snapshot.capturedCount, 2)
    assert.equal(snapshot.childPorts.length, 2)
    assert.notEqual(snapshot.childPorts[0], snapshot.childPorts[1])
    assert.equal(snapshot.gatewayLocalhostOnly, true)
    assert.equal(snapshot.testDeploymentAuthorized, false)
    assert.equal(snapshot.osWideWriterFencingVerified, false)
    assert.equal(snapshot.windowsTaskInstalled, false)

    async function login(username) {
      const res = await request(runtime.base, '/api/auth/login', {
        method: 'POST', body: { username, password, deviceLabel: 'Private CI phone' },
      })
      assert.equal(res.response.status, 200)
      const cookie = res.response.headers.get('set-cookie')
      assert.match(cookie, /__Host-fc_gateway_session=/)
      return cookie.split(';')[0]
    }
    const homeCookie = await login('phase1primaryowner')
    const invitedCookie = await login('phase1invitedowner')
    const operatorCookie = await login('phase1systemoperator')
    assert.notEqual(homeCookie, invitedCookie)

    // Both Owners see only the narrow pilot, not the system operator UI.
    for (const cookie of [homeCookie, invitedCookie]) {
      assert.equal((await request(runtime.base, '/phase1', { cookie }))
        .response.status, 200)
      assert.equal((await request(runtime.base, '/api/admin/household-overview',
        { cookie })).response.status, 404)
    }
    assert.equal((await request(runtime.base, '/api/events',
      { cookie: operatorCookie })).response.status, 404)
    assert.equal((await request(runtime.base, '/api/events')).response.status, 401)

    const homeEvent = 'Primary-only supervised Phase 1 event'
    const privateEvent = 'Invited-only supervised Phase 1 event'
    for (const [cookie, title, date, forgery] of [
      [homeCookie, homeEvent, '2027-02-03', privateId],
      [invitedCookie, privateEvent, '2027-02-04', primaryHouseholdId],
    ]) {
      const create = await request(runtime.base, '/api/events', {
        cookie, method: 'POST',
        headers: { 'x-household-id': forgery },
        body: { title, date, time: '13:00', householdId: forgery },
      })
      assert.equal(create.response.status, 201)
    }

    for (const [cookie, own, other, forgery] of [
      [homeCookie, homeEvent, privateEvent, privateId],
      [invitedCookie, privateEvent, homeEvent, primaryHouseholdId],
    ]) {
      const events = await request(runtime.base,
        '/api/events?householdId=' + encodeURIComponent(forgery), {
          cookie, headers: { 'x-household-id': forgery },
        })
      assert.equal(events.response.status, 200)
      assert.match(JSON.stringify(events.content), new RegExp(own))
      assert.doesNotMatch(JSON.stringify(events.content), new RegExp(other))
    }

    const homeList = 'Primary-only Phase 1 list'
    const invitedList = 'Invited-only Phase 1 list'
    for (const [cookie, name, forged] of [
      [homeCookie, homeList, privateId],
      [invitedCookie, invitedList, primaryHouseholdId],
    ]) {
      const create = await request(runtime.base, '/api/lists', {
        cookie, method: 'POST',
        headers: { 'x-household-id': forged },
        body: { name },
      })
      assert.equal(create.response.status, 201)
    }
    for (const [cookie, own, other] of [
      [homeCookie, homeList, invitedList],
      [invitedCookie, invitedList, homeList],
    ]) {
      const lists = await request(runtime.base, '/api/lists', { cookie })
      assert.equal(lists.response.status, 200)
      assert.match(JSON.stringify(lists.content), new RegExp(own))
      assert.doesNotMatch(JSON.stringify(lists.content), new RegExp(other))
    }

    // A valid browser session cannot bypass the central gateway on either
    // unshared localhost household backend.
    for (const port of snapshot.childPorts) {
      for (const cookie of [homeCookie, invitedCookie]) {
        const direct = await fetch('http://127.0.0.1:' + port + '/api/events', {
          headers: { Cookie: cookie, 'x-household-id': privateId },
          signal: AbortSignal.timeout(5000),
        })
        assert.equal(direct.status, 403)
      }
    }

    const stopped = await runtime.shutdown()
    closed = true
    assert.equal(stopped.allChildrenExited, true)
    assert.equal(stopped.gatewayClosed, true)
    assert.equal(inspectReviewedWindowsSupervisorOwnership(options.stateDirectory)
      .instanceLockPresent, false)
    for (const port of snapshot.childPorts) {
      await assert.rejects(fetch('http://127.0.0.1:' + port + '/api/health', {
        signal: AbortSignal.timeout(1000),
      }))
    }
    const storageNames = fs.readdirSync(path.join(options.storageRoot, 'households'))
    assert.deepEqual(new Set(storageNames), new Set([primaryHouseholdId, privateId]))
    for (const [id, own, other] of [
      [primaryHouseholdId, homeEvent, privateEvent],
      [privateId, privateEvent, homeEvent],
    ]) {
      const dbPath = path.join(options.storageRoot, 'households', id,
        'data', 'calendar.db')
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const titles = db.prepare('SELECT title FROM events').all().map(x => x.title)
        assert(titles.includes(own))
        assert(!titles.includes(other))
        assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok')
      } finally { db.close() }
    }
  } finally {
    if (!closed) {
      try { await runtime.shutdown() } catch { /* do not reclaim unsafe locks */ }
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


test('unexpected captured backend exit holds all gateway admission, including healthy sibling', {
  timeout: 120000,
}, async t => {
  const options = fixture(t, { invited: true })
  const runtime = await launchDisposableReviewedPhase1Gateway(options)
  let held = false
  try {
    assert.equal(runtime.snapshot().supervisorAdmissionOpen,true)
    const signedIn = await request(runtime.base,'/api/auth/login',{
      method:'POST', body:{username:'phase1invitedowner',password,deviceLabel:'Crash fixture'},
    })
    assert.equal(signedIn.response.status,200)
    const cookie=signedIn.response.headers.get('set-cookie').split(';')[0]
    assert.equal((await request(runtime.base,'/api/events',{cookie})).response.status,200)
    assert.equal(runtime.crashCapturedBackendForTest(primaryHouseholdId),true)
    for(let i=0;i<300 && runtime.snapshot().phase!=='held';i++){
      await new Promise(resolve=>setTimeout(resolve,20))
    }
    held=runtime.snapshot().phase==='held'
    assert.equal(held,true)
    assert.equal(runtime.snapshot().supervisorAdmissionOpen,false)
    assert.equal(runtime.snapshot().durableHoldPresent,true)
    for(const route of ['/api/health','/api/events','/phase1','/api/lists']){
      const denied=await request(runtime.base,route,{cookie})
      assert.equal(denied.response.status,503)
      assert.equal(denied.response.headers.get('cache-control'),'no-store')
    }
    assert.equal((await request(runtime.base,'/api/auth/login',{
      method:'POST',body:{username:'phase1primaryowner',password}
    })).response.status,503)
    assert.equal((await request(runtime.base,'/api/events',{
      method:'POST',cookie,body:{title:'Must never be admitted',date:'2027-02-01'}
    })).response.status,503)
    assert.equal(inspectReviewedWindowsSupervisorOwnership(options.stateDirectory).instanceLockPresent,true)
    await assert.rejects(launchDisposableReviewedPhase1Gateway(options),/persistent crash hold|existing supervisor instance/)
  } finally {
    if(held || runtime.snapshot().phase==='held'){
      const result=await runtime.closeHeldFixtureForTest()
      assert.equal(result.ownerInstanceRetained,true)
      assert.equal(inspectReviewedWindowsSupervisorOwnership(options.stateDirectory).instanceLockPresent,true)
      assert.equal(inspectReviewedWindowsSupervisorOwnership(options.stateDirectory).crashHoldPresent,true)
    } else await runtime.shutdown()
  }
})
