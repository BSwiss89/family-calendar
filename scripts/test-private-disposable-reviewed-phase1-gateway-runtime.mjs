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
import {assertLocalMaintenanceClear,createLocalBackupStopRequest,readLocalBackupStopRequest,completeLocalBackupStopRequest} from '../Server/private-phase1-local-maintenance-control.mjs'

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
async function request(base, route, { method = 'GET', cookie, body, headers = {}, timeout = 7000 } = {}) {
  const response = await fetch(base + route, {
    method, redirect: 'manual', signal: AbortSignal.timeout(timeout),
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
    await assert.rejects(launchDisposableReviewedPhase1Gateway(options),/gateway writer lock needs manual recovery review/)
  } finally {
    if(held || runtime.snapshot().phase==='held'){
      const result=await runtime.closeHeldFixtureForTest()
      assert.equal(result.ownerInstanceRetained,true)
      assert.equal(inspectReviewedWindowsSupervisorOwnership(options.stateDirectory).instanceLockPresent,true)
      assert.equal(inspectReviewedWindowsSupervisorOwnership(options.stateDirectory).crashHoldPresent,true)
      // Once the gateway releases its writer lock, the durable crash hold
      // itself must still block another boot. No lock is removed by this test.
      await assert.rejects(launchDisposableReviewedPhase1Gateway(options),/durable supervisor crash hold needs manual review/)
    } else await runtime.shutdown()
  }
})


