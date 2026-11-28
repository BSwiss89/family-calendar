import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import express from 'express'
import { setFamilyAccount, installFamilyAuth } from '../Server/family-auth.mjs'
import {
  registerHousehold, grantHouseholdMembership,
} from '../Server/household-memberships.mjs'
import {
  createIndependentHouseholdInvitationTables,
} from '../Server/independent-household-invitations.mjs'
import { createPrivateActivationRecords } from '../Server/private-household-activation-records.mjs'
import {
  installPrivateSystemAdministrator, listPrivateOperatorHouseholdOverview,
} from '../Server/private-system-administration.mjs'

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Server')
const password = 'Private-Admin-Test-Only-Long-Password-2026'
const now = Date.now()
const familyId = 'family-' + 'a'.repeat(24)

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  for (const [username, displayName] of [
    ['systemoperator', 'Calendar System Operator'],
    ['householdowner', 'Household Owner'],
    ['householdadult', 'Household Adult'],
    ['householdchild', 'Household Child'],
    ['randomowner', 'Unrelated Family Owner'],
    ['secondoperator', 'Another Operator'],
  ]) setFamilyAccount(db, username, displayName, password)
  createIndependentHouseholdInvitationTables(db)
  createPrivateActivationRecords(db)
  const id = username => db.prepare('SELECT id FROM family_users WHERE username = ?')
    .get(username).id
  const operatorId = id('systemoperator')
  const secondOperatorId = id('secondoperator')
  const ownerId = id('householdowner')
  const adultId = id('householdadult')
  const childId = id('householdchild')
  registerHousehold(db, { householdId: familyId, displayName: 'Invited Sample Family' })
  for (const [userId, role] of [
    [ownerId, 'owner'], [adultId, 'member'], [childId, 'member'],
  ]) {
    grantHouseholdMembership(db, {
      serverVerifiedUserId: userId, householdId: familyId, role,
    })
  }
  const key = db.prepare('SELECT id FROM household_registry WHERE storage_id = ?')
    .get(familyId).id
  db.prepare([
    'INSERT INTO independent_household_invitations',
    '(issuer_user_id,token_hash,created_at,expires_at,',
    'redeemed_at,redeemed_user_id,household_id)',
    'VALUES (?,?,?,?,?,?,?)',
  ].join(' ')).run(
    operatorId, 'a'.repeat(64), now - 120000, now + 7200000,
    now - 100000, ownerId, key,
  )
  db.prepare([
    'INSERT INTO independent_household_invitations',
    '(issuer_user_id,token_hash,created_at,expires_at)',
    'VALUES (?,?,?,?)',
  ].join(' ')).run(operatorId, 'b'.repeat(64), now - 5000, now + 7200000)
  return { db, operatorId, secondOperatorId, ownerId, adultId, childId, key }
}

test('operator overview shows registration metadata, not private family content or online claims', t => {
  const { db, operatorId, secondOperatorId, key } = fixture(t)
  const read = () => listPrivateOperatorHouseholdOverview(db, {
    serverVerifiedAdministratorUserId: operatorId,
    trustedAdministratorUserIds: [operatorId],
    routedHouseholdIds: [familyId], now,
  })
  const overview = read()
  assert.equal(overview.households.length, 1)
  assert.equal(overview.invitations.length, 1)
  assert.deepEqual(overview.households[0], {
    householdId: familyId, displayName: 'Invited Sample Family',
    state: 'pending-activation',
    memberCount: 3, ownerCount: 1, ownerDisplayName: 'Household Owner', ownerUsername: 'householdowner',
  })
  assert.match(overview.availabilityNote, /not live health/)
  assert.ok(!JSON.stringify(overview).includes('password_hash'))
  assert.ok(!JSON.stringify(overview).includes('token_hash'))
  assert.throws(() => listPrivateOperatorHouseholdOverview(db, {
    serverVerifiedAdministratorUserId: secondOperatorId,
    trustedAdministratorUserIds: [operatorId],
    routedHouseholdIds: [familyId],
  }), /administrator permission/)
  // Registered is not activated merely because a backend port is configured.
  db.prepare(
    'INSERT INTO private_activated_households(household_id,approved_at) VALUES (?,?)'
  ).run(key, now)
  assert.equal(read().households[0].state, 'configured-route')
  assert.equal(listPrivateOperatorHouseholdOverview(db, {
    serverVerifiedAdministratorUserId: operatorId,
    trustedAdministratorUserIds: [operatorId],
    routedHouseholdIds: [],
  }).households[0].state, 'approved-unrouted')
})

