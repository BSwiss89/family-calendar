import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { DatabaseSync } from 'node:sqlite'
import {
  registerHousehold, grantHouseholdMembership, lookupGrantedHouseholdForSessionUser,
} from '../Server/household-memberships.mjs'
import {
  createFamilyMemberAccessTables, setFamilyMemberType, setFamilyMemberPermission,
  setFamilyMemberPersonLink,
} from '../Server/family-member-access.mjs'
import {
  requiredFamilyMemberActions, authorizeFamilyMemberApiRequest,
  installPrivateMemberRouteEnforcement,
} from '../Server/family-member-route-enforcement.mjs'
import { readPrivateHomePinPolicy, setPrivateHomePinPolicy } from '../Server/private-home-pin-policy.mjs'
import { authorizePrivateHomeRequest } from '../Server/private-shared-home-write-gate.mjs'
import { recordPrivateHomeWriteAudit } from '../Server/private-home-write-audit.mjs'
import {
  createPrivateHomeActorTables, enrollPrivateHomeKiosk, disablePrivateHomeKiosk,
  isPrivateHomeKioskTrusted, setPrivateHomeActorPin, createPrivateHomePinVerifier,
} from '../Server/private-home-kiosk-identity.mjs'

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  createFamilyMemberAccessTables(db)
  const add = db.prepare(
    'INSERT INTO family_users(username,display_name,password_hash) VALUES (?,?,?)'
  )
  const ownerId = Number(add.run('owner-route', 'Owner', 'dummy').lastInsertRowid)
  const adultId = Number(add.run('adult-route', 'Adult', 'dummy').lastInsertRowid)
  const childId = Number(add.run('child-route', 'Child', 'dummy').lastInsertRowid)
  const outsiderId = Number(add.run('outsider-route', 'Other family', 'dummy').lastInsertRowid)
  registerHousehold(db, { householdId: 'family-a', displayName: 'A' })
  registerHousehold(db, { householdId: 'family-b', displayName: 'B' })
  for (const [userId, householdId, role] of [
    [ownerId, 'family-a', 'owner'], [adultId, 'family-a', 'member'],
    [childId, 'family-a', 'member'], [outsiderId, 'family-b', 'owner'],
  ]) grantHouseholdMembership(db, { serverVerifiedUserId: userId, householdId, role })
  for (const [targetUserId, memberType] of [[adultId, 'adult'], [childId, 'child']]) {
    setFamilyMemberType(db, {
      householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
      targetUserId, memberType,
    })
  }
  return { db, ownerId, adultId, childId, outsiderId }
}

test('shared Home PIN preference defaults ON, is Owner-only, and cannot grant member rights', t => {
  const { db, ownerId, adultId, childId, outsiderId } = fixture(t)
  const read = (householdId, userId) => readPrivateHomePinPolicy(db, {
    householdId, serverVerifiedOwnerUserId: userId,
  })
  const change = (householdId, userId, pinEnabled) => setPrivateHomePinPolicy(db, {
    householdId, serverVerifiedOwnerUserId: userId, pinEnabled,
  })
  assert.deepEqual(read('family-a', ownerId), { pinEnabled: true })
  assert.deepEqual(read('family-b', outsiderId), { pinEnabled: true })
  assert.throws(() => read('family-a', childId), /Active household Owner required/)
  assert.throws(() => change('family-a', adultId, false), /Active household Owner required/)
  assert.throws(() => change('family-a', outsiderId, false), /Active household Owner required/)
  assert.throws(() => change('family-a', ownerId, 'false'), /must be a boolean/)
  assert.deepEqual(change('family-a', ownerId, false), { pinEnabled: false })
  assert.deepEqual(read('family-a', ownerId), { pinEnabled: false })
  assert.deepEqual(read('family-b', outsiderId), { pinEnabled: true })
  // A saved "PIN off" preference does not permit profile selection, Child
  // impersonation, or unreviewed APIs to write without their existing grants.
  assert.equal(authorizeFamilyMemberApiRequest(db, {
    serverVerifiedUserId: childId, householdId: 'family-a',
    method: 'POST', originalUrl: '/api/events',
  }).allowed, false)
  assert.deepEqual(change('family-a', ownerId, true), { pinEnabled: true })
  db.prepare('UPDATE household_memberships SET disabled = 1 WHERE user_id = ?').run(ownerId)
  assert.throws(() => change('family-a', ownerId, false), /Active household Owner required/)
  assert.throws(() => read('family-a', ownerId), /Active household Owner required/)
  assert.deepEqual(read('family-b', outsiderId), { pinEnabled: true })
})