test('real supervisor captures coordinated backup after shutdown and revokes sessions only in copy', {timeout:120000},async t=>{
 const options=fixture(t,{invited:true})
 const runtime=await launchDisposableReviewedPhase1Gateway(options)
 let stopping=false
 try{
  for(const username of ['phase1primaryowner','phase1invitedowner']){
   const login=await request(runtime.base,'/api/auth/login',{method:'POST',body:{username,password,deviceLabel:'Synthetic backup phone'}})
   assert.equal(login.response.status,200)
   const cookie=login.response.headers.get('set-cookie').split(';')[0]
   const event=await request(runtime.base,'/api/events',{method:'POST',cookie,body:{title:'Backup '+username,date:'2027-02-03',time:'13:00'}})
   assert.equal(event.response.status,201)
  }
  assertLocalMaintenanceClear(options.fixtureRoot)
  assert.equal(readLocalBackupStopRequest(options.fixtureRoot),null)
  const requested=createLocalBackupStopRequest(options.fixtureRoot)
  assert.equal(requested.restartBlocked,true)
  assert.throws(()=>createLocalBackupStopRequest(options.fixtureRoot))
  assert.throws(()=>assertLocalMaintenanceClear(options.fixtureRoot))
  const maintenanceRequest=readLocalBackupStopRequest(options.fixtureRoot)
  assert.equal(maintenanceRequest.requestId,requested.requestId)
  assert.throws(()=>readLocalBackupStopRequest(options.fixtureRoot))
  stopping=true
  const receipt=await runtime.shutdownAndCaptureBackup()
  completeLocalBackupStopRequest(options.fixtureRoot,maintenanceRequest,receipt)
  const maintenance=JSON.parse(fs.readFileSync(path.join(options.fixtureRoot,'MAINTENANCE-REVIEW','RECEIPT.json'),'utf8'))
  assert.equal(maintenance.result,'PASS')
  assert.equal(maintenance.backupName,receipt.backupName)
  assert.equal(maintenance.requestId,maintenanceRequest.requestId)
  assert.equal(maintenance.restartBlocked,true)
  assert.throws(()=>assertLocalMaintenanceClear(options.fixtureRoot))
  assert.throws(()=>completeLocalBackupStopRequest(options.fixtureRoot,maintenanceRequest,receipt))
  const {reviewLocalMaintenanceResume,archiveCompletedLocalMaintenanceHold}=await import('../Server/private-phase1-local-maintenance-control.mjs')
  const resumeOptions={root:options.fixtureRoot,storageRoot:options.storageRoot,identityDatabasePath:options.identityDatabasePath,serverDirectory,primaryHouseholdId,expectedRequestId:maintenanceRequest.requestId}
  const reviewed=reviewLocalMaintenanceResume(resumeOptions)
  assert.equal(reviewed.verifiedBackup,true)
  assert.equal(reviewed.originalDataUnchanged,true)
  assert.equal(reviewed.holdReleased,false)
  assert.throws(()=>reviewLocalMaintenanceResume({...resumeOptions,expectedRequestId:'0'.repeat(32)}))
  const unexpected=path.join(options.storageRoot,'households',primaryHouseholdId,'uploads','unexpected-after-stop.txt')
  fs.writeFileSync(unexpected,'synthetic drift')
  assert.throws(()=>archiveCompletedLocalMaintenanceHold(resumeOptions))
  assert.throws(()=>assertLocalMaintenanceClear(options.fixtureRoot))
  fs.unlinkSync(unexpected)
  const backupReview=path.join(options.fixtureRoot,'coordinated-backups',receipt.backupName,'BACKUP-REVIEW.json')
  const originalReview=fs.readFileSync(backupReview,'utf8')
  fs.writeFileSync(backupReview,JSON.stringify({...JSON.parse(originalReview),sourceDigest:'0'.repeat(64)}))
  assert.throws(()=>archiveCompletedLocalMaintenanceHold(resumeOptions))
  assert.throws(()=>assertLocalMaintenanceClear(options.fixtureRoot))
  fs.writeFileSync(backupReview,originalReview)
  const released=archiveCompletedLocalMaintenanceHold(resumeOptions)
  assert.equal(released.holdReleased,true)
  assert.equal(released.archivePreserved,true)
  assert.equal(released.taskStarted,false)
  assert.equal(released.windowsHostVerified,false)
  assertLocalMaintenanceClear(options.fixtureRoot)
  assert.equal(fs.existsSync(path.join(options.fixtureRoot,'MAINTENANCE-COMPLETED-'+maintenanceRequest.requestId,'RECEIPT.json')),true)
  assert.throws(()=>archiveCompletedLocalMaintenanceHold(resumeOptions))
  assert.equal(receipt.households,2)
  assert.equal(receipt.sessionsRevokedInCopy,2)
  for(const flag of ['sourceSessionsUnchanged','sourceFilesUnchanged','coordinatedBackupVerified','supervisorHeldDuringCapture','allChildrenExited','gatewayClosed','ownerInstanceReleased'])assert.equal(receipt[flag],true,flag)
  for(const flag of ['allSystemWritersFenced','restoreAuthorized','automaticRestartAllowed','testDeploymentAuthorized'])assert.equal(receipt[flag],false,flag)
  const bundle=path.join(options.fixtureRoot,'coordinated-backups',receipt.backupName)
  assert.equal(fs.existsSync(path.join(bundle,'INCOMPLETE.json')),false)
  const {verifyOfflinePrivateRestoreSet}=await import('../Server/private-restore-preflight.mjs')
  const attestation=JSON.parse(fs.readFileSync(path.join(bundle,'ATTESTATION.json'),'utf8'))
  assert.equal(verifyOfflinePrivateRestoreSet({serverDirectory,restoreRoot:path.join(bundle,'snapshot')},attestation).ok,true)
  const live=new DatabaseSync(options.identityDatabasePath,{readOnly:true})
  const copy=new DatabaseSync(path.join(bundle,'snapshot','central','identity.db'),{readOnly:true})
  try{
   assert.equal(live.prepare('SELECT COUNT(*) AS n FROM family_sessions WHERE revoked_at IS NULL').get().n,2)
   assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM family_sessions WHERE revoked_at IS NULL').get().n,0)
   assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n,2)
  }finally{copy.close();live.close()}
  assert.equal(inspectReviewedWindowsSupervisorOwnership(options.stateDirectory).instanceLockPresent,false)
  for(const [id,username] of [[primaryHouseholdId,'phase1primaryowner'],[options.invitedHouseholdId,'phase1invitedowner']]){
   const db=new DatabaseSync(path.join(bundle,'snapshot','households',id,'data','calendar.db'),{readOnly:true})
   try{assert.equal(db.prepare('SELECT title FROM events').get().title,'Backup '+username)}finally{db.close()}
  }
  const resumed=await launchDisposableReviewedPhase1Gateway(options)
  try{
   assert.equal(resumed.snapshot().phase,'running')
   const login=await request(resumed.base,'/api/auth/login',{method:'POST',body:{username:'phase1primaryowner',password,deviceLabel:'Synthetic resumed phone'}})
   assert.equal(login.response.status,200)
   const events=await request(resumed.base,'/api/events',{method:'GET',cookie:login.response.headers.get('set-cookie').split(';')[0]})
   assert.equal(events.response.status,200)
  }finally{await resumed.shutdown()}
 }finally{if(!stopping)await runtime.shutdown()}
})


