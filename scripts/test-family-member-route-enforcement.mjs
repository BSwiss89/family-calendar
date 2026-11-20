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
    ['PUT', '/api/events/17', ['events.edit']],
    ['DELETE', '/api/events/17', ['events.delete']],
    ['POST', '/api/lists/1/items', ['lists.edit']],
    ['PUT', '/api/list-items/27', ['lists.edit']],
    ['POST', '/api/ai/intent', ['calendar.view']],
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
    ['POST', '/api/ai/cancel-confirmed'],
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
  assert.equal(check(childId, 'POST', '/api/tasks/5/complete'), false)
  assert.equal(check(adultId, 'POST', '/api/events'), true)
  assert.equal(check(adultId, 'POST', '/api/ai/event-action-confirm'), true)
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
  assert.equal((await request('child', '/api/ai/cancel-confirmed', 'POST', {})).status, 403)
  assert.equal((await request('child', '/api/lists/1/items', 'POST', {})).status, 403)
  assert.equal((await request('child', '/api/tasks/7/complete', 'POST', {})).status, 403)
  assert.equal((await request('child', '/api/unreviewed-data')).status, 403)
  assert.equal((await request('other', '/api/events')).status, 403)
  assert.equal((await request('adult', '/api/events', 'POST', {})).status, 200)
  assert.equal((await request('owner', '/api/events', 'POST', {})).status, 200)
  assert.equal((await request('owner', '/api/unreviewed-data')).status, 403)
  assert.equal((await request('child', '/api/households')).status, 200)
})
