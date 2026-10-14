// End-to-end PRIVATE TEST HARNESS: one central login + household permissions,
// two real isolated Node backends, a loopback-only gateway, no public listeners.
// All files and DBs live in a disposable OS temp folder; production is untouched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:net'
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
  createEventShareTables, registerTrustedShareConnection,
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

function startBackend(storageRoot, id, port) {
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
  return { child, base: 'http://127.0.0.1:' + port, logs: () => recent }
}

async function waitForBackend(backend) {
  for (let i = 0; i < 60; i++) {
    if (backend.child.exitCode !== null || backend.child.signalCode !== null) break
    try {
      const response = await fetch(backend.base + '/api/health', {
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
  assert.match(cookie, /__Host-fc_session=[a-f0-9]{64}/)
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
    registerHousehold(central, { householdId: 'family-a', displayName: 'Family A' })
    registerHousehold(central, { householdId: 'family-b', displayName: 'Family B' })
    createEventShareTables(central)
    registerTrustedShareConnection(central, {
      sourceHouseholdId: 'family-a', recipientHouseholdId: 'family-b',
    })
    const idA = central.prepare('SELECT id FROM family_users WHERE username = ?').get('familyadmina').id
    const idB = central.prepare('SELECT id FROM family_users WHERE username = ?').get('familyadminb').id
    grantHouseholdMembership(central, { serverVerifiedUserId: idA, householdId: 'family-a', role: 'owner' })
    grantHouseholdMembership(central, { serverVerifiedUserId: idB, householdId: 'family-b', role: 'owner' })

    const usedPorts = new Set()
    const portA = await randomPort(usedPorts)
    const portB = await randomPort(usedPorts)
    backends.push(startBackend(storageRoot, 'family-a', portA))
    backends.push(startBackend(storageRoot, 'family-b', portB))
    await Promise.all(backends.map(waitForBackend))

    gateway = await startPrivateHouseholdGateway({
      identityDatabase: central,
      serverDirectory,
      storageRoot,
      backendPorts: { 'family-a': portA, 'family-b': portB },
    })
    assert.equal(new URL(gateway.base).hostname, '127.0.0.1')
    assert.equal(forbiddenPorts.has(gateway.port), false)

    const unauthEvents = await json(gateway.base, '/api/events')
    assert.equal(unauthEvents.response.status, 401)
    for (const route of [
      '/api/shared-events/recipients', '/api/shared-events/invitations',
      '/api/shared-events/accepted',
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
    const cookieB = await login(gateway.base, 'familyadminb')
    assert.equal((await json(gateway.base, '/api/auth/status', { cookie: cookieA })).value.authenticated, true)
    assert.equal((await json(gateway.base, '/api/auth/status', { cookie: cookieB })).value.authenticated, true)
    assert.equal((await json(gateway.base, '/api/auth/status', { cookie: cookieA })).value.username, 'familyadmina')
    assert.equal((await json(gateway.base, '/api/auth/status', { cookie: cookieB })).value.username, 'familyadminb')

    // The Account UI switches by username, not by bypassing membership checks.
    // Switching to a different account requires a fresh password login.
    const accountPage = await fetch(gateway.base + '/account', {
      headers: { Cookie: cookieA }, redirect: 'manual',
    })
    assert.equal(accountPage.status, 200)
    const accountHtml = await accountPage.text()
    assert.match(accountHtml, /id="profile-username"/)
    assert.match(accountHtml, /id="switch-profile"/)
    assert.doesNotMatch(accountHtml, /id="household-switch-form"/)
    const accountJavaScript = await fetch(gateway.base + '/auth/account.js')
    assert.equal(accountJavaScript.status, 200)
    assert.match(await accountJavaScript.text(), /switchProfile\.addEventListener\('click', signOutToLogin\)/)
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
    const approved = await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })
    assert.deepEqual(approved.value.events.map(e => e.title), ['Family A private calendar'])
    assert.doesNotMatch(JSON.stringify(approved.value), /SECRET|PRIVATE MEDICAL|location|notes|person/)
    assert.deepEqual((await json(gateway.base, '/api/events', {
      cookie: cookieB,
    })).value.map(e => e.title), ['Family B private calendar'])

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
    assert.equal((await json(gateway.base, '/api/events/' + temporaryId, {
      cookie: cookieA, method: 'DELETE',
    })).response.status, 200)
    assert.deepEqual((await json(gateway.base, '/api/shared-events/accepted', {
      cookie: cookieB,
    })).value.events, [])
    assert.equal(central.prepare(
      'SELECT status FROM event_share_grants WHERE id = ?',
    ).get(tempShareId).status, 'cancelled')
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

    // Multi-membership accounts must make an explicit, authorized choice.
    // Session selections must be scoped to the current device, never the user
    // or a manipulable tenant selector in the URL or browser header.
    grantHouseholdMembership(central, {
      serverVerifiedUserId: idB, householdId: 'family-a', role: 'member',
    })
    assert.equal((await json(gateway.base, '/api/events', { cookie: cookieB })).response.status, 409)
    assert.equal((await json(gateway.base, '/api/events?household=family-a', {
      cookie: cookieB,
      headers: { 'X-Household-Id': 'family-a' },
    })).response.status, 409)

    const availableB = await json(gateway.base, '/api/households', { cookie: cookieB })
    assert.deepEqual(
      availableB.value.households.map(h => h.householdId),
      ['family-a', 'family-b'],
    )
    assert.equal(availableB.value.selectedHouseholdId, null)

    const deniedSelection = await json(gateway.base, '/api/households/select', {
      cookie: cookieB, body: { householdId: 'nonexistent-family' },
    })
    assert.equal(deniedSelection.response.status, 403)
    assert.equal((await json(gateway.base, '/api/events', { cookie: cookieB })).response.status, 409)

    const csrfSelection = await json(gateway.base, '/api/households/select', {
      cookie: cookieB,
      body: { householdId: 'family-a' },
      headers: { Origin: 'https://evil.example' },
    })
    assert.equal(csrfSelection.response.status, 403)
    assert.equal((await json(gateway.base, '/api/events', { cookie: cookieB })).response.status, 409)

    const chosenA = await json(gateway.base, '/api/households/select', {
      cookie: cookieB,
      body: { householdId: 'family-a' },
    })
    assert.equal(chosenA.response.status, 200)
    assert.equal(chosenA.value.selectedHouseholdId, 'family-a')
    assert.deepEqual(
      (await json(gateway.base, '/api/events?household=family-b', {
        cookie: cookieB, headers: { 'X-Household-Id': 'family-b' },
      })).value.map(e => e.title),
      ['A SECRET APPOINTMENT', 'Family A BBQ time changed'],
    )
    assert.equal((await json(gateway.base, '/api/lists', {
      cookie: cookieB,
    })).value[0].name, 'Family A list')
    assert.equal((await json(gateway.base, '/uploads/private-shared-name.jpg', {
      cookie: cookieB,
    })).value, 'ONLY family A photo bytes')

    // Separate browser sessions for the *same* account cannot inherit each
    // other's household selection or change it without their own request.
    const cookieB2 = await login(gateway.base, 'familyadminb')
    assert.equal((await json(gateway.base, '/api/events', {
      cookie: cookieB2,
    })).response.status, 409)
    assert.equal((await json(gateway.base, '/api/households', {
      cookie: cookieB2,
    })).value.selectedHouseholdId, null)

    const chooseB2 = await json(gateway.base, '/api/households/select', {
      cookie: cookieB2,
      body: { householdId: 'family-b' },
    })
    assert.equal(chooseB2.response.status, 200)
    assert.deepEqual((await json(gateway.base, '/api/events', {
      cookie: cookieB2,
    })).value.map(e => e.title), ['Family B private calendar'])
    assert.deepEqual((await json(gateway.base, '/api/events', {
      cookie: cookieB,
    })).value.map(e => e.title), ['A SECRET APPOINTMENT', 'Family A BBQ time changed'])

    const chooseB = await json(gateway.base, '/api/households/select', {
      cookie: cookieB,
      body: { householdId: 'family-b' },
    })
    assert.equal(chooseB.response.status, 200)
    assert.deepEqual((await json(gateway.base, '/api/events', {
      cookie: cookieB,
    })).value.map(e => e.title), ['Family B private calendar'])
    assert.equal((await json(gateway.base, '/api/households', {
      cookie: cookieB,
    })).value.selectedHouseholdId, 'family-b')

    // A deliberately revoked membership ceases to grant access even when
    // its previously selected household was stored in the central DB.
    await json(gateway.base, '/api/households/select', {
      cookie: cookieB,
      body: { householdId: 'family-a' },
    })
    central.prepare([
      'UPDATE household_memberships SET disabled = 1',
      'WHERE user_id = ? AND household_id =',
      '(SELECT id FROM household_registry WHERE storage_id = ?)',
    ].join(' ')).run(idB, 'family-a')
    assert.equal((await json(gateway.base, '/api/households/select', {
      cookie: cookieB,
      body: { householdId: 'family-a' },
    })).response.status, 403)
    assert.equal((await json(gateway.base, '/api/households', {
      cookie: cookieB,
    })).value.selectedHouseholdId, 'family-b')
    assert.deepEqual((await json(gateway.base, '/api/events', {
      cookie: cookieB,
    })).value.map(e => e.title), ['Family B private calendar'])

    central.prepare('UPDATE family_users SET disabled = 1 WHERE id = ?').run(idB)
    assert.equal((await json(gateway.base, '/api/events', { cookie: cookieB })).response.status, 401)
    assert.equal((await json(gateway.base, '/api/events', { cookie: cookieB2 })).response.status, 401)

    console.log('[PASS] Successful event edits refresh the accepted snapshot; rejected edits do not.')
    console.log('[PASS] A deleted shared event cancels its own accepted grant without affecting other events.')
    console.log('[PASS] One selected event is invited, accepted and individually revoked over authenticated APIs.')
    console.log('[PASS] No unrelated event or private fields reach another household through event-sharing API.')
    console.log('[PASS] Only centrally connected households can receive event invitations.')
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