test('real pending signup survives coordinated backup and restart, and recovery HTTP works', {timeout:120000}, async t=>{
 const options=fixture(t)
 let runtime=await launchDisposableReviewedPhase1Gateway(options), stopped=false
 try{
  const post=(route,body,cookie)=>request(runtime.base,route,{method:'POST',body,cookie})
  const login=await post('/api/auth/login',{username:'phase1systemoperator',password})
  assert.equal(login.response.status,200)
  const operatorCookie=login.response.headers.get('set-cookie').split(';')[0]
  const invite=await post('/api/households/independent-invitations',{},operatorCookie)
  assert.equal(invite.response.status,201)
  const token=new URLSearchParams(new URL(invite.content.startUrl).hash.slice(1)).get('token')
  const signup=await post('/api/households/create-from-invitation',{token,username:'pendingowner',displayName:'Pending Owner',password:'Eight888',householdName:'Pending household'})
  assert.equal(signup.response.status,201)
  const pendingLogin=await post('/api/auth/login',{username:'pendingowner',password:'Eight888'})
  assert.equal(pendingLogin.response.status,200)
  const pendingCookie=pendingLogin.response.headers.get('set-cookie').split(';')[0]
  assert.notEqual((await request(runtime.base,'/api/events',{cookie:pendingCookie})).response.status,200)
  assert.equal((await post('/api/auth/recovery/request',{username:'pendingowner'})).response.status,202)
  const requests=await request(runtime.base,'/api/admin/recovery/requests',{cookie:operatorCookie})
  assert.equal(requests.response.status,200)
  const item=requests.content.requests.find(x=>x.username==='pendingowner')
  assert.ok(item)
  assert.equal((await request(runtime.base,'/api/admin/recovery/requests',{cookie:pendingCookie})).response.status,404)
  const issueRoute='/api/admin/recovery/requests/'+item.id+'/issue'
  assert.equal((await post(issueRoute,{verifiedOutOfBand:true})).response.status,401)
  assert.equal((await post(issueRoute,{verifiedOutOfBand:true},pendingCookie)).response.status,404)
  assert.equal((await post(issueRoute,{verifiedOutOfBand:false},operatorCookie)).response.status,400)
  assert.equal((await request(runtime.base,issueRoute,{method:'POST',body:{verifiedOutOfBand:true},cookie:operatorCookie,headers:{Origin:'https://untrusted.example'}})).response.status,403)
  const issued=await post('/api/admin/recovery/requests/'+item.id+'/issue',{verifiedOutOfBand:true},operatorCookie)
  assert.equal(issued.response.status,200)
  const lostToken=new URLSearchParams(new URL(issued.content.resetUrl).hash.slice(1)).get('token')
  const overview=await request(runtime.base,'/api/admin/household-overview',{cookie:operatorCookie})
  assert.equal(overview.content.households.find(x=>x.displayName==='Pending household').ownerUsername,'pendingowner')
  const history=await request(runtime.base,'/api/admin/recovery/requests',{cookie:operatorCookie})
  assert.equal(history.content.history.find(x=>x.id===item.id).canReissue,true)
  assert.equal(history.content.requests.length,0)
  const reissueRoute='/api/admin/recovery/requests/'+item.id+'/reissue'
  assert.equal((await post(reissueRoute,{verifiedOutOfBand:true},pendingCookie)).response.status,404)
  assert.equal((await post(reissueRoute,{verifiedOutOfBand:false},operatorCookie)).response.status,400)
  const rotated=await post(reissueRoute,{verifiedOutOfBand:true},operatorCookie)
  assert.equal(rotated.response.status,200)
  assert.equal((await post('/api/auth/recovery/complete',{token:lostToken,newPassword:'Reset888'})).response.status,400)
  const resetToken=new URLSearchParams(new URL(rotated.content.resetUrl).hash.slice(1)).get('token')
  assert.equal((await post('/api/auth/recovery/complete',{token:resetToken,newPassword:'Reset888'})).response.status,200)
  const completed=await request(runtime.base,'/api/admin/recovery/requests',{cookie:operatorCookie})
  assert.equal(completed.content.history.find(x=>x.id===item.id).status,'revoked')
  assert.equal(completed.content.history.some(x=>x.username==='pendingowner'&&x.status==='redeemed'),true)
  assert.equal((await post('/api/auth/login',{username:'pendingowner',password:'Reset888'})).response.status,200)
  const requested=createLocalBackupStopRequest(options.fixtureRoot)
  const maintenance=readLocalBackupStopRequest(options.fixtureRoot)
  const receipt=await runtime.shutdownAndCaptureBackup()
  stopped=true
  assert.equal(receipt.households,2)
  completeLocalBackupStopRequest(options.fixtureRoot,maintenance,receipt)
  const {archiveCompletedLocalMaintenanceHold}=await import('../Server/private-phase1-local-maintenance-control.mjs')
  assert.equal(archiveCompletedLocalMaintenanceHold({root:options.fixtureRoot,storageRoot:options.storageRoot,identityDatabasePath:options.identityDatabasePath,serverDirectory,primaryHouseholdId,expectedRequestId:requested.requestId}).holdReleased,true)
  runtime=await launchDisposableReviewedPhase1Gateway(options)
  stopped=false
  assert.equal(runtime.snapshot().householdCount,1)
  assert.equal((await post('/api/auth/login',{username:'pendingowner',password:'Reset888'})).response.status,200)
  // Simulate the legacy shutdown's exact abandoned instance/request state
  // after all real disposable children exited. Never use installed TEST data.
  const transitionRequest=createLocalBackupStopRequest(options.fixtureRoot)
  readLocalBackupStopRequest(options.fixtureRoot)
  const instanceFile=path.join(options.stateDirectory,'.family-calendar-reviewed-supervisor-instance.lock')
  const instanceRaw=fs.readFileSync(instanceFile,'utf8')
  await runtime.shutdown()
  stopped=true
  fs.writeFileSync(instanceFile,instanceRaw,{flag:'wx'})
  const {completeLegacyPendingHouseholdTransition}=await import('../Server/private-phase1-pending-transition.mjs')
  const args={root:options.fixtureRoot,storageRoot:options.storageRoot,identityDatabasePath:options.identityDatabasePath,serverDirectory,primaryHouseholdId,expectedRequestId:transitionRequest.requestId,gatewayPort:runtime.snapshot().gatewayPort}
  await assert.rejects(completeLegacyPendingHouseholdTransition({...args,checkHost:()=>{throw Error('Synthetic host not fenced')}}),/Synthetic host not fenced/)
  assert.equal(fs.existsSync(instanceFile),true)
  const bridged=await completeLegacyPendingHouseholdTransition({...args,checkHost:pid=>assert.equal(pid,process.pid)})
  assert.equal(bridged.households,2)
  assert.equal(bridged.pendingHouseholds,1)
  assert.equal(bridged.originalEvidenceArchived,true)
  assert.equal(bridged.originalSourceUnchanged,true)
  assert.equal(fs.existsSync(instanceFile),false)
  assertLocalMaintenanceClear(options.fixtureRoot)
  const evidence=path.join(options.fixtureRoot,'LEGACY-PENDING-TRANSITION-'+transitionRequest.requestId)
  assert.equal(fs.readFileSync(path.join(evidence,'LEGACY-SUPERVISOR-INSTANCE.json'),'utf8'),instanceRaw)
  assert.equal(JSON.parse(fs.readFileSync(path.join(evidence,'TRANSITION.json'),'utf8')).originalMaintenanceCompleted,false)
  runtime=await launchDisposableReviewedPhase1Gateway(options)
  stopped=false
  assert.equal((await post('/api/auth/login',{username:'pendingowner',password:'Reset888'})).response.status,200)
 }finally{if(!stopped)await runtime.shutdown()}
})