test('four-digit Home proof requires an Owner-enrolled device, real linked Person and current grants', async t => {
  const { db, ownerId, adultId, childId, outsiderId } = fixture(t)
  const calendarDb = new DatabaseSync(':memory:')
  t.after(() => calendarDb.close())
  calendarDb.exec('CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  calendarDb.prepare('INSERT INTO people(id,name) VALUES (?,?)').run(11, 'Linked Child')
  calendarDb.prepare('INSERT INTO people(id,name) VALUES (?,?)').run(12, 'Linked Owner')
  createPrivateHomeActorTables(db)
  for (const [userId, personId] of [[ownerId, 12], [childId, 11]]) {
    setFamilyMemberPersonLink(db, {
      householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
      targetUserId: userId, personId, householdDatabase: calendarDb,
    })
  }
  const now = Date.now()
  const makeSession = (userId, selected) => Number(db.prepare([
    'INSERT INTO family_sessions',
    '(user_id,token_hash,device_label,created_at,last_seen_at,expires_at,selected_profile_kind)',
    'VALUES (?,?,?,?,?,?,?)',
  ].join(' ')).run(userId, 'testhash-' + userId + '-' + selected, 'Disposable Home',
    now, now, now + 3600000, selected).lastInsertRowid)
  const kioskSessionId = makeSession(ownerId, 'person')
  const otherSessionId = makeSession(outsiderId, 'home')
  const verifier = createPrivateHomePinVerifier()
  const home = () => ({
    householdId: 'family-a', serverVerifiedSessionId: kioskSessionId,
  })
  assert.equal(isPrivateHomeKioskTrusted(db, home()), false)
  assert.throws(() => enrollPrivateHomeKiosk(db, {
    ...home(), serverVerifiedOwnerUserId: ownerId,
  }), /Select Home/)
  db.prepare("UPDATE family_sessions SET selected_profile_kind='home' WHERE id=?")
    .run(kioskSessionId)
  assert.equal(isPrivateHomeKioskTrusted(db, home()), false,
    'choosing Home is NOT kiosk enrollment')
  assert.deepEqual(enrollPrivateHomeKiosk(db, {
    ...home(), serverVerifiedOwnerUserId: ownerId,
  }), { trustedHome: true })
  assert.equal(isPrivateHomeKioskTrusted(db, home()), true)
  assert.throws(() => setPrivateHomeActorPin(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: outsiderId,
    targetUserId: childId, pin: '1234', householdDatabase: calendarDb,
  }), /Owner required/)
  assert.throws(() => setPrivateHomeActorPin(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, pin: '12345', householdDatabase: calendarDb,
  }), /four digits/)
  assert.throws(() => setPrivateHomeActorPin(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: adultId, pin: '1234', householdDatabase: calendarDb,
  }), /linked active family Person/)
  assert.deepEqual(setPrivateHomeActorPin(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, pin: '1234', householdDatabase: calendarDb,
  }), { pinConfigured: true })
  const savedPin = db.prepare(
    'SELECT pin_hash FROM private_home_actor_pins WHERE user_id=?'
  ).get(childId).pin_hash
  assert.match(savedPin, /^scrypt-home-v1:[a-f0-9]{32}:[a-f0-9]{128}$/)
  const attempt = (pin, userId = childId) => verifier.verify(db, {
    ...home(), targetUserId: userId, pin, householdDatabase: calendarDb,
  })
  assert.deepEqual(await attempt('9999'), { status: 'invalid' })
  const good = await attempt('1234')
  assert.equal(good.status, 'verified')
  assert.match(good.proof, /^[a-f0-9]{64}$/)
  const resolve = (sessionId = kioskSessionId, proof = good.proof) =>
    verifier.resolve(db, {
      householdId: 'family-a', serverVerifiedSessionId: sessionId,
      proof, householdDatabase: calendarDb,
    })
  const homeDecision = (method, originalUrl, proof = good.proof) =>
    authorizePrivateHomeRequest(db, {
      householdId: 'family-a', sessionId: kioskSessionId,
      method, originalUrl, proof, householdDatabase: calendarDb,
      resolveHomeActorProof: args => verifier.resolve(db, args),
    })
  assert.equal(homeDecision('GET', '/api/events').status, 'allowed-read')
  assert.equal(homeDecision('GET', '/api/households/member-access').status,
    'unreviewed-home-route', 'Owner administration is not a Home read')
  assert.equal(homeDecision('GET', '/API/households/member-access').status,
    'unreviewed-home-route', 'case aliases cannot bypass kiosk Owner restrictions')
  assert.equal(homeDecision('POST', '/api/households/member-invitations').status,
    'unreviewed-home-route', 'Owner invitation is not a shared Home action')
  assert.equal(homeDecision('POST', '/api/ai/event-action-confirm').status,
    'unreviewed-home-route', 'unreviewed Arney writes cannot inherit Owner')
  assert.equal(homeDecision('POST', '/api/events', null).status, 'pin-required')
  assert.equal(homeDecision('POST', '/api/events').status, 'permission-denied',
    'a real Child PIN is not event-create permission')

  assert.equal(resolve().userId, childId)
  assert.equal(resolve().personId, 11)
  assert.equal(resolve().role, 'child')
  assert.equal(resolve(otherSessionId), null, 'proof cannot move to another session')
  assert.equal(verifier.resolve(db, {
    householdId: 'family-b', serverVerifiedSessionId: kioskSessionId,
    proof: good.proof, householdDatabase: calendarDb,
  }), null, 'proof cannot move to another household')
  assert.equal(authorizeFamilyMemberApiRequest(db, {
    serverVerifiedUserId: childId, householdId: 'family-a',
    method: 'POST', originalUrl: '/api/events',
  }).allowed, false, 'verified child PIN is not permission to write')
  setFamilyMemberPermission(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, action: 'events.create', enabled: true,
  })
  assert.equal(resolve().permissions.includes('events.create'), true,
    'proof resolves current grants instead of stale cached grants')
  const childWrite = homeDecision('POST', '/api/events')
  assert.equal(childWrite.status, 'allowed-write')
  assert.deepEqual(childWrite.attribution, {
    kind: 'verified-person', userId: childId, personId: 11, role: 'child',
  })
  assert.equal(homeDecision('DELETE', '/api/events/1').status, 'permission-denied')
  assert.equal(homeDecision('POST', '/API/events').status, 'unreviewed-home-route')
  assert.equal(homeDecision('POST', '/api/events/01').status, 'unreviewed-home-route')
  const audited = recordPrivateHomeWriteAudit(db, {
    householdId: 'family-a', serverVerifiedKioskUserId: ownerId,
    serverVerifiedSessionId: kioskSessionId, attribution: childWrite.attribution,
    method: 'POST', route: '/api/events', resourceId: 1,
  })
  assert.ok(audited > 0)
  assert.deepEqual({ ...db.prepare([
    'SELECT actor_kind AS kind, actor_user_id AS userId,',
    'kiosk_session_id AS sessionId FROM private_home_write_audit WHERE id=?',
  ].join(' ')).get(audited) }, {
    kind: 'verified-person', userId: childId, sessionId: kioskSessionId,
  })
  setFamilyMemberPermission(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, action: 'events.create', enabled: false,
  })
  assert.equal(resolve().permissions.includes('events.create'), false)
  setPrivateHomePinPolicy(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    pinEnabled: false,
  })
  assert.equal(resolve(), null, 'PIN off invalidates all existing proofs')
  const sharedCreate = homeDecision('POST', '/api/events', null)
  assert.equal(sharedCreate.status, 'allowed-write')
  assert.deepEqual(sharedCreate.attribution, {
    kind: 'shared-home', userId: null, personId: null,
  })
  assert.equal(homeDecision('PUT', '/api/events/1', null).status, 'allowed-write')
  assert.equal(homeDecision('POST', '/api/lists', null).status, 'allowed-write')
  assert.equal(homeDecision('DELETE', '/api/events/1', null).status, 'permission-denied')
  assert.equal(homeDecision('POST', '/api/people', null).status, 'unreviewed-home-route')
  const sharedAuditId = recordPrivateHomeWriteAudit(db, {
    householdId: 'family-a', serverVerifiedKioskUserId: ownerId,
    serverVerifiedSessionId: kioskSessionId, attribution: sharedCreate.attribution,
    method: 'POST', route: '/api/events', resourceId: 2,
  })
  assert.deepEqual({ ...db.prepare([
    'SELECT actor_kind AS kind, actor_user_id AS userId',
    'FROM private_home_write_audit WHERE id=?',
  ].join(' ')).get(sharedAuditId) }, { kind: 'shared-home', userId: null })
  assert.deepEqual(await attempt('1234'), { status: 'disabled' })
  setPrivateHomePinPolicy(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    pinEnabled: true,
  })
  assert.equal(resolve(), null, 'PIN reenabled cannot resurrect old proof')
  const next = await attempt('1234')
  assert.equal(next.status, 'verified')
  setPrivateHomeActorPin(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, pin: '9876', householdDatabase: calendarDb,
  })
  assert.equal(resolve(kioskSessionId, next.proof), null,
    'resetting PIN must revoke previously issued proof')
  assert.deepEqual(await attempt('1234'), { status: 'invalid' })
  const finalProof = await attempt('9876')
  assert.equal(finalProof.status, 'verified')
  db.prepare('UPDATE household_memberships SET disabled=1 WHERE user_id=?')
    .run(childId)
  assert.equal(resolve(kioskSessionId, finalProof.proof), null,
    'revoking membership must invalidate an otherwise valid raw proof')
  const denied = await attempt('9876')
  assert.equal(denied.status, 'invalid', 'removed member cannot verify stale PIN')
  assert.deepEqual(disablePrivateHomeKiosk(db, {
    ...home(), serverVerifiedOwnerUserId: ownerId,
  }), { trustedHome: false, changed: true })
  assert.ok(db.prepare('SELECT revoked_at FROM family_sessions WHERE id=?')
    .get(kioskSessionId).revoked_at > 0,
  'retiring a kiosk must also retire its underlying Owner login')
  assert.equal(isPrivateHomeKioskTrusted(db, home()), false)
  assert.deepEqual(await attempt('9876'), { status: 'untrusted' })
})

