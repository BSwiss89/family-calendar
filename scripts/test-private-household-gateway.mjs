// End-to-end PRIVATE TEST HARNESS: one central login + household permissions,
// two real isolated Node backends, a loopback-only gateway, no public listeners.
// All files and DBs live in a disposable OS temp folder; production is untouched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:net'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startPrivateHouseholdGateway } from '../Server/private-household-gateway.mjs'
import { installPrivateEventIdentity } from '../Server/private-event-identity.mjs'
import { installPrivateEventSourceOutbox } from '../Server/private-event-source-outbox.mjs'
import { setPrivateLocalAiMonthlyLimit } from '../Server/private-local-ai-budget.mjs'
import {
  markEventShareSyncPending, countPendingEventShareSync,
  countUnresolvedEventShareSync,
} from '../Server/event-share-sync-journal.mjs'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'
import {
  createHouseholdMembershipTables,
  registerHousehold,
  grantHouseholdMembership,
} from '../Server/household-memberships.mjs'
import { setFamilyAccount } from '../Server/family-auth.mjs'
import {
  createEventShareTables, registerTrustedShareConnection,
  inviteSelectedEvents, respondToEventInvitation,
} from '../Server/event-only-shares.mjs'

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Server')
const entry = path.join(serverDirectory, 'index.mjs')
const forbiddenPorts = new Set([3001, 13001, 13002, 13003, 11434])
const testPassword = 'Strong-Only-For-Disposable-Gateway-Tests!'

async function randomPort(used) {
  for (let i = 0; i < 30; i++) {
    const server = createServer()
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })
    await new Promise(resolve => server.close(resolve))
    if (port > 1023 && !forbiddenPorts.has(port) && !used.has(port)) {
      used.add(port)
      return port
    }
  }
  throw new Error('Could not find a safe random local port.')
}

function startBackend(storageRoot, id, port, serviceToken) {
  const child = spawn(process.execPath, [entry], {
    cwd: path.dirname(serverDirectory),
    env: {
      ...process.env,
      FAMILY_CALENDAR_HOST: '127.0.0.1',
      FAMILY_CALENDAR_PORT: String(port),
      FAMILY_CALENDAR_AUTH_MODE: 'disabled',
      FAMILY_CALENDAR_HOUSEHOLD_STORAGE_ROOT: storageRoot,
      FAMILY_CALENDAR_HOUSEHOLD_ID: id,
      FAMILY_CALENDAR_HOUSEHOLD_TEST_ONLY: 'YES',
      FAMILY_CALENDAR_PRIVATE_UPSTREAM_TOKEN: serviceToken,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let recent = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', bytes => {
      recent = (recent + bytes.toString('utf8')).slice(-3500)
    })
  }
  return { child, base: 'http://127.0.0.1:' + port, serviceToken, logs: () => recent }
}