test('malformed or stale local maintenance request cannot become a shutdown authorization',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fc-phase1-maintenance-'))
 t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:100}))
 fs.mkdirSync(path.join(root,'supervisor-state'))
 const lock=path.join(root,'supervisor-state','.family-calendar-reviewed-supervisor-instance.lock')
 assert.throws(()=>createLocalBackupStopRequest(root))
 assertLocalMaintenanceClear(root)
 const instance={schemaVersion:1,type:'reviewed-multifamily-supervisor-instance',nonce:'a'.repeat(64),pid:process.pid}
 fs.writeFileSync(lock,JSON.stringify(instance))
 createLocalBackupStopRequest(root)
 fs.writeFileSync(lock,JSON.stringify({...instance,nonce:'b'.repeat(64)}))
 assert.throws(()=>readLocalBackupStopRequest(root))
 assert.throws(()=>assertLocalMaintenanceClear(root))
 assert.equal(fs.existsSync(path.join(root,'MAINTENANCE-REVIEW','IN-PROGRESS.json')),false)
 assert.equal(fs.existsSync(path.join(root,'MAINTENANCE-REVIEW','RECEIPT.json')),false)
})

test('operator browser approval adds a supervised isolated household and survives coordinated backup and restart',{timeout:180000},async t=>{
 const options=fixture(t)
 let runtime=await launchDisposableReviewedPhase1Gateway(options),stopped=false
 const get=(route,cookie)=>request(runtime.base,route,{cookie})
 const post=(route,body,cookie,timeout)=>request(runtime.base,route,{method:'POST',body,cookie,timeout})
 async function login(username,pw=password){
  const result=await post('/api/auth/login',{username,password:pw})
  assert.equal(result.response.status,200)
  return result.response.headers.get('set-cookie').split(';')[0]
 }
 try{
  const operator=await login('phase1systemoperator'),primary=await login('phase1primaryowner')
  const invite=await post('/api/households/independent-invitations',{},operator)
  assert.equal(invite.response.status,201)
  const token=new URLSearchParams(new URL(invite.content.startUrl).hash.slice(1)).get('token')
  const signup=await post('/api/households/create-from-invitation',{token,username:'activatedowner',displayName:'Activated Owner',password:'Eight888',householdName:'Browser approved family'})
  assert.equal(signup.response.status,201)
  const owner=await login('activatedowner','Eight888')
  const overview=await get('/api/admin/household-overview',operator)
  const id=overview.content.households.find(h=>h.ownerUsername==='activatedowner').householdId
  const route='/api/admin/households/'+id+'/activate'
  const body={confirmActivation:true}
  const readiness=await get('/api/admin/activation-readiness',operator)
  assert.equal(readiness.content.canActivateFromBrowser,true)
  assert.equal(runtime.snapshot().capturedCount,1)
  assert.notEqual((await get('/api/events',owner)).response.status,200)
  assert.equal((await post(route,body,owner)).response.status,404)
  assert.equal((await post(route,{...body,confirmActivation:false},operator)).response.status,400)
  assert.equal((await post(route,{...body,ownerPassword:'unexpected-password'},operator)).response.status,400)
  assert.equal((await post(route,body,undefined)).response.status,401)
  assert.equal((await request(runtime.base,route,{method:'POST',body,cookie:operator,headers:{Origin:'https://untrusted.example'}})).response.status,403)
  assert.equal((await post('/api/events',{title:'Primary secret appointment',date:'2027-02-03',time:'13:00'},primary)).response.status,201)
  const approved=await post(route,body,operator,120000)
  assert.equal(approved.response.status,200,JSON.stringify(approved.content))
  assert.equal(approved.content.activation,'active')
  assert.equal(runtime.snapshot().phase,'running')
  assert.deepEqual(runtime.snapshot().householdIds,[primaryHouseholdId,id])
  assert.equal(runtime.snapshot().capturedCount,2)
  assert.equal(runtime.snapshot().childPorts.length,2)
  assert.equal((await post(route,body,operator)).response.status,409)
  const backups=path.join(options.fixtureRoot,'pending-activation-backups')
  const files=fs.readdirSync(backups)
  assert.equal(files.length,1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(backups,files[0],'BACKUP-REVIEW.json'),'utf8')).sourceUnchanged,true)
  assert.equal((await get('/api/events',operator)).response.status,404)
  assert.equal((await get('/api/events',owner)).response.status,200)
  assert.doesNotMatch(JSON.stringify((await get('/api/events',owner)).content),/Primary secret appointment/)
  assert.equal((await post('/api/events',{title:'New household appointment',date:'2027-02-04',time:'13:00'},owner)).response.status,201)
  assert.doesNotMatch(JSON.stringify((await get('/api/events',primary)).content),/New household appointment/)
  for(const [cookie,name] of [[primary,'Primary isolated list'],[owner,'New isolated list']])assert.equal((await post('/api/lists',{name},cookie)).response.status,201)
  assert.doesNotMatch(JSON.stringify((await get('/api/lists',primary)).content),/New isolated list/)
  assert.doesNotMatch(JSON.stringify((await get('/api/lists',owner)).content),/Primary isolated list/)
  const requested=createLocalBackupStopRequest(options.fixtureRoot)
  const maintenance=readLocalBackupStopRequest(options.fixtureRoot)
  const receipt=await runtime.shutdownAndCaptureBackup()
  stopped=true
  assert.equal(receipt.households,2)
  completeLocalBackupStopRequest(options.fixtureRoot,maintenance,receipt)
  const {archiveCompletedLocalMaintenanceHold}=await import('../Server/private-phase1-local-maintenance-control.mjs')
  assert.equal(archiveCompletedLocalMaintenanceHold({root:options.fixtureRoot,storageRoot:options.storageRoot,identityDatabasePath:options.identityDatabasePath,serverDirectory,primaryHouseholdId,expectedRequestId:requested.requestId}).holdReleased,true)
  runtime=await launchDisposableReviewedPhase1Gateway(options)
  stopped=false
  assert.equal(runtime.snapshot().capturedCount,2)
  const relogin=await login('activatedowner','Eight888')
  const events=await get('/api/events',relogin)
  assert.equal(events.response.status,200)
  assert.match(JSON.stringify(events.content),/New household appointment/)
  assert.doesNotMatch(JSON.stringify(events.content),/Primary secret appointment/)
 }finally{
  if(!stopped){
   if(runtime.snapshot().phase==='held')await runtime.closeHeldFixtureForTest()
   else await runtime.shutdown()
  }
 }
})