async function site(t) {
  const { db, operatorId, ownerId } = fixture(t)
  const app = express()
  app.use('/api/auth/login', express.json({ limit: '32kb' }))
  installFamilyAuth(app, db, directory, 'required', {
    cookieName: '__Host-fc_gateway_session',
  })
  installPrivateSystemAdministrator(app, {
    identityDatabase: db, serverDirectory: directory,
    trustedAdministratorUserIds: [operatorId],
    routedHouseholdIds: [familyId],
  })
  // Never proxy an unknown system route to an unauthenticated family backend.
  app.use('/api/admin', (_req, res) =>
    res.status(404).json({ error: 'Not found.' }))
  app.get('/api/events', (_req, res) =>
    res.json({ title: 'Sensitive household event not for operator dashboard' }))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = 'http://127.0.0.1:' + server.address().port
  const origin = 'https://127.0.0.1:' + server.address().port
  async function login(username) {
    const result = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: {
        Origin: origin, 'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username, password, deviceLabel: 'Test operator browser' }),
    })
    assert.equal(result.status, 200)
    return result.headers.get('set-cookie').split(';')[0]
  }
  async function get(route, cookie) {
    return fetch(base + route, {
      headers: cookie ? { Cookie: cookie } : {},
      redirect: 'manual',
    })
  }
  return { db, operatorId, ownerId, get, login }
}

test('dedicated system UI and JS/CSS deny ordinary household Owners and unauthenticated users', async t => {
  const { get, login } = await site(t)
  const owner = await login('householdowner')
  const operator = await login('systemoperator')
  for (const asset of [
    '/system-admin', '/system-admin/app.js', '/system-admin/styles.css',
    '/api/admin/household-overview',
  ]) {
    const anonymous = await get(asset)
    assert.equal(anonymous.status, asset.startsWith('/api/') ? 401 : 303,
      asset + ' needs a real session')
    const unrelated = await get(asset, owner)
    assert.equal(unrelated.status, 403, asset + ' never grants Owner operator power')
    const admin = await get(asset, operator)
    assert.equal(admin.status, 200, asset + ' is available to allowlisted operator')
    assert.equal(admin.headers.get('cache-control'), 'no-store')
  }
  const page = await (await get('/system-admin', operator)).text()
  assert.match(page, /Family Calendar System Administration/)
  assert.match(page, /independent households/i)
  const code = await (await get('/system-admin/app.js', operator)).text()
  assert.match(code, /verify this account holder|Verify this account holder/)
  const css = await (await get('/system-admin/styles.css', operator)).text()
  assert.match(css, /@media/)
  const overview = await (await get('/api/admin/household-overview', operator)).json()
  assert.equal(overview.households[0].memberCount, 3)
  assert.equal(overview.households[0].ownerDisplayName, 'Household Owner')
  assert.equal(overview.households[0].ownerUsername, 'householdowner')
  for (const hidden of ['householdadult','householdchild','randomowner','password_hash','token_hash','Sensitive household event']) assert.ok(!JSON.stringify(overview).includes(hidden))
  assert.equal((await get('/api/admin/unreviewed-secret', operator)).status, 404)
})

test('system operator allowlisting is independent of household role; disabling operator revokes view', async t => {
  const { db, operatorId, get, login } = await site(t)
  const child = await login('householdchild')
  const randomOwner = await login('randomowner')
  const nonallowlistedOperator = await login('secondoperator')
  const operator = await login('systemoperator')
  for (const cookie of [child, randomOwner, nonallowlistedOperator]) {
    assert.equal((await get('/api/admin/household-overview', cookie)).status, 403)
    assert.equal((await get('/system-admin', cookie)).status, 403)
  }
  assert.equal((await get('/system-admin', operator)).status, 200)
  db.prepare('UPDATE family_users SET disabled = 1 WHERE id = ?').run(operatorId)
  // Existing account middleware must reject the disabled user's old cookie.
  assert.equal((await get('/system-admin', operator)).status, 303)
  assert.equal((await get('/api/admin/household-overview', operator)).status, 401)
})