test('shared Home PIN attempts rate-limit across people and trust is revoked with the session', async t => {
  const { db, ownerId, childId } = fixture(t)
  const calendarDb = new DatabaseSync(':memory:')
  t.after(() => calendarDb.close())
  calendarDb.exec('CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  calendarDb.exec("INSERT INTO people VALUES(99,'Linked child')")
  setFamilyMemberPersonLink(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, personId: 99, householdDatabase: calendarDb,
  })
  const now = Date.now()
  const sessionId = Number(db.prepare([
    'INSERT INTO family_sessions',
    '(user_id,token_hash,device_label,created_at,last_seen_at,expires_at,selected_profile_kind)',
    "VALUES (?,'ratelimit-kiosk','Fixture',?,?,?,'home')",
  ].join(' ')).run(ownerId, now, now, now + 3600000).lastInsertRowid)
  enrollPrivateHomeKiosk(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    serverVerifiedSessionId: sessionId,
  })
  setPrivateHomeActorPin(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, pin: '0000', householdDatabase: calendarDb,
  })
  const verifier = createPrivateHomePinVerifier()
  const attempt = (memberId, pin) => verifier.verify(db, {
    householdId: 'family-a', serverVerifiedSessionId: sessionId,
    targetUserId: memberId, pin, householdDatabase: calendarDb,
  })
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await attempt(i % 2 ? ownerId : childId, '9999'),
      { status: 'invalid' })
  }
  const blocked = await attempt(childId, '0000')
  assert.equal(blocked.status, 'limited')
  assert.ok(blocked.retryAfter > 0)
  db.prepare('UPDATE family_sessions SET revoked_at=? WHERE id=?')
    .run(Date.now(), sessionId)
  assert.equal(isPrivateHomeKioskTrusted(db, {
    householdId: 'family-a', serverVerifiedSessionId: sessionId,
  }), false)
  assert.deepEqual(await attempt(childId, '0000'), { status: 'untrusted' })
})