test('original Owner dashboard is served on the existing supervised gateway with isolated core features',{timeout:120000},async t=>{
 const options={...fixture(t,{invited:true}),ownerDashboard:true}
 const runtime=await launchDisposableReviewedPhase1Gateway(options)
 const get=(route,cookie)=>request(runtime.base,route,{cookie})
 const post=(route,body,cookie)=>request(runtime.base,route,{method:'POST',body,cookie})
 async function login(username){
  const result=await post('/api/auth/login',{username,password})
  assert.equal(result.response.status,200)
  return result.response.headers.get('set-cookie').split(';')[0]
 }
 try{
  const a=await login('phase1primaryowner'),b=await login('phase1invitedowner'),operator=await login('phase1systemoperator')
  assert.equal((await get('/')).response.status,303)
  assert.equal((await get('/',operator)).response.headers.get('location'),'/system-admin')
  for(const cookie of [a,b]){
   const page=await get('/',cookie)
   assert.equal(page.response.status,200)
   assert.match(page.content,/<div id="root"><\/div>/)
   assert.doesNotMatch(page.content,/Phase 1: household account isolation/)
   assert.equal(page.response.headers.get('cache-control'),'no-store')
   const script=page.content.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
   assert.ok(script,'built original Vite module must be referenced')
   assert.equal((await get(script,cookie)).response.status,200)
   for(const route of ['/api/events','/api/people','/api/lists','/api/shopping-stores','/api/recipes','/api/meal-plans','/api/meal-plan-items','/api/emoji-markers']){
    const result=await get(route,cookie)
    assert.equal(result.response.status,200,route)
    assert.ok(Array.isArray(result.content),route)
   }
   assert.equal((await get('/api/admin/household-overview',cookie)).response.status,404)
   assert.equal((await post('/api/ai/intent',{text:'test'},cookie)).response.status,404)
   assert.equal((await get('/api/test-notification-pilot',cookie)).response.status,404)
   assert.equal((await get('/api/households/members',cookie)).response.status,403)
   assert.equal((await get('/api/internal/household-binding',cookie)).response.status,404)
   assert.equal((await get('/family-push-sw.js',cookie)).response.status,404)
  }
  for(const [cookie,name,color] of [[a,'Primary private profile','#123456'],[b,'Invited private profile','#654321']]){
   const form=new FormData()
   form.set('name',name);form.set('color',color)
   const sharp=(await import('sharp')).default
   const bytes=await sharp({create:{width:4,height:4,channels:3,background:color}}).png().toBuffer()
   form.set('image',new Blob([bytes],{type:'image/png'}),'avatar.png')
   const result=await fetch(runtime.base+'/api/people',{method:'POST',headers:{Cookie:cookie,Origin:'https://'+new URL(runtime.base).host},body:form})
   const created=await result.json()
   assert.equal(result.status,201,JSON.stringify(created))
   assert.match(created.image,/^avatar-[0-9-]+\.webp$/)
   const own=await fetch(runtime.base+'/uploads/'+created.image,{headers:{Cookie:cookie}})
   assert.equal(own.status,200)
   assert.equal(own.headers.get('cache-control'),'no-store')
   const other=await fetch(runtime.base+'/uploads/'+created.image,{headers:{Cookie:cookie===a?b:a}})
   assert.equal(other.status,404)
  }
  assert.doesNotMatch(JSON.stringify((await get('/api/people',a)).content),/Invited private profile/)
  assert.doesNotMatch(JSON.stringify((await get('/api/people',b)).content),/Primary private profile/)
  assert.equal((await get('/api/people',operator)).response.status,404)
  assert.equal((await get('/api/people')).response.status,401)
  assert.equal((await get('/phase1',a)).response.status,200)
 }finally{await runtime.shutdown()}
})