async function waitForBackend(backend) {
  for (let i = 0; i < 60; i++) {
    if (backend.child.exitCode !== null || backend.child.signalCode !== null) break
    try {
      const response = await fetch(backend.base + '/api/health', {
        headers: { 'x-family-calendar-upstream-token': backend.serviceToken },
        signal: AbortSignal.timeout(1000),
      })
      if (response.ok && (await response.json()).status === 'ok') return
    } catch { /* Node is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Private backend startup failed: ' + backend.logs())
}

async function stopBackend(backend) {
  if (!backend || backend.child.exitCode !== null || backend.child.signalCode !== null) return
  const child = backend.child
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill()
  const clean = await Promise.race([
    exited.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 6000)),
  ])
  assert.equal(clean, true, 'Private backend refused to stop.')
}

async function json(base, endpoint, {
  cookie = null, body = undefined, headers = {}, method = undefined,
} = {}) {
  const hasBody = body !== undefined
  const httpMethod = method ?? (hasBody ? 'POST' : 'GET')
  const response = await fetch(base + endpoint, {
    method: httpMethod,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(httpMethod !== 'GET' && httpMethod !== 'HEAD' ? {
        Origin: 'https://' + new URL(base).host,
      } : {}),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: hasBody ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(7000),
    redirect: 'manual',
  })
  let value = null
  if (response.headers.get('content-type')?.includes('application/json')) {
    value = await response.json()
  } else {
    value = await response.text()
  }
  return { response, value }
}

async function login(base, username) {
  const result = await json(base, '/api/auth/login', {
    body: { username, password: testPassword, deviceLabel: 'Disposable gateway test' },
  })
  assert.equal(result.response.status, 200, 'Login for ' + username)
  const cookie = result.response.headers.get('set-cookie')
  assert.match(cookie, /__Host-fc_gateway_session=[a-f0-9]{64}/)
  assert.match(cookie, /Secure/)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  return cookie.split(';')[0]
}

test('central authenticated gateway denies one family access to another family by API, list, image or crafted tenant selector', {
  timeout: 60000,
}, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-private-gateway-'))
  const storageRoot = path.join(work, 'household-storage')
  fs.mkdirSync(storageRoot)
  const central = new DatabaseSync(path.join(work, 'central-identity.db'))
  let gateway = null
  const backends = []
  try {
    const a = provisionEmptyHousehold({ serverDirectory, storageRoot, householdId: 'family-a' })
    const b = provisionEmptyHousehold({ serverDirectory, storageRoot, householdId: 'family-b' })
    createHouseholdMembershipTables(central)
    setFamilyAccount(central, 'familyadmina', 'Family A admin', testPassword)
    setFamilyAccount(central, 'familyadminb', 'Family B admin', testPassword)
    setFamilyAccount(central, 'familymembera', 'Family A member', testPassword)
    registerHousehold(central, { householdId: 'family-a', displayName: 'Family A' })
    registerHousehold(central, { householdId: 'family-b', displayName: 'Family B' })
    createEventShareTables(central)
    registerTrustedShareConnection(central, {
      sourceHouseholdId: 'family-a', recipientHouseholdId: 'family-b',
    })
    const idA = central.prepare('SELECT id FROM family_users WHERE username = ?').get('familyadmina').id
    const idB = central.prepare('SELECT id FROM family_users WHERE username = ?').get('familyadminb').id
    const memberId = central.prepare('SELECT id FROM family_users WHERE username = ?').get('familymembera').id
    grantHouseholdMembership(central, { serverVerifiedUserId: idA, householdId: 'family-a', role: 'owner' })
    grantHouseholdMembership(central, { serverVerifiedUserId: idB, householdId: 'family-b', role: 'owner' })
    grantHouseholdMembership(central, { serverVerifiedUserId: memberId, householdId: 'family-a', role: 'member' })

    const backendTokens = {
      'family-a': randomBytes(32).toString('hex'),
      'family-b': randomBytes(32).toString('hex'),
    }
    const usedPorts = new Set()
    const portA = await randomPort(usedPorts)
    const portB = await randomPort(usedPorts)
    backends.push(startBackend(storageRoot, 'family-a', portA, backendTokens['family-a']))
    backends.push(startBackend(storageRoot, 'family-b', portB, backendTokens['family-b']))
    await Promise.all(backends.map(waitForBackend))

    // Wrong-but-valid tokens combined with swapped backend ports must NOT
    // route Family A through Family B's service, even on localhost.
    await assert.rejects(startPrivateHouseholdGateway({
      identityDatabase: central, serverDirectory, storageRoot,
      backendPorts: { 'family-a': portB, 'family-b': portA },
      backendTokens: {
        'family-a': backendTokens['family-b'],
        'family-b': backendTokens['family-a'],
      },
    }), /Private gateway refused unverified household backend: family-a/)

    // Even a process on localhost must not bypass the central gateway or
    // reuse the other household's private service credential.
    for (const backend of backends) {
      assert.equal((await fetch(backend.base + '/api/events')).status, 403)
      assert.equal((await fetch(backend.base + '/api/health')).status, 403)
      assert.equal((await fetch(backend.base + '/uploads/private.jpg')).status, 403)
      const wrong = backend === backends[0]
        ? backendTokens['family-b'] : backendTokens['family-a']
      assert.equal((await fetch(backend.base + '/api/events', {
        headers: { 'x-family-calendar-upstream-token': wrong },
      })).status, 403)
    }

    gateway = await startPrivateHouseholdGateway({
      identityDatabase: central,
      serverDirectory,
      storageRoot,
      backendPorts: { 'family-a': portA, 'family-b': portB },
      backendTokens,
    })
    // A second gateway (same central and household DBs) must not open a
    // listener, even with valid credentials and correct backend bindings.
    await assert.rejects(startPrivateHouseholdGateway({
      identityDatabase: central, serverDirectory, storageRoot,
      backendPorts: { 'family-a': portA, 'family-b': portB },
      backendTokens,
    }), /writer lock already exists/)
    assert.equal(new URL(gateway.base).hostname, '127.0.0.1')
    assert.equal(forbiddenPorts.has(gateway.port), false)

    const unauthEvents = await json(gateway.base, '/api/events')
    assert.equal(unauthEvents.response.status, 401)
    for (const route of [
      '/api/shared-events/recipients', '/api/shared-events/invitations',
      '/api/shared-events/accepted', '/api/shared-events/sent',
    ]) {
      assert.equal((await json(gateway.base, route)).response.status, 401)
    }
    assert.equal((await json(gateway.base, '/api/shared-events/invite', {
      body: { eventIds: [1], recipientHouseholdIds: ['family-b'] },
    })).response.status, 401)
    assert.equal((await json(gateway.base, '/api/households')).response.status, 401)
    assert.equal((await json(gateway.base, '/api/households/select', {
      body: { householdId: 'family-a' },
    })).response.status, 401)
    assert.doesNotMatch(JSON.stringify(unauthEvents.value), /family [AB]/i)
    for (const route of ['/', '/uploads/private.jpg']) {
      const response = await fetch(gateway.base + route, { redirect: 'manual' })
      assert.equal(response.status, 303, route + ' should redirect unauthenticated browser')
      assert.equal(response.headers.get('location'), '/login')
    }
    const loginUi = await fetch(gateway.base + '/login')
    assert.equal(loginUi.status, 200)
    assert.match(await loginUi.text(), /Family Calendar/)
    const health = await json(gateway.base, '/api/health')
    assert.equal(health.response.status, 200)
    assert.equal(health.value.status, 'ok')
    const fakeOrigin = await json(gateway.base, '/api/auth/login', {
      body: { username: 'familyadmina', password: testPassword },
      headers: { Origin: 'https://evil.example' },
    })
    assert.equal(fakeOrigin.response.status, 403)

    const cookieA = await login(gateway.base, 'familyadmina')
    // These are the actual LIVE and TEST cookie names on the same hostname.
    // Neither must authenticate a private gateway request, even if supplied.
    for (const name of ['__Host-fc_live_session', '__Host-fc_test_session',
      '__Host-fc_session']) {
      const liveOrTestCookie = cookieA.replace('__Host-fc_gateway_session', name)
      const result = await json(gateway.base, '/api/households', {
        cookie: liveOrTestCookie,
      })
      assert.equal(result.response.status, 401, name + ' must not be accepted')
    }

    const cookieB = await login(gateway.base, 'familyadminb')
    assert.equal((await json(gateway.base, '/api/auth/status', { cookie: cookieA })).value.authenticated, true)
    assert.equal((await json(gateway.base, '/api/auth/status', { cookie: cookieB })).value.authenticated, true)
    assert.equal((await json(gateway.base, '/api/auth/status', { cookie: cookieA })).value.username, 'familyadmina')
    assert.equal((await json(gateway.base, '/api/auth/status', { cookie: cookieB })).value.username, 'familyadminb')

    // Invitation gateway security, scoped to the verified account's household.
    // Member removal and member directory are deliberately separate tasks.
    const invitePath = '/api/households/member-invitations'
    const cookieMember = await login(gateway.base, 'familymembera')
    assert.equal((await json(gateway.base, invitePath)).response.status, 401)
    assert.equal((await json(gateway.base, invitePath, { method: 'POST' })).response.status, 401)
    assert.equal((await json(gateway.base, invitePath, { cookie: cookieMember })).response.status, 403)
    assert.equal((await json(gateway.base, invitePath, {
      cookie: cookieMember, method: 'POST',
    })).response.status, 403)
    assert.equal((await json(gateway.base, invitePath, {
      cookie: cookieA, method: 'POST', headers: { Origin: 'https://evil.example' },
    })).response.status, 403)
    const issued = await json(gateway.base, invitePath, {
      cookie: cookieA, method: 'POST',
      headers: { 'x-household-id': 'family-b' },
    })
    assert.equal(issued.response.status, 201)
    assert.equal(issued.response.headers.get('cache-control'), 'no-store')
    assert.match(issued.value.token, /^[a-f0-9]{64}$/)
    const pendingA = await json(gateway.base, invitePath, { cookie: cookieA })
    const pendingB = await json(gateway.base, invitePath, { cookie: cookieB })
    assert.equal(pendingA.response.status, 200)
    assert.equal(pendingA.response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(pendingA.value.invitations.map(i => i.id), [issued.value.invitationId])
    assert.equal(JSON.stringify(pendingA.value).includes(issued.value.token), false)
    assert.equal(pendingB.response.status, 200)
    assert.deepEqual(pendingB.value.invitations, [])
    assert.equal((await json(gateway.base, invitePath + '/abc/revoke', {
      cookie: cookieA, method: 'POST',
    })).response.status, 400)
    assert.equal((await json(gateway.base, invitePath + '/' + issued.value.invitationId + '/revoke', {
      cookie: cookieMember, method: 'POST',
    })).response.status, 403)
    assert.equal((await json(gateway.base, invitePath + '/' + issued.value.invitationId + '/revoke', {
      cookie: cookieB, method: 'POST',
    })).response.status, 404)
    assert.equal((await json(gateway.base, invitePath + '/' + issued.value.invitationId + '/revoke', {
      cookie: cookieA, method: 'POST',
    })).response.status, 200)
    assert.deepEqual((await json(gateway.base, invitePath, {
      cookie: cookieA,
    })).value.invitations, [])
    assert.equal((await json(gateway.base, invitePath + '/' + issued.value.invitationId + '/revoke', {
      cookie: cookieA, method: 'POST',
    })).response.status, 404)

    // A roster is scoped to the verified owner and omits secret fields.
    const rosterPath = '/api/households/members'
    assert.equal((await json(gateway.base, rosterPath)).response.status, 401)
    assert.equal((await json(gateway.base, rosterPath, {
      cookie: cookieMember,
    })).response.status, 403)
    const rosterA = await json(gateway.base, rosterPath, {
      cookie: cookieA, headers: { 'x-household-id': 'family-b' },
    })
    const rosterB = await json(gateway.base, rosterPath, { cookie: cookieB })
    assert.equal(rosterA.response.status, 200)
    assert.equal(rosterA.response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(rosterA.value.members.map(m => m.username),
      ['familyadmina', 'familymembera'])
    assert.deepEqual(rosterB.value.members.map(m => m.username), ['familyadminb'])
    assert.deepEqual(rosterA.value.members.map(m => m.role), ['owner', 'member'])
    assert.equal(/password|token|session/i.test(JSON.stringify(rosterA.value)), false)

    // Only the one-time invite authorizes anonymous signup, not the supplied
    // URL, a forged tenant header, cookie or self-selected owner role.
    const joinPage = await fetch(gateway.base + '/join')
    assert.equal(joinPage.status, 200)
    assert.match(await joinPage.text(), /Join a family calendar/)
    assert.equal(joinPage.headers.get('cache-control'), 'no-store')
    const joinScript = await fetch(gateway.base + '/auth/join.js')
    assert.equal(joinScript.status, 200)
    assert.equal((await joinScript.text()).includes('history.replaceState'), true)
    const signupIssued = await json(gateway.base, invitePath, {
      cookie: cookieA, method: 'POST',
    })
    assert.equal(signupIssued.response.status, 201)
    const invitationLink = new URL(signupIssued.value.joinUrl)
    assert.equal(invitationLink.pathname, '/join')
    assert.equal(invitationLink.search, '')
    assert.equal(invitationLink.hash, '#token=' + signupIssued.value.token)
    assert.equal(invitationLink.origin,
      'https://' + new URL(gateway.base).host)
    const signupPath = '/api/households/join'
    const registration = {
      token: signupIssued.value.token, username: 'newjoina',
      displayName: 'New Family A Member', password: testPassword,
    }
    assert.equal((await json(gateway.base, signupPath, {
      body: registration, headers: { Origin: 'https://evil.example' },
    })).response.status, 403)
    assert.equal((await json(gateway.base, signupPath, {
      body: { ...registration, householdId: 'family-b' },
    })).response.status, 400)
    assert.equal((await json(gateway.base, signupPath, {
      body: { ...registration, role: 'owner' },
    })).response.status, 400)
    assert.equal((await json(gateway.base, signupPath, {
      body: { ...registration, username: 'familyadminb' },
    })).response.status, 400)
    const successfulSignup = await json(gateway.base, signupPath, {
      body: registration,
    })
    assert.equal(successfulSignup.response.status, 201)
    assert.deepEqual(successfulSignup.value, { ok: true, next: '/login' })
    assert.equal(successfulSignup.response.headers.get('set-cookie'), null)
    assert.equal((await json(gateway.base, signupPath, {
      body: { ...registration, username: 'replayedinvite' },
    })).response.status, 400)
    const cookieNewMember = await login(gateway.base, 'newjoina')
    const newHouseholds = await json(gateway.base, '/api/households', {
      cookie: cookieNewMember,
    })
    assert.deepEqual(newHouseholds.value.households.map(h => h.householdId),
      ['family-a'])
    assert.deepEqual(newHouseholds.value.households.map(h => h.role),
      ['member'])
    assert.equal((await json(gateway.base, '/api/households/select', {
      cookie: cookieNewMember, body: { householdId: 'family-b' },
    })).response.status, 403)
    assert.equal((await json(gateway.base, invitePath, {
      cookie: cookieNewMember, method: 'POST',
    })).response.status, 403)

    // Revocation only disables the selected member grant. Other households,
    // the owner, and the underlying personal login remain untouched.
    const removeMemberPath = '/api/households/members/' + memberId + '/remove'
    assert.equal((await json(gateway.base, removeMemberPath, {
      method: 'POST',
    })).response.status, 401)
    assert.equal((await json(gateway.base, removeMemberPath, {
      cookie: cookieMember, method: 'POST',
    })).response.status, 403)
    assert.equal((await json(gateway.base, removeMemberPath, {
      cookie: cookieB, method: 'POST',
    })).response.status, 404)
    assert.equal((await json(gateway.base, removeMemberPath, {
      cookie: cookieA, method: 'POST', headers: { Origin: 'https://evil.example' },
    })).response.status, 403)
    assert.equal((await json(gateway.base, '/api/households/members/' + idA + '/remove', {
      cookie: cookieA, method: 'POST',
    })).response.status, 404)
    assert.equal((await json(gateway.base, '/api/households/members/00/remove', {
      cookie: cookieA, method: 'POST',
    })).response.status, 400)
    assert.equal((await json(gateway.base, removeMemberPath, {
      cookie: cookieA, method: 'POST',
    })).response.status, 200)
    assert.equal((await json(gateway.base, removeMemberPath, {
      cookie: cookieA, method: 'POST',
    })).response.status, 404)
    assert.deepEqual((await json(gateway.base, rosterPath, {
      cookie: cookieA,
    })).value.members.map(m => m.username), ['familyadmina', 'newjoina'])
    assert.equal((await json(gateway.base, '/api/events', {
      cookie: cookieMember,
    })).response.status, 403, 'removed member cannot access household calendar')
    assert.equal(central.prepare('SELECT disabled FROM family_users WHERE id = ?')
      .get(memberId).disabled, 0, 'member account remains active')
    // Restore the disposable test fixture, not an actual household.
    central.prepare('UPDATE household_memberships SET disabled = 0 WHERE user_id = ?')
      .run(memberId)

    // The Account UI switches by username, not by bypassing membership checks.
    // Switching to a different account requires a fresh password login.
    const accountPage = await fetch(gateway.base + '/account', {
      headers: { Cookie: cookieA }, redirect: 'manual',
    })
    assert.equal(accountPage.status, 200)
    const accountHtml = await accountPage.text()
    assert.match(accountHtml, /id="whoami"/)
    assert.match(accountHtml, /id="logout"/)
    assert.doesNotMatch(accountHtml, /id="household-switch-form"/)
    const accountJavaScript = await fetch(gateway.base + '/auth/account.js')
    assert.equal(accountJavaScript.status, 200)
    const accountScript = await accountJavaScript.text()
    assert.match(accountScript, /whoami\.textContent = 'Signed in as '/)
    assert.match(accountScript, /logout\.addEventListener\('click', async \(\) =>/)
    assert.match(accountScript, /location\.replace\('\/login'\)/)
    const householdsA = await json(gateway.base, '/api/households', { cookie: cookieA })
    const householdsB = await json(gateway.base, '/api/households', { cookie: cookieB })
    assert.deepEqual(householdsA.value.households.map(h => h.householdId), ['family-a'])
    assert.deepEqual(householdsB.value.households.map(h => h.householdId), ['family-b'])
    assert.equal(householdsA.value.selectedHouseholdId, 'family-a')
    assert.equal(householdsB.value.selectedHouseholdId, 'family-b')
    assert.equal((await json(gateway.base, '/api/households/select', {
      cookie: cookieA, body: { householdId: 'family-b' },
    })).response.status, 403)
    assert.equal((await json(gateway.base, '/api/households/select', {
      cookie: cookieA,
      body: { householdId: 'family-a' },
      headers: { Origin: 'https://evil.example' },
    })).response.status, 403)
    assert.equal((await json(gateway.base, '/api/households/unknown', {
      cookie: cookieA,
    })).response.status, 404)

    let addA = await json(gateway.base, '/api/events', {
      cookie: cookieA, body: { date: '2026-12-20', title: 'Family A private calendar', time: '12:00' },
    })
    let addB = await json(gateway.base, '/api/events', {
      cookie: cookieB, body: { date: '2026-12-21', title: 'Family B private calendar', time: '13:00' },
    })
    assert.equal(addA.response.status, 201)
    assert.equal(addB.response.status, 201)

    // The legacy backend has alternate delete/reschedule/batch routes that
    // do NOT yet write the private gateway's durable per-event journal.
    // Deny these rather than letting a browser silently desynchronize an
    // accepted invitation. Also reject noncanonical event IDs that Express
    // would parse differently than the gateway's journal.
    for (const [method, endpoint, body] of [
      ['POST', '/api/ai/cancel-confirmed', {
        eventId: addA.value.id, matchType: 'event', confirm: true,
      }],
      ['POST', '/api/ai/reschedule-confirmed', {
        eventId: addA.value.id, confirm: true, newDate: '2026-12-22',
      }],
      ['DELETE', '/api/event-batches/sample-batch', undefined],
      ['POST', '/api/events/' + addA.value.id + '/exceptions', {
        occurrenceDate: '2026-12-24',
      }],
      ['DELETE', '/api/events/0' + addA.value.id, undefined],
      ['DELETE', '/API/EVENTS/' + addA.value.id, undefined],
      ['DELETE', '/api/events/' + addA.value.id + '/', undefined],
      ['DELETE', '/api/events/%31', undefined],
      ['PUT', '/api/events/0' + addA.value.id, {
        date: '2026-12-23', title: 'MALICIOUS UNJOURNALED UPDATE',
      }],
    ]) {
      const blocked = await json(gateway.base, endpoint, {
        cookie: cookieA, method, body,
      })
      assert.equal(blocked.response.status, 409,
        method + ' ' + endpoint + ': ' + JSON.stringify(blocked.value))
    }
    assert.deepEqual((await json(gateway.base, '/api/events', {
      cookie: cookieA,
    })).value.map(event => event.title), ['Family A private calendar'])
    assert.equal(central.prepare(
      'SELECT COUNT(*) AS n FROM event_share_sync_pending'
    ).get().n, 0)
    console.log('[PASS] Alternative and noncanonical event writes cannot bypass sharing recovery.')

    const noAiAllowance = await json(gateway.base, '/api/ai/intent', {
      cookie: cookieA, body: { text: '' },
    })
    assert.equal(noAiAllowance.response.status, 429)
    const initialAi = await json(gateway.base, '/api/ai-budget', { cookie: cookieA })
    assert.equal(initialAi.response.status, 200)
    assert.equal(initialAi.value.local.monthlyRequestLimit, 0)
    assert.equal(initialAi.value.paidCloudEnabled, false)
    assert.deepEqual(initialAi.value.paid, {
      periodUtc: initialAi.value.local.periodUtc, currency: 'USD',
      monthlyLimitMicros: 0, billedMicros: 0, heldMicros: 0,
      pendingReservations: 0, remainingMicros: 0,
    })
    setPrivateLocalAiMonthlyLimit(central, {
      householdId: 'family-a', monthlyLimit: 1,
    })
    const classified = await json(gateway.base, '/api/ai/intent', {
      cookie: cookieA, body: { text: '' },
    })
    // Intent request reaches the private backend's validation, but no Ollama
    // call occurs for empty text; the attempt still costs one admission.
    assert.equal(classified.response.status, 400)
    assert.equal((await json(gateway.base, '/api/ai/intent', {
      cookie: cookieA, body: { text: '' },
    })).response.status, 429)
    const aBudget = await json(gateway.base, '/api/ai-budget', { cookie: cookieA })
    const bBudget = await json(gateway.base, '/api/ai-budget', { cookie: cookieB })
    assert.equal(aBudget.value.local.usedRequests, 1)
    assert.equal(aBudget.value.local.remainingRequests, 0)
    assert.equal(bBudget.value.local.usedRequests, 0)
    assert.equal(bBudget.value.local.monthlyRequestLimit, 0)
    assert.equal((await json(gateway.base, '/api/ai-budget')).response.status, 401)
    console.log('[PASS] Household local model requests are disabled by default and capped independently.')

    for (const endpoint of [
      '/api/ai/cancel-preview',
      '/api/ai/reschedule-preview',
      '/api/capture/analyze-photo',
      '/api/capture-inbox/1/analyze',
    ]) {
      const denied = await json(gateway.base, endpoint, {
        cookie: cookieA, body: { text: 'Find private events' },
      })
      assert.equal(denied.response.status, 409, endpoint)
    }
    const spoofedUpstream = await json(gateway.base, '/api/events', {
      cookie: cookieA,
      headers: { 'x-family-calendar-upstream-token': backendTokens['family-b'] },
    })
    assert.equal(spoofedUpstream.response.status, 200)
    assert.deepEqual(spoofedUpstream.value.map(e => e.title),
      ['Family A private calendar'])

    const eventsA = await json(gateway.base, '/api/events?household=family-b', {
      cookie: cookieA, headers: { 'X-Household-Id': 'family-b' },
    })
    const eventsB = await json(gateway.base, '/api/events?household=family-a', {
      cookie: cookieB, headers: { 'X-Household-Id': 'family-a' },
    })
    assert.equal(eventsA.response.status, 200)
    assert.equal(eventsB.response.status, 200)
    assert.deepEqual(eventsA.value.map(e => e.title), ['Family A private calendar'])
    assert.deepEqual(eventsB.value.map(e => e.title), ['Family B private calendar'])

    // Read-only Arney lookup sees this family's own events, never other
    // household metadata or private notes; no Ollama quota is consumed.
    const range = '/api/ai/calendar-lookup?from=2026-12-20&to=2026-12-24'
    const arneyA = await json(gateway.base, range + '&household=family-b', { cookie: cookieA })
    assert.equal(arneyA.response.status, 400)
    assert.equal((await json(gateway.base, range)).response.status, 401)
    const arneyOwnA = await json(gateway.base, range, { cookie: cookieA })
    const arneyOwnB = await json(gateway.base, range, { cookie: cookieB })
    assert.equal(arneyOwnA.response.status, 200)
    assert.equal(arneyOwnB.response.status, 200)
    assert.deepEqual(arneyOwnA.value.events.map(e => e.title), ['Family A private calendar'])
    assert.deepEqual(arneyOwnB.value.events.map(e => e.title), ['Family B private calendar'])
    assert.equal(arneyOwnA.value.readOnly, true)
    assert.equal((await json(gateway.base, '/api/ai/calendar-lookup?from=2026-02-30&to=2026-03-01', {
      cookie: cookieA,
    })).response.status, 400)
    assert.equal((await json(gateway.base, '/api/ai/calendar-lookup', {
      cookie: cookieA, body: { from: '2026-12-20', to: '2026-12-24' },
    })).response.status, 404)

    // Simulate clicking "Switch username": logout kills only that trusted
    // session; signing into a different username opens only its own family.
    const beforeSwitch = await login(gateway.base, 'familyadmina')
    const signOut = await json(gateway.base, '/api/auth/logout', {
      cookie: beforeSwitch, body: {},
    })
    assert.equal(signOut.response.status, 200)
    assert.equal((await json(gateway.base, '/api/events', {
      cookie: beforeSwitch,
    })).response.status, 401)
    const afterSwitch = await login(gateway.base, 'familyadminb')
    assert.deepEqual((await json(gateway.base, '/api/events', {
      cookie: afterSwitch,
    })).value.map(e => e.title), ['Family B private calendar'])
    assert.deepEqual((await json(gateway.base, '/api/events', {
      cookie: cookieA,
    })).value.map(e => e.title), ['Family A private calendar'])

    await json(gateway.base, '/api/lists', { cookie: cookieA, body: { name: 'Family A list' } })
    await json(gateway.base, '/api/lists', { cookie: cookieB, body: { name: 'Family B list' } })
    const listsA = await json(gateway.base, '/api/lists', { cookie: cookieA })
    const listsB = await json(gateway.base, '/api/lists', { cookie: cookieB })
    assert.equal(listsA.value[0].name, 'Family A list')
    assert.equal(listsB.value[0].name, 'Family B list')
    assert.equal(listsA.value.some(x => x.name === 'Family B list'), false)
    assert.equal(listsB.value.some(x => x.name === 'Family A list'), false)

    fs.writeFileSync(path.join(a.uploadFolder, 'private-shared-name.jpg'), 'ONLY family A photo bytes')
    fs.writeFileSync(path.join(b.uploadFolder, 'private-shared-name.jpg'), 'ONLY family B photo bytes')
    const imageA = await json(gateway.base, '/uploads/private-shared-name.jpg?household=family-b', {
      cookie: cookieA, headers: { 'X-Household-Id': 'family-b' },
    })
    const imageB = await json(gateway.base, '/uploads/private-shared-name.jpg?household=family-a', {
      cookie: cookieB, headers: { 'X-Household-Id': 'family-a' },
    })
    assert.equal(imageA.response.status, 200)
    assert.equal(imageB.response.status, 200)
    assert.equal(imageA.value, 'ONLY family A photo bytes')
    assert.equal(imageB.value, 'ONLY family B photo bytes')
    assert.equal(imageA.response.headers.get('set-cookie'), null)

    // Arney's preview/confirm flow is explicitly scoped to the household
    // selected by central authentication and does not need Ollama.
    const phrase = 'Hey Arney, move event "Family A private calendar" on 2026-12-20 to 2026-12-20 at 12:45'
    assert.equal((await json(gateway.base, '/api/ai/event-action-interpret', {
      body: { text: phrase },
    })).response.status, 401)
    const otherFamilyPhrase = await json(gateway.base, '/api/ai/event-action-interpret', {
      cookie: cookieB, body: { text: phrase },
    })
    assert.equal(otherFamilyPhrase.response.status, 200)
    assert.equal(otherFamilyPhrase.value.status, 'not_found')
    assert.equal((await json(gateway.base, '/api/ai/event-action-interpret', {
      cookie: cookieA, body: { text: phrase, householdId: 'family-b' },
    })).response.status, 400)
    assert.equal((await json(gateway.base, '/api/ai/event-action-interpret/', {
      cookie: cookieA, body: { text: phrase },
    })).response.status, 404)
    const privateArneyPreview = await json(gateway.base, '/api/ai/event-action-interpret', {
      cookie: cookieA, body: { text: phrase },
    })
    assert.equal(privateArneyPreview.response.status, 200)
    assert.equal(privateArneyPreview.value.status, 'ready_for_confirmation')
    assert.equal(privateArneyPreview.value.requiresConfirmation, true)
    assert.equal(privateArneyPreview.value.eventId, addA.value.id)
    assert.doesNotMatch(JSON.stringify(privateArneyPreview.value),
      /PRIVATE MEDICAL|notes|location|people/)
    const vague = await json(gateway.base, '/api/ai/event-action-interpret', {
      cookie: cookieA, body: { text: 'Cancel all my appointments' },
    })
    assert.equal(vague.value.status, 'needs_clarification')
    assert.equal((await json(gateway.base, '/api/ai/event-action-confirm', {
      cookie: cookieB, body: {
        confirm: true, previewToken: privateArneyPreview.value.previewToken,
      },
    })).response.status, 409)
    assert.equal((await json(gateway.base, '/api/ai/event-action-confirm', {
      cookie: cookieA, body: {
        confirm: false, previewToken: privateArneyPreview.value.previewToken,
      },
    })).response.status, 400)
    const confirmedArney = await json(gateway.base, '/api/ai/event-action-confirm', {
      cookie: cookieA, body: {
        confirm: true, previewToken: privateArneyPreview.value.previewToken,
      },
    })
    assert.equal(confirmedArney.response.status, 200, JSON.stringify(confirmedArney.value))
    assert.equal(confirmedArney.value.action, 'reschedule')
    assert.equal((await json(gateway.base, '/api/events', {
      cookie: cookieA,
    })).value.find(e => e.id === addA.value.id).time, '12:45')
    assert.equal(central.prepare('SELECT COUNT(*) n FROM event_share_sync_pending').get().n, 0)
    assert.equal((await json(gateway.base, '/api/ai/event-action-confirm', {
      cookie: cookieA, body: {
        confirm: true, previewToken: privateArneyPreview.value.previewToken,
      },
    })).response.status, 409)
    assert.equal((await json(gateway.base, '/api/ai/event-action-preview', {
      cookie: cookieB, body: { action: 'cancel', eventId: addA.value.id },
    })).response.status, 200)
    assert.equal((await json(gateway.base, '/api/ai/event-action-preview', {
      cookie: cookieA, body: { action: 'cancel', eventId: addA.value.id,
        householdId: 'family-b' },
    })).response.status, 400)

    // A can share ONE handpicked event with connected B, but never A's
    // entire calendar or a private second event. B must explicitly accept.
    const privateA = await json(gateway.base, '/api/events', {
      cookie: cookieA,
      body: {
        date: '2026-12-23', title: 'A SECRET APPOINTMENT',
        time: '10:00', notes: 'PRIVATE MEDICAL NOTE',
      },
    })
    assert.equal(privateA.response.status, 201)
    const idToShare = eventsA.value[0].id
    assert.equal(Number.isSafeInteger(idToShare), true)
    assert.equal((await json(gateway.base, '/api/shared-events/recipients', {
      cookie: cookieA,
    })).value.recipients[0].householdId, 'family-b')
    assert.deepEqual((await json(gateway.base, '/api/shared-events/recipients', {
      cookie: cookieB,
    })).value.recipients, [])
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events, [])

    assert.deepEqual((await json(gateway.base, '/api/shared-events/sent', {
      cookie: cookieA,
    })).value.shares, [])
    assert.deepEqual((await json(gateway.base, '/api/shared-events/sent', {
      cookie: cookieB,
    })).value.shares, [])

    const invalidSelection = await json(gateway.base, '/api/shared-events/invite', {
      cookie: cookieA, body: { eventIds: ['*'], recipientHouseholdIds: ['family-b'] },
    })
    assert.equal(invalidSelection.response.status, 400)
    const invalidRecipient = await json(gateway.base, '/api/shared-events/invite', {
      cookie: cookieA, body: { eventIds: [idToShare], recipientHouseholdIds: ['family-c'] },
    })
    assert.equal(invalidRecipient.response.status, 400)
    assert.equal((await json(gateway.base, '/api/shared-events/invitations', {
      cookie: cookieB,
    })).value.invitations.length, 0)

    const shared = await json(gateway.base, '/api/shared-events/invite', {
      cookie: cookieA,
      body: { eventIds: [idToShare], recipientHouseholdIds: ['family-b'] },
    })
    assert.equal(shared.response.status, 201, JSON.stringify(shared.value))
    const sharedId = shared.value.invitations[0].shareId
    assert.ok(Number.isSafeInteger(sharedId))
    const sentFromA = await json(gateway.base, '/api/shared-events/sent', {
      cookie: cookieA,
    })
    assert.equal(sentFromA.response.status, 200)
    assert.deepEqual(sentFromA.value.shares.map(share => share.title), [
      'Family A private calendar',
    ])
    assert.equal(sentFromA.value.shares[0].recipientHouseholdId, 'family-b')
    assert.equal(sentFromA.value.shares[0].status, 'pending')
    assert.deepEqual((await json(gateway.base, '/api/shared-events/sent', {
      cookie: cookieB,
    })).value.shares, [])
    assert.equal((await json(gateway.base, '/api/shared-events/invitations', {
      cookie: cookieA,
    })).value.invitations.length, 0)
    const invitationB = await json(gateway.base, '/api/shared-events/invitations', {
      cookie: cookieB,
    })
    assert.equal(invitationB.value.invitations.length, 1)
    assert.equal(invitationB.value.invitations[0].title, 'Family A private calendar')
    assert.equal(invitationB.value.invitations[0].sharedBy, 'Family A')
    assert.doesNotMatch(JSON.stringify(invitationB.value), /SECRET|PRIVATE MEDICAL|HOME ADDRESS/)

    // Wrong family and guessed IDs must never let A accept B's invitation.
    assert.equal((await json(gateway.base, '/api/shared-events/' + sharedId + '/respond', {
      cookie: cookieA, body: { decision: 'accepted' },
    })).response.status, 404)
    assert.equal((await json(gateway.base, '/api/shared-events/' + sharedId + '/respond', {
      cookie: cookieB, body: { decision: 'accepted' },
      headers: { Origin: 'https://evil.example' },
    })).response.status, 403)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events, [])
    const accepted = await json(gateway.base, '/api/shared-events/' + sharedId + '/respond', {
      cookie: cookieB, body: { decision: 'accepted' },
    })
    assert.equal(accepted.response.status, 200)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/sent', {
      cookie: cookieA,
    })).value.shares.map(share => share.status), ['accepted'])
    const approved = await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })
    assert.deepEqual(approved.value.events.map(e => e.title), ['Family A private calendar'])
    const arneyShared = await json(gateway.base,
      '/api/ai/calendar-lookup?from=2026-12-20&to=2026-12-24', { cookie: cookieB })
    assert.equal(arneyShared.response.status, 200)
    assert.deepEqual(arneyShared.value.events.map(e => e.title),
      ['Family A private calendar', 'Family B private calendar'])
    assert.equal(arneyShared.value.events[0].source, 'accepted_invitation')
    assert.equal(arneyShared.value.events[0].sharedBy, 'Family A')
    assert.doesNotMatch(JSON.stringify(arneyShared.value),
      /SECRET|PRIVATE MEDICAL|HOME ADDRESS|location|notes|person|sourceEventId/)
    // Neither a pending nor an accepted event permits duplicate invitations.
    const blockedReminder = await json(gateway.base, '/api/shared-events/invite', {
      cookie: cookieA, body: { eventIds: [idToShare], recipientHouseholdIds: ['family-b'] },
    })
    assert.equal(blockedReminder.response.status, 409)
    const blockedConfirmedReminder = await json(gateway.base, '/api/shared-events/invite', {
      cookie: cookieA, body: { eventIds: [idToShare], recipientHouseholdIds: ['family-b'], allowResend: true },
    })
    assert.equal(blockedConfirmedReminder.response.status, 409)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events.map(event => event.shareId), [sharedId])
    assert.deepEqual((await json(gateway.base, '/api/shared-events/invitations', {
      cookie: cookieB,
    })).value.invitations, [])
    assert.doesNotMatch(JSON.stringify(approved.value), /SECRET|PRIVATE MEDICAL|location|notes|person/)
    assert.deepEqual((await json(gateway.base, '/api/events', {
      cookie: cookieB,
    })).value.map(e => e.title), ['Family B private calendar'])

    // Confirmed Arney reschedules propagate into B's accepted shared copy.
    const sharedArneyPreview = await json(gateway.base,
      '/api/ai/event-action-preview', {
        cookie: cookieA, body: {
          action: 'reschedule', eventId: idToShare, newTime: '14:20',
        },
      })
    assert.equal(sharedArneyPreview.response.status, 200)
    assert.equal((await json(gateway.base, '/api/ai/event-action-confirm', {
      cookie: cookieA, body: {
        confirm: true, previewToken: sharedArneyPreview.value.previewToken,
      },
    })).response.status, 200)
    const syncedArney = await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })
    assert.equal(syncedArney.response.status, 200)
    assert.equal(syncedArney.value.events[0].time, '14:20')
    assert.doesNotMatch(JSON.stringify(syncedArney.value),
      /PRIVATE MEDICAL|notes|location|people/)
    assert.equal(central.prepare('SELECT COUNT(*) n FROM event_share_sync_pending').get().n, 0)

    // Source SQLite triggers catch an AI-style update even when it bypasses
    // ordinary PUT /api/events/:id. Read-time delivery updates only the
    // existing, explicitly accepted invitation and leaves other fields private.
    const outOfBand = new DatabaseSync(a.databasePath)
    try {
      outOfBand.prepare('UPDATE events SET title=?,time=? WHERE id=?')
        .run('AI MOVED FAMILY A SHARED EVENT', '15:15', idToShare)
      assert.ok(outOfBand.prepare(
        'SELECT revision FROM event_source_share_outbox WHERE source_event_id=?'
      ).get(idToShare).revision > 0)
    } finally { outOfBand.close() }
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events.map(e => [e.title, e.time]),
    [['AI MOVED FAMILY A SHARED EVENT', '15:15']])
    const restored = new DatabaseSync(a.databasePath)
    try {
      restored.prepare('UPDATE events SET title=?,time=? WHERE id=?')
        .run('Family A private calendar', '12:00', idToShare)
    } finally { restored.close() }
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events.map(e => e.title), ['Family A private calendar'])
    console.log('[PASS] Source SQLite outbox catches direct AI-style event updates.')

    // Simulate a real household backend committing an event change and the
    // authenticated gateway process dying BEFORE its old after-response hook.
    // The write-ahead intent was persisted in central SQLite first.
    assert.equal(markEventShareSyncPending(central, {
      sourceHouseholdId: 'family-a', sourceEventId: idToShare,
    }), 1)
    const directCommitted = await json(backends[0].base,
      '/api/events/' + idToShare, {
        method: 'PUT',
        headers: { 'x-family-calendar-upstream-token': backendTokens['family-a'] },
        body: {
          title: 'Family A updated during interrupted gateway',
          date: '2026-12-20', time: '14:45',
        },
      })
    assert.equal(directCommitted.response.status, 200,
      JSON.stringify(directCommitted.value))
    assert.equal(countPendingEventShareSync(central), 1)
    assert.equal(central.prepare(
      'SELECT title FROM event_share_grants WHERE id=?'
    ).get(sharedId).title, 'Family A private calendar')

    {
      const closingGateway = gateway
      gateway = null // Preserve the first failure; avoid a second close in finally.
      await closingGateway.close()
    }
    assert.equal(fs.existsSync(path.join(storageRoot,
      '.family-calendar-private-gateway-writer.lock')), false,
    'cleanly stopped gateway must release its exclusive lock')
    gateway = await startPrivateHouseholdGateway({
      identityDatabase: central, serverDirectory, storageRoot,
      backendPorts: { 'family-a': portA, 'family-b': portB },
      backendTokens,
    })
    // Before opening a listener, the new process reconciles persisted work.
    assert.equal(countPendingEventShareSync(central), 0)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events.map(x => [x.title, x.time]),
    [['Family A updated during interrupted gateway', '14:45']])
    assert.equal((await json(gateway.base, '/api/events/' + idToShare, {
      cookie: cookieA, method: 'PUT',
      body: {
        title: 'Family A private calendar', date: '2026-12-20', time: '12:00',
      },
    })).response.status, 200)
    assert.equal(countPendingEventShareSync(central), 0)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events.map(x => x.title), ['Family A private calendar'])

    // Repeat with a running gateway: a read of the accepted overlay should
    // repair an interrupted source edit, not return stale family data.
    markEventShareSyncPending(central, {
      sourceHouseholdId: 'family-a', sourceEventId: idToShare,
    })
    assert.equal((await json(backends[0].base, '/api/events/' + idToShare, {
      method: 'PUT',
      headers: { 'x-family-calendar-upstream-token': backendTokens['family-a'] },
      body: { title: 'Read-time recovery', date: '2026-12-20', time: '13:00' },
    })).response.status, 200)
    assert.equal(countPendingEventShareSync(central), 1)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events.map(x => x.title), ['Read-time recovery'])
    assert.equal(countPendingEventShareSync(central), 0)
    assert.equal((await json(gateway.base, '/api/events/' + idToShare, {
      cookie: cookieA, method: 'PUT',
      body: {
        title: 'Family A private calendar', date: '2026-12-20', time: '12:00',
      },
    })).response.status, 200)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events.map(x => x.title), ['Family A private calendar'])
    assert.equal(countPendingEventShareSync(central), 0)

    // Crash recovery must drain MORE than a single 100-event batch, not fail
    // startup and strand subsequent family updates. These are synthetic IDs
    // absent from the disposable source DB, so replay cancels nothing.
    for (let sourceEventId = 10000; sourceEventId < 10205; sourceEventId++) {
      markEventShareSyncPending(central, {
        sourceHouseholdId: 'family-a', sourceEventId,
      })
    }
    assert.equal(countPendingEventShareSync(central), 205)
    {
      const closingGateway = gateway
      gateway = null // Preserve the first failure; avoid a second close in finally.
      await closingGateway.close()
    }
    assert.equal(fs.existsSync(path.join(storageRoot,
      '.family-calendar-private-gateway-writer.lock')), false,
    'cleanly stopped gateway must release its exclusive lock')
    gateway = await startPrivateHouseholdGateway({
      identityDatabase: central, serverDirectory, storageRoot,
      backendPorts: { 'family-a': portA, 'family-b': portB },
      backendTokens,
    })
    assert.equal(countPendingEventShareSync(central), 0)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events.map(event => event.title), ['Family A private calendar'])

    // A failed edit, or a CSRF attack, must NOT synchronize anything to B.
    assert.equal((await json(gateway.base, '/api/events/' + idToShare, {
      cookie: cookieA, method: 'PUT', body: {
        date: 'bad', title: 'Private invalid update',
      },
    })).response.status, 400)
    assert.equal((await json(gateway.base, '/api/events/' + idToShare, {
      cookie: cookieA, method: 'PUT',
      headers: { Origin: 'https://evil.example' },
      body: { date: '2026-12-22', title: 'Malicious update' },
    })).response.status, 403)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events.map(e => e.title), ['Family A private calendar'])
    assert.equal(countPendingEventShareSync(central), 0)

    // A real successful backend PUT automatically refreshes only the shared
    // snapshot. Changed notes, locations, people and other events stay private.
    const edited = await json(gateway.base, '/api/events/' + idToShare, {
      cookie: cookieA, method: 'PUT',
      body: {
        date: '2026-12-24', title: 'Family A BBQ time changed',
        time: '15:30', notes: 'CHANGED PRIVATE INFORMATION',
        location: 'HIDDEN PRIVATE ADDRESS',
      },
    })
    assert.equal(edited.response.status, 200, JSON.stringify(edited.value))
    const updatedShared = await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })
    assert.equal(updatedShared.response.status, 200)
    assert.equal(updatedShared.value.events.length, 1)
    assert.equal(updatedShared.value.events[0].title, 'Family A BBQ time changed')
    assert.equal(updatedShared.value.events[0].date, '2026-12-24')
    assert.equal(updatedShared.value.events[0].time, '15:30')
    assert.doesNotMatch(JSON.stringify(updatedShared.value),
      /CHANGED PRIVATE|HIDDEN PRIVATE|A SECRET APPOINTMENT|location|notes|person/)

    // The selected event alone can be revoked; no calendar subscription.
    assert.equal((await json(gateway.base, '/api/shared-events/' + sharedId + '/revoke', {
      cookie: cookieB, body: {},
    })).response.status, 404)
    assert.equal((await json(gateway.base, '/api/shared-events/' + sharedId + '/revoke', {
      cookie: cookieA, body: {},
    })).response.status, 200)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events, [])
    assert.deepEqual((await json(gateway.base, '/api/shared-events/sent', {
      cookie: cookieA,
    })).value.shares.map(share => share.status), ['revoked'])
    // A revoked share can be resent, but only with explicit confirmation.
    const resendWithoutConfirmation = await json(gateway.base, '/api/shared-events/invite', {
      cookie: cookieA, body: { eventIds: [idToShare], recipientHouseholdIds: ['family-b'] },
    })
    assert.equal(resendWithoutConfirmation.response.status, 409)
    const resent = await json(gateway.base, '/api/shared-events/invite', {
      cookie: cookieA, body: { eventIds: [idToShare], recipientHouseholdIds: ['family-b'], allowResend: true },
    })
    assert.equal(resent.response.status, 201, JSON.stringify(resent.value))
    const resentId = resent.value.invitations[0].shareId
    assert.notEqual(resentId, sharedId)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/invitations', {
      cookie: cookieB,
    })).value.invitations.map(event => event.shareId), [resentId])
    assert.equal((await json(gateway.base, '/api/shared-events/invite', {
      cookie: cookieA, body: { eventIds: [idToShare], recipientHouseholdIds: ['family-b'], allowResend: true },
    })).response.status, 409)
    assert.equal((await json(gateway.base, '/api/shared-events/' + resentId + '/respond', {
      cookie: cookieB, body: { decision: 'declined' },
    })).response.status, 200)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/invitations', {
      cookie: cookieB,
    })).value.invitations, [])
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events, [])
    assert.equal((await json(gateway.base, '/api/shared-events/made-up', {
      cookie: cookieB,
    })).response.status, 404)

    // Deleting an event must cancel only its accepted invitation, not B's own
    // calendar or A's unrelated private event, and must not require manual sync.
    const temporary = await json(gateway.base, '/api/events', {
      cookie: cookieA, body: {
        date: '2026-12-30', title: 'Family A temporary public event', time: '16:00',
      },
    })
    assert.equal(temporary.response.status, 201)
    const temporaryId = temporary.value.id
    const temporaryInvite = await json(gateway.base, '/api/shared-events/invite', {
      cookie: cookieA,
      body: { eventIds: [temporaryId], recipientHouseholdIds: ['family-b'] },
    })
    assert.equal(temporaryInvite.response.status, 201)
    const tempShareId = temporaryInvite.value.invitations[0].shareId
    assert.equal((await json(gateway.base, '/api/shared-events/' + tempShareId + '/respond', {
      cookie: cookieB, body: { decision: 'accepted' },
    })).response.status, 200)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events.map(e => e.title), ['Family A temporary public event'])

    // Family B may remove its accepted copy; Family A cannot remove B's copy
    // and the source event remains entirely untouched.
    assert.equal((await json(gateway.base,
      '/api/shared-events/' + tempShareId + '/received', {
        cookie: cookieA, method: 'DELETE',
      })).response.status, 404)
    assert.equal((await json(gateway.base,
      '/api/shared-events/999999/received', {
        cookie: cookieB, method: 'DELETE',
      })).response.status, 404)
    const removed = await json(gateway.base,
      '/api/shared-events/' + tempShareId + '/received', {
        cookie: cookieB, method: 'DELETE',
      })
    assert.equal(removed.response.status, 200)
    assert.deepEqual(removed.value, { shareId: tempShareId, status: 'removed' })
    assert.equal((await json(gateway.base,
      '/api/shared-events/' + tempShareId + '/received', {
        cookie: cookieB, method: 'DELETE',
      })).response.status, 404)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events, [])
    assert.equal(central.prepare('SELECT status FROM event_share_grants WHERE id=?')
      .get(tempShareId).status, 'removed')
    assert.equal((await json(gateway.base, '/api/events', { cookie: cookieA }))
      .value.some(event => event.id === temporaryId &&
        event.title === 'Family A temporary public event'), true)
    assert.equal((await json(gateway.base, '/api/shared-events/invitations', {
      cookie: cookieB,
    })).value.invitations.length, 0)

    // Removing the copy makes a confirmed re-invite possible, but never
    // silently restores it or adds a duplicate pending invitation.
    assert.equal((await json(gateway.base, '/api/shared-events/invite', {
      cookie: cookieA, body: {
        eventIds: [temporaryId], recipientHouseholdIds: ['family-b'],
      },
    })).response.status, 409)
    const secondTemporaryInvite = await json(gateway.base, '/api/shared-events/invite', {
      cookie: cookieA, body: {
        eventIds: [temporaryId], recipientHouseholdIds: ['family-b'],
        allowResend: true,
      },
    })
    assert.equal(secondTemporaryInvite.response.status, 201)
    const secondTempShareId = secondTemporaryInvite.value.invitations[0].shareId
    assert.notEqual(secondTempShareId, tempShareId)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/invitations', {
      cookie: cookieB,
    })).value.invitations.map(event => event.shareId), [secondTempShareId])
    assert.equal((await json(gateway.base, '/api/shared-events/invite', {
      cookie: cookieA, body: {
        eventIds: [temporaryId], recipientHouseholdIds: ['family-b'],
        allowResend: true,
      },
    })).response.status, 409)
    assert.equal((await json(gateway.base,
      '/api/shared-events/' + secondTempShareId + '/respond', {
        cookie: cookieB, body: { decision: 'accepted' },
      })).response.status, 200)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events.map(event => event.shareId), [secondTempShareId])
    assert.equal((await json(gateway.base, '/api/events/' + temporaryId, {
      cookie: cookieA, method: 'DELETE',
    })).response.status, 200)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events, [])
    assert.equal(central.prepare(
      'SELECT status FROM event_share_grants WHERE id = ?',
    ).get(tempShareId).status, 'removed')
    assert.equal(central.prepare(
      'SELECT status FROM event_share_grants WHERE id = ?',
    ).get(secondTempShareId).status, 'cancelled')

    // A batch SQL delete bypasses /api/events/:id entirely. The durable
    // source-local outbox still cancels its one explicitly accepted share.
    const batchSource = new DatabaseSync(a.databasePath)
    let batchEventId
    try {
      batchEventId = Number(batchSource.prepare(
        'INSERT INTO events (date,title,time,batch_id) VALUES(?,?,?,?)'
      ).run('2027-01-10', 'Batch source event', '08:00', 'private-batch-1')
        .lastInsertRowid)
    } finally { batchSource.close() }
    const batchInvite = await json(gateway.base, '/api/shared-events/invite', {
      cookie: cookieA,
      body: { eventIds: [batchEventId], recipientHouseholdIds: ['family-b'] },
    })
    assert.equal(batchInvite.response.status, 201, JSON.stringify(batchInvite.value))
    const batchShare = batchInvite.value.invitations[0].shareId
    assert.equal((await json(gateway.base,
      '/api/shared-events/' + batchShare + '/respond', {
        cookie: cookieB, body: { decision: 'accepted' },
      })).response.status, 200)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events.map(x => x.title), ['Batch source event'])
    const deleteBatch = new DatabaseSync(a.databasePath)
    try {
      assert.equal(deleteBatch.prepare('DELETE FROM events WHERE batch_id=?')
        .run('private-batch-1').changes, 1)
    } finally { deleteBatch.close() }
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events, [])
    assert.equal(central.prepare('SELECT status FROM event_share_grants WHERE id=?')
      .get(batchShare).status, 'cancelled')
    console.log('[PASS] Source SQLite outbox catches an entire batch-delete path.')
    assert.deepEqual((await json(gateway.base, '/api/events', {
      cookie: cookieB,
    })).value.map(e => e.title), ['Family B private calendar'])
    assert.deepEqual((await json(gateway.base, '/api/events', {
      cookie: cookieA,
    })).value.map(e => e.title),
    ['A SECRET APPOINTMENT', 'Family A BBQ time changed'])

    const unknownAuth = await json(gateway.base, '/api/auth/whatever', { cookie: cookieA })
    assert.equal(unknownAuth.response.status, 404)

    // Invalid cookie, membership revocation and account disable must deny
    // access before any backend receives that user's next request.
    const fakeCookie = '__Host-fc_session=' + '0'.repeat(64)
    assert.equal((await json(gateway.base, '/api/events', { cookie: fakeCookie })).response.status, 401)
    central.prepare([
      'UPDATE household_memberships SET disabled = 1',
      'WHERE user_id = ? AND household_id =',
      '(SELECT id FROM household_registry WHERE storage_id = ?)',
    ].join(' ')).run(idA, 'family-a')
    assert.equal((await json(gateway.base, '/api/events', { cookie: cookieA })).response.status, 403)
    assert.equal((await json(gateway.base, '/api/events', { cookie: cookieB })).response.status, 200)

    // One login belongs to precisely one household. A second grant is
    // blocked by SQLite rather than silently authorizing a family switch.
    assert.throws(() => grantHouseholdMembership(central, {
      serverVerifiedUserId: idB, householdId: 'family-a', role: 'member',
    }), /UNIQUE constraint failed/)
    const membershipsB = central.prepare(
      'SELECT COUNT(*) AS n FROM household_memberships WHERE user_id = ?'
    ).get(idB).n
    assert.equal(membershipsB, 1)

    const availableB = await json(gateway.base, '/api/households', { cookie: cookieB })
    assert.equal(availableB.response.status, 200)
    assert.deepEqual(availableB.value.households.map(h => h.householdId), ['family-b'])
    assert.equal(availableB.value.selectedHouseholdId, 'family-b')

    // URL, header and browser-side household selection cannot cross tenants.
    assert.deepEqual((await json(gateway.base,
      '/api/events?household=family-a', {
        cookie: cookieB,
        headers: { 'X-Household-Id': 'family-a' },
      })).value.map(e => e.title), ['Family B private calendar'])
    assert.equal((await json(gateway.base, '/api/lists', {
      cookie: cookieB, headers: { 'X-Household-Id': 'family-a' },
    })).value[0].name, 'Family B list')

    assert.equal((await json(gateway.base, '/api/households/select', {
      cookie: cookieB, body: { householdId: 'nonexistent-family' },
    })).response.status, 403)
    assert.equal((await json(gateway.base, '/api/households/select', {
      cookie: cookieB, body: { householdId: 'family-a' },
    })).response.status, 403)
    assert.equal((await json(gateway.base, '/api/households/select', {
      cookie: cookieB, body: { householdId: 'family-b' },
      headers: { Origin: 'https://evil.example' },
    })).response.status, 403)
    const selectOwn = await json(gateway.base, '/api/households/select', {
      cookie: cookieB, body: { householdId: 'family-b' },
    })
    assert.equal(selectOwn.response.status, 200)
    assert.equal(selectOwn.value.selectedHouseholdId, 'family-b')
    assert.deepEqual((await json(gateway.base, '/api/events', {
      cookie: cookieB,
    })).value.map(e => e.title), ['Family B private calendar'])

    // Two sessions for one account both stay in its sole authorized family.
    const cookieB2 = await login(gateway.base, 'familyadminb')
    assert.deepEqual((await json(gateway.base, '/api/events', {
      cookie: cookieB2,
    })).value.map(e => e.title), ['Family B private calendar'])
    assert.equal((await json(gateway.base, '/api/households', {
      cookie: cookieB2,
    })).value.selectedHouseholdId, 'family-b')
    assert.equal((await json(gateway.base, '/api/households/select', {
      cookie: cookieB2, body: { householdId: 'family-a' },
    })).response.status, 403)

    // Revoking that single grant immediately blocks both browser sessions.
    central.prepare([
      'UPDATE household_memberships SET disabled = 1',
      'WHERE user_id = ? AND household_id =',
      '(SELECT id FROM household_registry WHERE storage_id = ?)',
    ].join(' ')).run(idB, 'family-b')
    assert.equal((await json(gateway.base, '/api/events', {
      cookie: cookieB,
    })).response.status, 403)
    assert.equal((await json(gateway.base, '/api/events', {
      cookie: cookieB2,
    })).response.status, 403)
    const revokedList = await json(gateway.base, '/api/households', { cookie: cookieB })
    assert.deepEqual(revokedList.value.households, [])
    assert.equal(revokedList.value.selectedHouseholdId, null)
    assert.equal((await json(gateway.base, '/api/households/select', {
      cookie: cookieB, body: { householdId: 'family-b' },
    })).response.status, 403)

    central.prepare('UPDATE family_users SET disabled = 1 WHERE id = ?').run(idB)
    assert.equal((await json(gateway.base, '/api/events', { cookie: cookieB })).response.status, 401)
    assert.equal((await json(gateway.base, '/api/events', { cookie: cookieB2 })).response.status, 401)

    console.log('[PASS] Persisted source sync survives gateway restart and read-time recovery.')
    console.log('[PASS] Successful event edits refresh the accepted snapshot; rejected edits do not.')
    console.log('[PASS] A deleted shared event cancels its own accepted grant without affecting other events.')
    console.log('[PASS] One selected event is invited, accepted and individually revoked over authenticated APIs.')
    console.log('[PASS] No unrelated event or private fields reach another household through event-sharing API.')
    console.log('[PASS] Only centrally connected households can receive event invitations.')
    console.log('[PASS] Private backends reject direct access without their own service capability.')
    console.log('[PASS] One secure login gateway routes each authenticated user only to their household.')
    console.log('[PASS] Guessed tenant selectors cannot read unrelated events, lists or images.')
    console.log('[PASS] Invalid cookies, revoked memberships and disabled accounts block requests.')
    console.log('[PASS] Multi-household accounts require explicit, CSRF-checked selection.')
    console.log('[PASS] Selections are independently stored per trusted device and rechecked after revocation.')
    console.log('[PASS] All servers were private loopback listeners with disposable SQLite DBs.')
  } finally {
    const failures = []
    if (gateway) {
      try { await gateway.close() } catch (error) { failures.push(error) }
    }
    for (const backend of backends) {
      try { await stopBackend(backend) } catch (error) { failures.push(error) }
    }
    try { central.close() } catch (error) { failures.push(error) }
    if (failures.length === 0) {
      fs.rmSync(work, { recursive: true, force: true })
    } else {
      console.error('Disposable test data kept for safe inspection: ' + work)
      throw failures[0]
    }
  }
})

test('client disconnect cannot clear a share update while backend is still committing', {
  timeout: 25000,
}, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-disconnect-recovery-'))
  const storageRoot = path.join(work, 'household-storage')
  fs.mkdirSync(storageRoot)
  const central = new DatabaseSync(path.join(work, 'identity.db'))
  let gateway = null
  let fakeBackend = null
  let fakeBackendB = null
  let releaseBackend = null
  let editor = null
  try {
    const a = provisionEmptyHousehold({ serverDirectory, storageRoot, householdId: 'family-a' })
    provisionEmptyHousehold({ serverDirectory, storageRoot, householdId: 'family-b' })
    const source = new DatabaseSync(a.databasePath)
    try {
      source.exec(`CREATE TABLE events (
        id INTEGER PRIMARY KEY, title TEXT, date TEXT, end_date TEXT,
        time TEXT, end_time TEXT, repeat_unit TEXT
      );
      INSERT INTO events VALUES
        (1,'Before disconnect','2026-12-20',NULL,'12:00',NULL,NULL);`)
      installPrivateEventIdentity(source)
      installPrivateEventSourceOutbox(source)
      createHouseholdMembershipTables(central)
      setFamilyAccount(central, 'disconnect-a', 'Test Family A', testPassword)
      setFamilyAccount(central, 'disconnect-b', 'Test Family B', testPassword)
      registerHousehold(central, { householdId: 'family-a', displayName: 'Family A' })
      registerHousehold(central, { householdId: 'family-b', displayName: 'Family B' })
      createEventShareTables(central)
      registerTrustedShareConnection(central, {
        sourceHouseholdId: 'family-a', recipientHouseholdId: 'family-b',
      })
      const userA = central.prepare(
        "SELECT id FROM family_users WHERE username = 'disconnect-a'"
      ).get().id
      const userB = central.prepare(
        "SELECT id FROM family_users WHERE username = 'disconnect-b'"
      ).get().id
      grantHouseholdMembership(central, {
        serverVerifiedUserId: userA, householdId: 'family-a', role: 'owner',
      })
      grantHouseholdMembership(central, {
        serverVerifiedUserId: userB, householdId: 'family-b', role: 'owner',
      })
      const [share] = inviteSelectedEvents(central, {
        serverVerifiedUserId: userA, sourceHouseholdId: 'family-a',
        sourceDatabase: source, eventIds: [1], recipientHouseholdIds: ['family-b'],
      })
      respondToEventInvitation(central, {
        serverVerifiedUserId: userB, recipientHouseholdId: 'family-b',
        shareId: share.shareId, decision: 'accepted',
      })
    } finally {
      source.close()
    }

    let signalRequest
    const received = new Promise(resolve => { signalRequest = resolve })
    const release = new Promise(resolve => { releaseBackend = resolve })
    const backendTokens = {
      'family-a': randomBytes(32).toString('hex'),
      'family-b': randomBytes(32).toString('hex'),
    }
    let activeBackendHouseholdA = 'family-a'
    fakeBackend = createHttpServer((request, response) => {
      if (request.method === 'GET' &&
          request.url === '/api/internal/household-binding') {
        if (request.headers['x-family-calendar-upstream-token'] !== backendTokens['family-a']) {
          response.writeHead(403)
          response.end()
          return
        }
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ mode: 'household', householdId: activeBackendHouseholdA }))
        return
      }
      if (request.method !== 'PUT' || request.url !== '/api/events/1') {
        response.writeHead(404)
        response.end()
        return
      }
      request.once('end', () => {
        signalRequest()
        void release.then(() => {
          const db = new DatabaseSync(a.databasePath)
          try {
            db.prepare('UPDATE events SET title=? WHERE id=1')
              .run('Committed after browser disconnected')
          } finally {
            db.close()
          }
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end('{"ok":true}')
        }).catch(() => response.destroy())
      })
      request.resume()
    })
    await new Promise((resolve, reject) => {
      fakeBackend.once('error', reject)
      fakeBackend.listen(0, '127.0.0.1', resolve)
    })
    const portA = fakeBackend.address().port
    fakeBackendB = createHttpServer((request, response) => {
      if (request.method !== 'GET' ||
          request.url !== '/api/internal/household-binding' ||
          request.headers['x-family-calendar-upstream-token'] !== backendTokens['family-b']) {
        response.writeHead(403)
        response.end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ mode: 'household', householdId: 'family-b' }))
    })
    await new Promise((resolve, reject) => {
      fakeBackendB.once('error', reject)
      fakeBackendB.listen(0, '127.0.0.1', resolve)
    })
    const portB = fakeBackendB.address().port
    assert.equal(forbiddenPorts.has(portA), false)
    gateway = await startPrivateHouseholdGateway({
      identityDatabase: central, serverDirectory, storageRoot,
      backendPorts: { 'family-a': portA, 'family-b': portB },
      backendTokens,
    })
    const cookieA = await login(gateway.base, 'disconnect-a')
    const cookieB = await login(gateway.base, 'disconnect-b')

    // Backend binding was correct at startup, then the service began
    // reporting a different family's identity on the SAME port/token.
    // Every forwarded operation must refuse that change while the gateway
    // stays running, before any source mutation or tenant data can be sent.
    assert.equal((await fetch(gateway.base + '/api/internal/household-binding', {
      headers: { Cookie: cookieA },
    })).status, 404)
    activeBackendHouseholdA = 'family-b'
    const switched = await fetch(gateway.base + '/api/events', {
      headers: { Cookie: cookieA },
    })
    assert.equal(switched.status, 503)
    assert.equal(switched.headers.get('cache-control'), 'no-store')
    activeBackendHouseholdA = 'family-a'
    assert.equal((await fetch(gateway.base + '/api/events', {
      headers: { Cookie: cookieA },
    })).status, 404) // test backend has no GET /api/events route

    let signalDisconnected
    const disconnected = new Promise(resolve => { signalDisconnected = resolve })
    const url = new URL(gateway.base)
    editor = httpRequest({
      hostname: url.hostname, port: Number(url.port),
      path: '/api/events/1', method: 'PUT',
      headers: {
        Cookie: cookieA,
        Origin: 'https://' + url.host,
        'Content-Type': 'application/json',
      },
    }, response => response.resume())
    editor.once('error', () => signalDisconnected())
    editor.end(JSON.stringify({
      date: '2026-12-20', title: 'Committed after browser disconnected',
    }))
    await received
    // The backend deliberately has NOT committed or sent a response yet.
    editor.destroy()
    await disconnected
    assert.equal(countUnresolvedEventShareSync(central), 1)
    const blocked = await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })
    assert.equal(blocked.response.status, 503)
    assert.equal(countPendingEventShareSync(central), 1)
    assert.equal(central.prepare(
      'SELECT title FROM event_share_grants WHERE status = ?'
    ).get('accepted').title, 'Before disconnect')

    // Finish the backend commit after the browser has vanished. The gateway
    // still consumes the authoritative backend response and then safely replays.
    releaseBackend()
    releaseBackend = null
    for (let attempt = 0; attempt < 100 && countPendingEventShareSync(central); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(countUnresolvedEventShareSync(central), 0)
    assert.equal(countPendingEventShareSync(central), 0)
    const current = await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })
    assert.equal(current.response.status, 200)
    assert.deepEqual(current.value.events.map(x => x.title),
      ['Committed after browser disconnected'])
    console.log('[PASS] Browser disconnect cannot acknowledge uncommitted backend work.')
  } finally {
    releaseBackend?.()
    editor?.destroy()
    if (gateway) await gateway.close()
    if (fakeBackend) {
      fakeBackend.closeAllConnections()
      await new Promise(resolve => fakeBackend.close(resolve))
    }
    if (fakeBackendB) {
      fakeBackendB.closeAllConnections()
      await new Promise(resolve => fakeBackendB.close(resolve))
    }
    central.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
})