test('known API reads and event/list writes are categorized; unknown or alias routes fail closed', () => {
  const cases = [
    ['GET', '/api/events?from=2026-11-20', ['calendar.view']],
    ['HEAD', '/api/events', ['calendar.view']],
    ['GET', '/api/people', ['calendar.view']],
    ['GET', '/api/lists', ['lists.view']],
    ['POST', '/api/events', ['events.create']],
    ['POST', '/api/events/17/exceptions', ['events.edit', 'events.delete']],
    ['DELETE', '/api/events/17/exceptions/2026-11-20', ['events.edit']],
    ['DELETE', '/api/event-batches/abc-123', ['events.delete']],
    ['PUT', '/api/events/17', ['events.edit']],
    ['DELETE', '/api/events/17', ['events.delete']],
    ['POST', '/api/lists/1/items', ['lists.edit']],
    ['PUT', '/api/list-items/27', ['lists.edit']],
    ['POST', '/api/ai/intent', ['calendar.view']],
    ['POST', '/api/ai/reschedule-criteria', ['calendar.view']],
    ['POST', '/api/ai/reschedule-preview', ['calendar.view']],
    ['POST', '/api/ai/cancel-criteria', ['calendar.view']],
    ['POST', '/api/ai/cancel-preview', ['calendar.view']],
    ['POST', '/api/ai/cancel-matches', ['calendar.view']],
    ['POST', '/api/ai/reschedule-confirmed', ['events.edit']],
    ['POST', '/api/ai/cancel-confirmed', ['events.edit', 'events.delete']],
    ['POST', '/api/ai/event-action-confirm', ['events.edit', 'events.delete']],
    ['POST', '/api/recipes', ['recipes.edit']],
    ['GET', '/api/shared-events/accepted', ['calendar.view']],
    ['POST', '/api/shared-events/invite', ['events.create']],
    ['PUT', '/api/people/2', ['settings.manage']],
  ]
  for (const [method, path, expected] of cases) {
    assert.deepEqual(requiredFamilyMemberActions(method, path), expected, method + ' ' + path)
  }
  for (const [method, route] of [
    ['POST', '/api/tasks/7/complete'], // Assignment needs server-side task ownership.
    ['POST', '/api/ai/cancel-confirmed?claim=owner'],
    ['POST', '/api/ai/reschedule-confirmed/'],
    ['POST', '/API/ai/cancel-confirmed'],
    ['GET', '/api/ai/reschedule-confirmed'],
    ['DELETE', '/api/ai/cancel-confirmed'],
    ['POST', '/api/events/17/exceptions?bypass=1'],
    ['POST', '/api/events/0/exceptions'],
    ['DELETE', '/api/events/17/exceptions/2026-11-20/'],
    ['DELETE', '/api/events/17/exceptions/not-a-date'],
    ['DELETE', '/api/event-batches/BATCH-123'],
    ['DELETE', '/api/event-batches/abc%2f123'],
    ['DELETE', '/api/events/017'],
    ['DELETE', '/api/events/17/'],
    ['DELETE', '/API/EVENTS/17'],
    ['POST', '/api/events?unsafe=1'],
    ['POST', '/api/events%2f2'],
    ['PUT', '/api/list-items/7%2f'],
    ['GET', '/api/private-debug'],
    ['POST', '/api/unknown-action'],
    ['POST', '/api/capture/analyze-photo'],
  ]) assert.equal(requiredFamilyMemberActions(method, route), null, method + ' ' + route)
})

