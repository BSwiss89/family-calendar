import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installFamilyAuth, setFamilyAccount } from '../Server/family-auth.mjs'
import { createFamilyMemberAccessTables } from '../Server/family-member-access.mjs'
import {
  registerHousehold, grantHouseholdMembership,
} from '../Server/household-memberships.mjs'
import {
  provisionEmptyHousehold,
} from '../Server/household-storage.mjs'
import { createPrivateGatewayDevicePersonResolver } from '../Server/private-gateway-device-profiles.mjs'

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Server')
const password = 'Disposable-Private-Household-Profile-Testing-Only!'
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'family-account-people-routing-'))
  const identity = new DatabaseSync(':memory:')
  t.after(() => { identity.close(); rmSync(root, { recursive: true, force: true }) })
  const userIds = {}
  for (const username of ['alice-account', 'bob-account', 'outsider-account']) {
    setFamilyAccount(identity, username, username, password)
    userIds[username] = identity.prepare('SELECT id FROM family_users WHERE username=?')
      .get(username).id
  }
  createFamilyMemberAccessTables(identity)
  for (const [householdId, name, username, people] of [
    ['family-a', 'Family A', 'alice-account', [[1, 'Alice in A'], [2, 'Alex in A']]],
    ['family-b', 'Family B', 'bob-account', [[1, 'Bob in B'], [99, 'Secret Person in B']]],
  ]) {
    registerHousehold(identity, { householdId, displayName: name })
    grantHouseholdMembership(identity, {
      serverVerifiedUserId: userIds[username], householdId, role: 'owner',
    })
    const storage = provisionEmptyHousehold({
      serverDirectory, storageRoot: root, householdId,
    })
    const db = new DatabaseSync(storage.databasePath)
    db.exec('CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    const insert = db.prepare('INSERT INTO people(id,name) VALUES (?,?)')
    for (const [id, personName] of people) insert.run(id, personName)
    db.close()
  }
  const resolver = createPrivateGatewayDevicePersonResolver({
    identityDatabase: identity, serverDirectory, storageRoot: root,
    routedHouseholdIds: ['family-a', 'family-b'],
  })
  return { root, identity, resolver, userIds }
}

async function site(t, identity, resolver) {
  const app = express()
  app.use('/api/auth/login', express.json({ limit: '32kb' }))
  app.use('/api/auth/device-profile', express.json({ limit: '8kb', strict: true }))
  installFamilyAuth(app, identity, serverDirectory, 'required', {
    cookieName: '__Host-fc_gateway_session',
    resolveDevicePersonName: resolver,
  })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const host = '127.0.0.1:' + server.address().port
  return { base: 'http://' + host, origin: 'https://' + host }
}

async function login(s, username) {
  const response = await fetch(s.base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: s.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, deviceLabel: 'Test phone' }),
  })
  assert.equal(response.status, 200)
  return response.headers.get('set-cookie').split(';')[0]
}

async function request(s, cookie, route, method = 'GET', body, origin = s.origin) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}) }
  if (method !== 'GET') {
    headers.Origin = origin
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(s.base + route, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: res.status, data }
}

test('central identity keeps no People table; signed device preferences use the correct household', async t => {
  const f = fixture(t)
  assert.equal(f.identity.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='people'"
  ).get().n, 0)
  const s = await site(t, f.identity, f.resolver)
  const alice = await login(s, 'alice-account')
  const bob = await login(s, 'bob-account')
  assert.equal((await request(s, alice, '/api/auth/device-profile', 'POST',
    { kind: 'person', personId: 1 })).status, 200)
  assert.equal((await request(s, bob, '/api/auth/device-profile', 'POST',
    { kind: 'person', personId: 1 })).status, 200)
  const aDevices = await request(s, alice, '/api/auth/devices')
  const bDevices = await request(s, bob, '/api/auth/devices')
  assert.equal(aDevices.status, 200)
  assert.equal(bDevices.status, 200)
  assert.equal(aDevices.data.devices[0].selectedProfile, 'Alice in A')
  assert.equal(bDevices.data.devices[0].selectedProfile, 'Bob in B')
  assert.equal((await request(s, alice, '/api/auth/device-profile', 'POST',
    { kind: 'person', personId: 99 })).status, 400,
    'Family A cannot select a Person that only exists in B')
  assert.equal((await request(s, alice, '/api/auth/devices')).data.devices[0].selectedProfile,
    'Alice in A', 'invalid cross-household attempt must not change session preference')
  const home = await request(s, alice, '/api/auth/device-profile', 'POST',
    { kind: 'home' })
  assert.equal(home.status, 200)
  assert.equal((await request(s, alice, '/api/auth/devices')).data.devices[0].selectedProfile,
    'Home', 'Home is a display preference only, not authorization')
  assert.equal((await request(s, null, '/api/auth/devices')).status, 401)
  assert.equal((await request(s, alice, '/api/auth/device-profile', 'POST',
    { kind: 'person', personId: 2 }, 'https://evil.example')).status, 403)
})

