// Real, disposable three-family activation test. No actual accounts, ports,
// LIVE, TEST or service configuration. Only trusted in-process supervisor code
// can enroll a verified new backend; there is NO activation HTTP endpoint.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startHouseholdBrowserDemo } from './run-household-browser-demo.mjs'

function request(demo, endpoint, { cookie, body, method } = {}) {
  return fetch(demo.base + endpoint, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : {
        Origin: 'https://' + new URL(demo.base).host,
        'Content-Type': 'application/json',
      }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  })
}
async function login(demo, username, password) {
  const response = await request(demo, '/api/auth/login', {
    body: { username, password, deviceLabel: 'Disposable new-family activation fixture' },
  })
  assert.equal(response.status, 200, 'New owner must authenticate centrally')
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.match(cookie, /^__Host-fc_gateway_session=[a-f0-9]{64}$/)
  return cookie
}
async function json(response) { return { status: response.status, data: await response.json() } }

test('invited third family stays blocked until trusted live backend enrollment, then has isolated events and Lists', {
  timeout: 140000,
}, async () => {
  const demo = await startHouseholdBrowserDemo({
    enableIndependentHouseholdInvitations: true,
  })
  try {
    const admin = await login(demo, demo.accounts[0].username, demo.accounts[0].password)
    const familyB = await login(demo, demo.accounts[1].username, demo.accounts[1].password)
    const notAdmin = await request(demo, '/api/households/independent-invitations', {
      cookie: familyB, body: {},
    })
    assert.equal(notAdmin.status, 403, 'Existing household owner is not automatically gateway admin')
    const issued = await request(demo, '/api/households/independent-invitations', {
      cookie: admin, body: {},
    })
    assert.equal(issued.status, 201)
    const invitation = await issued.json()
    assert.match(invitation.token, /^[a-f0-9]{64}$/)
    const username = 'activation-test-friend'
    const password = 'Synthetic-Activation-Only-Password-2026!'
    const signup = await request(demo, '/api/households/create-from-invitation', {
      body: {
        token: invitation.token, username, password,
        displayName: 'Friend Owner', householdName: 'Independent Friend Family',
      },
    })
    assert.equal(signup.status, 201)
    assert.equal((await signup.json()).activation, 'pending')
    assert.equal(signup.headers.get('set-cookie'), null)
    const friend = await login(demo, username, password)
    const households = await json(await request(demo, '/api/households', { cookie: friend }))
    assert.equal(households.status, 200)
    assert.equal(households.data.households.length, 1)
    const householdId = households.data.households[0].householdId
    assert.match(householdId, /^family-[a-f0-9]{24}$/)
    assert.equal(households.data.households[0].role, 'owner')
    assert.equal((await request(demo, '/api/events', { cookie: friend })).status, 503,
      'A newly registered but unenrolled family remains unavailable')
    assert.equal((await request(demo, '/api/lists', { cookie: friend })).status, 503)
    assert.equal((await request(demo, '/api/households/activate', {
      cookie: admin, body: { householdId, port: 12345 },
    })).status, 404, 'No activation HTTP route may exist')

    const pending = await demo.startPendingHouseholdBackend(householdId)
    assert.notEqual(pending.port, demo.privateBackendPorts['family-a'])
    assert.notEqual(pending.port, demo.privateBackendPorts['family-b'])
    assert.equal((await fetch('http://127.0.0.1:' + pending.port + '/api/events')).status, 403,
      'Direct local access without the private secret is refused')
    await assert.rejects(demo.enrollHouseholdBackend({
      ...pending, upstreamToken: 'a'.repeat(64),
    }), /unverified household backend/, 'Wrong service secret must fail closed')
    assert.equal((await request(demo, '/api/events', { cookie: friend })).status, 503)
    await assert.rejects(demo.enrollHouseholdBackend({
      ...pending, port: demo.privateBackendPorts['family-a'],
    }), /already in use/, 'Cannot bind a new family to an existing backend port')
    await assert.rejects(demo.enrollHouseholdBackend({
      ...pending, householdId: 'family-nonexistent',
    }), /ENOENT|not provisioned|registry|missing/i, 'Unregistered family cannot be enrolled')
    assert.equal((await request(demo, '/api/events', { cookie: friend })).status, 503)

    assert.deepEqual(await demo.enrollHouseholdBackend(pending), {
      householdId, activation: 'active',
    })
    await assert.rejects(demo.enrollHouseholdBackend(pending), /already enrolled/)
    const empty = await json(await request(demo, '/api/events', { cookie: friend }))
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.data, [])
    const created = await request(demo, '/api/events', {
      cookie: friend,
      body: { date: '2026-12-29', title: 'FRIEND ONLY PRIVATE EVENT', time: '16:30' },
    })
    assert.equal(created.status, 201)
    const listMade = await request(demo, '/api/lists', {
      cookie: friend, body: { name: 'Friend private list' },
    })
    assert.equal(listMade.status, 201)
    const friendLists = await json(await request(demo, '/api/lists', { cookie: friend }))
    assert.equal(friendLists.status, 200)
    assert.deepEqual(friendLists.data.map(list => list.name), ['Friend private list'])
    const after = await json(await request(demo, '/api/events', { cookie: friend }))
    assert.deepEqual(after.data.map(x => x.title), ['FRIEND ONLY PRIVATE EVENT'])
    const familyAEvents = await json(await request(demo, '/api/events', { cookie: admin }))
    const familyBEvents = await json(await request(demo, '/api/events', { cookie: familyB }))
    assert.equal(familyAEvents.status, 200)
    assert.equal(familyBEvents.status, 200)
    assert(!familyAEvents.data.some(x => x.title === 'FRIEND ONLY PRIVATE EVENT'))
    assert(!familyBEvents.data.some(x => x.title === 'FRIEND ONLY PRIVATE EVENT'))
    const familyALists = await json(await request(demo, '/api/lists', { cookie: admin }))
    const familyBLists = await json(await request(demo, '/api/lists', { cookie: familyB }))
    assert(!familyALists.data.some(x => x.name === 'Friend private list'))
    assert(!familyBLists.data.some(x => x.name === 'Friend private list'))
    const forged = await json(await request(demo,
      '/api/events?householdId=family-a', { cookie: friend }))
    assert.deepEqual(forged.data.map(x => x.title), ['FRIEND ONLY PRIVATE EVENT'])
    assert.equal((await request(demo, '/api/internal/household-binding', {
      cookie: friend,
    })).status, 404)
    // A second, newly registered family must NEVER become active merely
    // because its records exist when the server reboots.
    const issuedPending = await request(demo, '/api/households/independent-invitations', {
      cookie: admin, body: {},
    })
    assert.equal(issuedPending.status, 201)
    const secondToken = (await issuedPending.json()).token
    const waitUser = 'unactivated-friend'
    const waitPassword = 'Synthetic-Pending-Friend-Password-2026!'
    const waitSignup = await request(demo, '/api/households/create-from-invitation', {
      body: {
        token: secondToken, username: waitUser, password: waitPassword,
        displayName: 'Waiting Owner', householdName: 'Waiting Independent Family',
      },
    })
    assert.equal(waitSignup.status, 201)
    const waitCookie = await login(demo, waitUser, waitPassword)
    assert.equal((await request(demo, '/api/events', { cookie: waitCookie })).status, 503)

    const restored = await demo.restartApprovedBackendsAndGateway()
    assert.deepEqual(restored.activeHouseholdIds.slice(0, 2), ['family-a', 'family-b'])
    assert.deepEqual(restored.activeHouseholdIds.slice(2), [householdId])
    assert.notEqual(demo.privateBackendPorts[householdId], pending.port,
      'Restart rotates private backend listeners')
    assert.equal((await request(demo, '/api/events', { cookie: waitCookie })).status, 503,
      'Registration without explicit operator activation must survive reboot as pending')
    assert.equal((await request(demo, '/api/households/activate', {
      cookie: admin, body: { householdId },
    })).status, 404, 'Restart must not create a public activation endpoint')
    assert.deepEqual((await json(await request(demo, '/api/events', {
      cookie: friend,
    }))).data.map(x => x.title), ['FRIEND ONLY PRIVATE EVENT'],
    'Third household events survive actual backend and gateway restart')
    assert.deepEqual((await json(await request(demo, '/api/lists', {
      cookie: friend,
    }))).data.map(x => x.name), ['Friend private list'],
    'Third household Lists survive backend and gateway restart')
    assert.equal((await request(demo, '/api/events', { cookie: admin })).status, 200)
    assert.equal((await request(demo, '/api/events', { cookie: familyB })).status, 200)

    console.log('[PASS] Approved family survives real private gateway/backend restart with events and Lists.')
    console.log('[PASS] Second registered-but-unapproved family stays offline after restart.')
    console.log('[PASS] Real third-family invite -> account -> 503 pending -> trusted backend -> events + Lists.')
    console.log('[PASS] Wrong token, duplicate port, unregistered ID and browser activation blocked.')
    console.log('[PASS] Existing Family A and Family B remained private and functional.')
  } finally {
    await demo.close()
  }
})