test('a Child cannot create events, alter lists or obtain delete via Arney; Owner retains classified actions', t => {
  const { db, ownerId, childId, adultId } = fixture(t)
  const check = (user, method, url) => authorizeFamilyMemberApiRequest(db, {
    serverVerifiedUserId: user, householdId: 'family-a', method, originalUrl: url,
  }).allowed
  assert.equal(check(childId, 'GET', '/api/events'), true)
  assert.equal(check(childId, 'POST', '/api/events'), false)
  assert.equal(check(childId, 'POST', '/api/lists/1/items'), false)
  assert.equal(check(childId, 'POST', '/api/ai/event-action-confirm'), false)
  assert.equal(check(childId, 'POST', '/api/ai/reschedule-confirmed'), false)
  assert.equal(check(childId, 'POST', '/api/ai/cancel-confirmed'), false)
  assert.equal(check(childId, 'POST', '/api/ai/cancel-preview'), true)
  assert.equal(check(childId, 'POST', '/api/tasks/5/complete'), false)
  assert.equal(check(adultId, 'POST', '/api/events'), true)
  assert.equal(check(adultId, 'POST', '/api/ai/event-action-confirm'), true)
  assert.equal(check(adultId, 'POST', '/api/ai/cancel-confirmed'), true)
  assert.equal(check(adultId, 'POST', '/api/ai/reschedule-confirmed'), true)
  assert.equal(check(ownerId, 'DELETE', '/api/events/5'), true)
  assert.equal(check(ownerId, 'GET', '/api/events'), true)
  assert.equal(check(ownerId, 'POST', '/api/unreviewed-action'), false)
  assert.equal(check(9999, 'GET', '/api/events'), false)
})