test('restored household dashboard enrolls personal Adult and Child accounts with server-enforced grants',{timeout:120000},async t=>{
 const runtime=await launchDisposableReviewedPhase1Gateway({...fixture(t,{invited:true}),ownerDashboard:true})
 const get=(route,cookie)=>request(runtime.base,route,{cookie})
 const post=(route,body,cookie)=>request(runtime.base,route,{method:'POST',body,cookie})
 async function login(username,pw=password){
  const result=await post('/api/auth/login',{username,password:pw})
  assert.equal(result.response.status,200)
  return result.response.headers.get('set-cookie').split(';')[0]
 }
 try{
  const owner=await login('phase1invitedowner'),other=await login('phase1primaryowner'),operator=await login('phase1systemoperator')
  assert.equal((await get('/api/households/member-access',owner)).response.status,403)
  assert.equal((await post('/api/households/member-invitations',{},owner)).response.status,403)
  assert.equal((await post('/api/households/settings-unlock',{password:'not-the-password'},owner)).response.status,403)
  assert.equal((await post('/api/households/settings-unlock',{password},operator)).response.status,404)
  const unlocked=await post('/api/households/settings-unlock',{password},owner)
  assert.equal(unlocked.response.status,200)
  assert.match(unlocked.content.token,/^[a-f0-9]{64}$/)
  let settingsToken=unlocked.content.token
  const settings=(route,cookie=owner,method='GET',body)=>request(runtime.base,route,{cookie,method,body,headers:{'x-family-settings-visit':settingsToken}})
  assert.equal((await settings('/api/households/member-access')).response.status,200)
  assert.equal((await settings('/api/households/member-access',other)).response.status,403)
  const secondSession=await login('phase1invitedowner')
  assert.equal((await settings('/api/households/member-access',secondSession)).response.status,403)
  const form=new FormData();form.set('name','Linked child');form.set('color','#123456')
  const created=await fetch(runtime.base+'/api/people',{method:'POST',headers:{Cookie:owner,Origin:'https://'+new URL(runtime.base).host},body:form})
  assert.equal(created.status,201);const person=await created.json()
  async function invite(username){
   const link=await settings('/api/households/member-invitations',owner,'POST',{})
   assert.equal(link.response.status,201)
   const result=await post('/api/households/join',{token:link.content.token,username,displayName:username,password})
   assert.equal(result.response.status,201)
   const cookie=await login(username)
   const directory=await settings('/api/households/member-access')
   assert.equal(directory.response.status,200)
   const member=directory.content.members.find(m=>m.username===username)
   assert.ok(member);assert.equal(member.memberType,null)
   assert.equal((await get('/api/households/my-member-access',cookie)).response.status,403)
   assert.equal((await get('/api/events',cookie)).response.status,403)
   return {cookie,id:member.userId}
  }
  const child=await invite('disposablechild'),adult=await invite('disposableadult')
  const change=(member,kind,body,cookie=owner)=>settings('/api/households/members/'+member.id+'/'+kind,cookie,'POST',body)
  assert.equal((await post('/api/households/members/'+child.id+'/type',{memberType:'child',ownerPassword:password},owner)).response.status,403)
  assert.equal((await post('/api/households/settings-unlock',{password},child.cookie)).response.status,404)
  assert.equal((await change(child,'type',{memberType:'child'},other)).response.status,403)
  assert.equal((await change(child,'type',{memberType:'child'},child.cookie)).response.status,404)
  assert.equal((await change(child,'type',{memberType:'child'})).response.status,200)
  assert.equal((await change(adult,'type',{memberType:'adult'})).response.status,200)
  assert.equal((await change(child,'person',{personId:person.id})).response.status,200)
  const access=await get('/api/households/my-member-access',child.cookie)
  assert.equal(access.content.memberType,'child');assert.equal(access.content.linkedPersonId,person.id)
  const childPeople=await get('/api/people',child.cookie)
  assert.equal(childPeople.response.status,200)
  assert.ok(childPeople.content.some(p=>p.id===person.id&&p.name==='Linked child'))
  assert.equal((await get('/',child.cookie)).response.status,200)
  assert.equal((await get('/api/events',child.cookie)).response.status,200)
  assert.equal((await get('/api/lists',child.cookie)).response.status,403)
  assert.equal((await get('/api/recipes',child.cookie)).response.status,403)
  assert.equal((await get('/api/households/member-access',child.cookie)).response.status,404)
  assert.equal((await get('/api/admin/household-overview',child.cookie)).response.status,404)
  assert.equal((await get('/api/households/member-access',operator)).response.status,404)
  const event={title:'Adult household event',date:'2027-02-05'}
  assert.equal((await post('/api/events',event,child.cookie)).response.status,403)
  assert.equal((await post('/api/events',event,adult.cookie)).response.status,201)
  assert.doesNotMatch(JSON.stringify((await get('/api/events',other)).content),/Adult household event/)
  assert.equal((await change(child,'permission',{action:'events.create',enabled:true})).response.status,200)
  assert.equal((await post('/api/events',{...event,title:'Granted child event'},child.cookie)).response.status,201)
  assert.equal((await change(child,'permission',{action:'events.create',enabled:false})).response.status,200)
  assert.equal((await post('/api/events',event,child.cookie)).response.status,403)
  assert.equal((await settings('/api/households/settings-lock',owner,'POST')).response.status,200)
  assert.equal((await settings('/api/households/member-access')).response.status,403)
  assert.equal((await change(child,'permission',{action:'events.create',enabled:true})).response.status,403)
  assert.equal((await settings('/api/households/members/'+child.id+'/remove',owner,'POST',{})).response.status,403)
  const oldToken=settingsToken
  const reopened=await post('/api/households/settings-unlock',{password},owner)
  assert.equal(reopened.response.status,200);settingsToken=reopened.content.token;assert.notEqual(settingsToken,oldToken)
  assert.equal((await settings('/api/households/members/'+child.id+'/remove',owner,'POST',{})).response.status,200)
  assert.notEqual((await get('/api/events',child.cookie)).response.status,200)
 }finally{await runtime.shutdown()}
})
