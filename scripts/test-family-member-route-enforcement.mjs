import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { DatabaseSync } from 'node:sqlite'
import {
  registerHousehold, grantHouseholdMembership, lookupGrantedHouseholdForSessionUser,
} from '../Server/household-memberships.mjs'
import {
  createFamilyMemberAccessTables, setFamilyMemberType, setFamilyMemberPermission,
} from '../Server/family-member-access.mjs'
import {
  requiredFamilyMemberActions, authorizeFamilyMemberApiRequest,
  installPrivateMemberRouteEnforcement,
} from '../Server/family-member-route-enforcement.mjs'

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
    ['GET', '/api/capture-inbox', ['captures.view']],
    ['POST', '/api/capture-inbox', ['captures.edit']],
    ['PATCH', '/api/capture-inbox/7/type', ['captures.edit']],
    ['PATCH', '/api/capture-inbox/7/analysis', ['captures.edit']],
    ['DELETE', '/api/capture-inbox/7', ['captures.edit']],
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
    ['POST', '/api/capture-inbox/7/analyze'], // Expensive local AI is not yet approved for tenants.
    ['POST', '/api/capture-inbox/7/analysis'],
    ['PATCH', '/api/capture-inbox/07/type'],
    ['PATCH', '/api/capture-inbox/7/type?privilege=owner'],
    ['PATCH', '/api/capture-inbox/7/TYPE'],
    ['PATCH', '/API/capture-inbox/7/type'],
    ['DELETE', '/api/capture-inbox/7/'],
    ['GET', '/api/capture-inbox/7'],
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

test('Capture Inbox requires distinct household capture rights and ignores Home/role spoofing', async t => {
  const { db, ownerId, adultId, childId, outsiderId } = fixture(t)
  const check = (userId, method, originalUrl) => authorizeFamilyMemberApiRequest(db, {
    serverVerifiedUserId: userId, householdId: 'family-a', method, originalUrl,
  }).allowed
  const read = ['GET', '/api/capture-inbox']
  const upload = ['POST', '/api/capture-inbox']
  const classify = ['PATCH', '/api/capture-inbox/7/type']
  const update = ['PATCH', '/api/capture-inbox/7/analysis']
  const remove = ['DELETE', '/api/capture-inbox/7']
  for (const route of [read, upload, classify, update, remove]) {
    assert.equal(check(ownerId, ...route), true, 'Owner: ' + route.join(' '))
    assert.equal(check(adultId, ...route), true, 'Adult: ' + route.join(' '))
    assert.equal(check(childId, ...route), false, 'Child: ' + route.join(' '))
    assert.equal(check(outsiderId, ...route), false, 'Other household: ' + route.join(' '))
  }
  // Access to events or recipes is not a substitute for a grant to read a
  // Capture Inbox that can contain screenshots of several types of data.
  setFamilyMemberPermission(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, action: 'recipes.view', enabled: true,
  })
  assert.equal(check(childId, ...read), false)
  setFamilyMemberPermission(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, action: 'captures.view', enabled: true,
  })
  assert.equal(check(childId, ...read), true)
  for (const route of [upload, classify, update, remove]) {
    assert.equal(check(childId, ...route), false, 'view-only Child cannot edit captures')
  }
  setFamilyMemberPermission(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, action: 'captures.edit', enabled: true,
  })
  assert.equal(check(childId, ...upload), true)
  assert.equal(check(childId, ...classify), true)
  assert.equal(check(childId, ...update), true)
  assert.equal(check(childId, ...remove), true)
  assert.equal(check(childId, 'POST', '/api/capture-inbox/7/analyze'), false,
    'an explicit Capture Inbox grant cannot bypass the unreviewed AI analyzer')
  setFamilyMemberPermission(db, {
    householdId: 'family-a', serverVerifiedOwnerUserId: ownerId,
    targetUserId: childId, action: 'captures.edit', enabled: false,
  })
  assert.equal(check(childId, ...upload), false, 'grant revocation applies immediately')
  db.prepare('UPDATE household_memberships SET disabled=1 WHERE user_id=?').run(childId)
  assert.equal(check(childId, ...read), false, 'membership revocation overrides capture grant')

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.familyAccount = { user_id: ({
      owner: ownerId, adult: adultId, child: childId, other: outsiderId,
    })[req.get('x-fixture-login')] ?? null }
    next()
  })
  const trustedHousehold = (req, res) => {
    const membership = lookupGrantedHouseholdForSessionUser(db, {
      serverVerifiedUserId: req.familyAccount.user_id,
      requestedHouseholdId: 'family-a',
    })
    if (!membership) res.status(403).json({ error: 'No family access.' })
    return membership
  }
  installPrivateMemberRouteEnforcement(app, {
    identityDatabase: db, trustedHousehold,
  })
  app.get('/api/capture-inbox', (_req, res) => res.json({ privateCaptures: true }))
  app.post('/api/capture-inbox', (_req, res) => res.json({ saved: true }))
  app.patch('/api/capture-inbox/:id/type', (_req, res) => res.json({ modified: true }))
  const listener = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
  t.after(() => new Promise(resolve => listener.close(resolve)))
  const base = 'http://127.0.0.1:' + listener.address().port
  async function request(member, route, method = 'GET', body = undefined) {
    const response = await fetch(base + route, {
      method,
      headers: { 'x-fixture-login': member,
        'x-household-id': 'family-b', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return response.status
  }
  assert.equal(await request('adult', '/api/capture-inbox'), 200)
  assert.equal(await request('owner', '/api/capture-inbox', 'POST'), 200)
  assert.equal(await request('child', '/api/capture-inbox'), 403)
  assert.equal(await request('child', '/api/capture-inbox', 'POST', {
    selectedProfile: 'Home', role: 'owner',
  }), 403, 'a forged Home avatar cannot upload')
  assert.equal(await request('child', '/api/capture-inbox/7/type', 'PATCH', {
    selectedProfile: 'Home', actor: 'owner',
  }), 403, 'a forged Home avatar cannot reclassify a capture')
  assert.equal(await request('other', '/api/capture-inbox'), 403)
  assert.equal(await request('owner', '/API/capture-inbox'), 403,
    'Express case-insensitive aliases are not a permission bypass')
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