test('grant and revoke immediately change permissions without changing browser profile', t => {
  const { db, ownerId, childId } = fixture(t)
  const check = () => authorizeFamilyMemberApiRequest(db, {
    serverVerifiedUserId: childId, householdId: 'family-a',
    method: 'POST', originalUrl: '/api/events',
  }).allowed
  assert.equal(check(), false)
  setFamilyMemberPermission(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, action: 'events.create', enabled: true,
  })
  assert.equal(check(), true)
  setFamilyMemberPermission(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, action: 'events.create', enabled: false,
  })
  assert.equal(check(), false)
  db.prepare('UPDATE household_memberships SET disabled=1 WHERE user_id = ?').run(childId)
  assert.equal(authorizeFamilyMemberApiRequest(db, {
    serverVerifiedUserId: childId, householdId: 'family-a',
    method: 'GET', originalUrl: '/api/events',
  }).allowed, false)
})

test('real express middleware rejects Home avatar bypass, cross-family request headers and old AI delete aliases', async t => {
  const { db, ownerId, adultId, childId, outsiderId } = fixture(t)
  const app = express()
  app.use(express.json())
  // TEST FIXTURE ONLY: simulate authentication middleware setting verified
  // familyAccount. Production uses signed, HttpOnly server sessions instead.
  const signed = new Map([
    ['owner', ownerId], ['adult', adultId], ['child', childId], ['other', outsiderId],
  ])
  app.use((request, response, next) => {
    request.familyAccount = { user_id: signed.get(request.get('x-fixture-login')) ?? null }
    next()
  })
  const trustedHousehold = (request, response) => {
    const grant = lookupGrantedHouseholdForSessionUser(db, {
      serverVerifiedUserId: request.familyAccount.user_id,
      requestedHouseholdId: 'family-a',
    })
    if (!grant) {
      response.status(403).json({ error: 'No family access.' })
      return null
    }
    return grant
  }
  installPrivateMemberRouteEnforcement(app, { identityDatabase: db, trustedHousehold })
  app.get('/api/events', (_request, response) => response.json({ ok: true }))
  app.get('/api/people', (_request, response) => response.json({ ok: true }))
  app.post('/api/events', (_request, response) => response.json({ wrote: true }))
  app.post('/api/ai/event-action-confirm', (_request, response) => response.json({ wrote: true }))
  app.post('/api/ai/cancel-confirmed', (_request, response) => response.json({ wrote: true }))
  app.post('/api/ai/reschedule-confirmed', (_request, response) => response.json({ wrote: true }))
  app.post('/api/ai/cancel-preview', (_request, response) => response.json({ preview: true }))
  app.post('/api/lists/1/items', (_request, response) => response.json({ wrote: true }))
  app.post('/api/tasks/7/complete', (_request, response) => response.json({ wrote: true }))
  app.get('/api/households', (_request, response) => response.json({ ok: true }))
  app.get('/api/unreviewed-data', (_request, response) => response.json({ ok: true }))
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = 'http://127.0.0.1:' + server.address().port
  async function request(login, path, method = 'GET', body = undefined, otherHeaders = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { 'x-fixture-login': login, 'content-type': 'application/json',
        ...otherHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return response
  }
  assert.equal((await request('child', '/api/events')).status, 200)
  assert.equal((await request('child', '/api/events', 'POST', {
    selectedProfile: 'Home', actor: 'owner', memberType: 'adult',
  }, { 'x-household-id': 'family-b' })).status, 403)
  assert.equal((await request('child', '/api/ai/event-action-confirm', 'POST', {
    selectedProfile: 'Home',
  })).status, 403)
  assert.equal((await request('child', '/api/ai/cancel-confirmed', 'POST', {
    actor: 'owner', matchType: 'recurring_occurrence', selectedProfile: 'Home',
  })).status, 403)
  assert.equal((await request('child', '/api/ai/reschedule-confirmed', 'POST', {
    actor: 'owner', selectedProfile: 'Home',
  })).status, 403)
  assert.equal((await request('child', '/api/ai/cancel-preview', 'POST', {})).status, 200)
  assert.equal((await request('adult', '/api/ai/cancel-confirmed', 'POST', {})).status, 200)
  assert.equal((await request('adult', '/api/ai/reschedule-confirmed', 'POST', {})).status, 200)
  assert.equal((await request('child', '/api/lists/1/items', 'POST', {})).status, 403)
  assert.equal((await request('child', '/api/tasks/7/complete', 'POST', {})).status, 403)
  assert.equal((await request('child', '/api/unreviewed-data')).status, 403)
  assert.equal((await request('child', '/API/events')).status, 403, 'case-insensitive Express alias denied')
  assert.equal((await request('child', '/API/events', 'POST', {})).status, 403)
  assert.equal((await request('owner', '/API/events')).status, 403, 'even Owner uses reviewed canonical API routes')
  assert.equal((await request('other', '/api/events')).status, 403)
  assert.equal((await request('adult', '/api/events', 'POST', {})).status, 200)
  assert.equal((await request('owner', '/api/events', 'POST', {})).status, 200)
  assert.equal((await request('owner', '/api/unreviewed-data')).status, 403)
  assert.equal((await request('child', '/api/households')).status, 200)
})

test('recurring occurrence skips require edit and delete while restores only require edit', t => {
  const { db, ownerId, childId, adultId, outsiderId } = fixture(t)
  const authorized = (userId, method, originalUrl) =>
    authorizeFamilyMemberApiRequest(db, {
      serverVerifiedUserId: userId, householdId: 'family-a', method, originalUrl,
    }).allowed
  const skip = '/api/events/17/exceptions'
  const restore = '/api/events/17/exceptions/2026-11-20'
  const batch = '/api/event-batches/abc-123'
  for (const route of [["POST", skip], ["DELETE", restore], ["DELETE", batch]]) {
    assert.equal(authorized(childId, ...route), false)
    assert.equal(authorized(ownerId, ...route), true)
    assert.equal(authorized(outsiderId, ...route), false)
  }
  setFamilyMemberPermission(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, action: 'events.edit', enabled: true,
  })
  assert.equal(authorized(childId, 'DELETE', restore), true)
  assert.equal(authorized(childId, 'POST', skip), false,
    'an edit grant alone cannot hide a recurring occurrence')
  assert.equal(authorized(childId, 'DELETE', batch), false)
  setFamilyMemberPermission(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, action: 'events.delete', enabled: true,
  })
  assert.equal(authorized(childId, 'POST', skip), true)
  assert.equal(authorized(childId, 'DELETE', batch), true)
  setFamilyMemberPermission(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, action: 'events.delete', enabled: false,
  })
  assert.equal(authorized(childId, 'POST', skip), false)
  assert.equal(authorized(childId, 'DELETE', batch), false)
  assert.equal(authorized(adultId, 'POST', skip), true)
})