test('revoked household membership removes Person display without revoking central login', async t => {
  const f = fixture(t)
  const s = await site(t, f.identity, f.resolver)
  const alice = await login(s, 'alice-account')
  assert.equal((await request(s, alice, '/api/auth/device-profile', 'POST',
    { kind: 'person', personId: 1 })).status, 200)
  f.identity.prepare('UPDATE household_memberships SET disabled=1 WHERE user_id=?')
    .run(f.userIds['alice-account'])
  assert.equal((await request(s, alice, '/api/auth/device-profile', 'POST',
    { kind: 'person', personId: 2 })).status, 400)
  assert.equal((await request(s, alice, '/api/auth/devices')).data.devices[0].selectedProfile,
    null, 'a revoked household cannot disclose previously selected Person names')
  assert.equal((await request(s, alice, '/api/auth/status')).data.authenticated, true)
  assert.equal(f.resolver({ serverVerifiedUserId: f.userIds['outsider-account'], personId: 1 }), null)
  f.identity.prepare('UPDATE family_users SET disabled=1 WHERE id=?')
    .run(f.userIds['alice-account'])
  assert.equal((await request(s, alice, '/api/auth/devices')).status, 401)
})

test('a selected Person cannot authorize impersonation and unconfigured routes fail closed', t => {
  const f = fixture(t)
  assert.equal(f.resolver({ serverVerifiedUserId: f.userIds['bob-account'], personId: 2 }),
    null)
  assert.equal(f.resolver({ serverVerifiedUserId: 0, personId: 1 }), null)
  assert.equal(f.resolver({ serverVerifiedUserId: f.userIds['alice-account'], personId: -1 }),
    null)
  const other = createPrivateGatewayDevicePersonResolver({
    identityDatabase: f.identity, serverDirectory, storageRoot: f.root,
    routedHouseholdIds: ['family-b'],
  })
  assert.equal(other({ serverVerifiedUserId: f.userIds['alice-account'], personId: 1 }),
    null, 'No fallback to an unapproved family backend')
  assert.throws(() => createPrivateGatewayDevicePersonResolver({
    identityDatabase: f.identity, serverDirectory, storageRoot: f.root,
    routedHouseholdIds: [],
  }), /trusted central identity|approved private household/i)
  assert.throws(() => installFamilyAuth(express(), f.identity, serverDirectory, 'required', {
    resolveDevicePersonName: f.resolver,
  }), /restricted to the private gateway/)
})

test('newly enrolled backend routes immediately allow correct Person display, never another family', t => {
  const f = fixture(t)
  const routed = new Set()
  const resolver = createPrivateGatewayDevicePersonResolver({
    identityDatabase: f.identity, serverDirectory, storageRoot: f.root,
    getRoutedHouseholdIds: () => [...routed],
  })
  const a = { serverVerifiedUserId: f.userIds['alice-account'], personId: 1 }
  const b = { serverVerifiedUserId: f.userIds['bob-account'], personId: 1 }
  assert.equal(resolver(a), null, 'no configured backend is safe for first-family bootstrap')
  assert.equal(resolver(b), null)
  routed.add('family-a')
  assert.equal(resolver(a), 'Alice in A')
  assert.equal(resolver(b), null, 'routing Family A never exposes Family B')
  routed.add('family-b')
  assert.equal(resolver(b), 'Bob in B', 'new enrollment must work without restart')
  routed.delete('family-a')
  assert.equal(resolver(a), null, 'removed route immediately fails closed')
  assert.equal(resolver(b), 'Bob in B')
  const broken = createPrivateGatewayDevicePersonResolver({
    identityDatabase: f.identity, serverDirectory, storageRoot: f.root,
    getRoutedHouseholdIds: () => 'family-a',
  })
  assert.equal(broken(a), null, 'untrusted route shapes must not be accepted')
  const throwing = createPrivateGatewayDevicePersonResolver({
    identityDatabase: f.identity, serverDirectory, storageRoot: f.root,
    getRoutedHouseholdIds: () => { throw new Error('no routes') },
  })
  assert.equal(throwing(a), null, 'failed trusted route lookup must fail closed')
})