test('legacy Arney confirmation always follows the verified Adult/Child grants, never preview or body claims', t => {
  const { db, ownerId, childId, outsiderId } = fixture(t)
  const allowed = (userId, originalUrl) => authorizeFamilyMemberApiRequest(db, {
    serverVerifiedUserId: userId, householdId: 'family-a', method: 'POST', originalUrl,
  }).allowed
  const reschedule = '/api/ai/reschedule-confirmed'
  const cancel = '/api/ai/cancel-confirmed'
  const preview = '/api/ai/cancel-preview'
  assert.equal(allowed(childId, preview), true)
  assert.equal(allowed(childId, reschedule), false)
  assert.equal(allowed(childId, cancel), false)
  assert.equal(allowed(outsiderId, preview), false)
  assert.equal(allowed(ownerId, reschedule), true)
  assert.equal(allowed(ownerId, cancel), true)
  setFamilyMemberPermission(db, { householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, action: 'events.edit', enabled: true })
  assert.equal(allowed(childId, reschedule), true)
  assert.equal(allowed(childId, cancel), false,
    'edit-only Child cannot cancel or suppress a recurring occurrence')
  setFamilyMemberPermission(db, { householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, action: 'events.delete', enabled: true })
  assert.equal(allowed(childId, cancel), true)
  setFamilyMemberPermission(db, { householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, action: 'events.edit', enabled: false })
  assert.equal(allowed(childId, reschedule), false)
  assert.equal(allowed(childId, cancel), false,
    'delete-only Child cannot confirm unreviewed edit-versus-delete behavior')
  db.prepare('UPDATE household_memberships SET disabled = 1 WHERE user_id = ?').run(childId)
  assert.equal(allowed(childId, preview), false)
  assert.equal(allowed(childId, cancel), false)
})
