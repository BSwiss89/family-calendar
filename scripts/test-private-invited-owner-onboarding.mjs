import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import express from 'express'
import { setFamilyAccount, installFamilyAuth } from '../Server/family-auth.mjs'
import {
  createIndependentHouseholdInvitationTables,
  issueIndependentHouseholdInvitation,
} from '../Server/independent-household-invitations.mjs'
import {
  createPrivateActivationRecords, approvePrivateHouseholdActivation,
} from '../Server/private-household-activation-records.mjs'
import {
  installPrivateIndependentHouseholdSignup,
} from '../Server/private-independent-household-signup.mjs'
import {
  installPrivateInvitedOwnerOnboarding, listMyInvitedHouseholdOnboarding,
} from '../Server/private-invited-owner-onboarding.mjs'
import {
  installPrivateSystemAdministrator,
} from '../Server/private-system-administration.mjs'

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Server')
const password = 'Only-Disposable-Invited-Owner-Secure-Password-2026!'
const operatorPassword = 'Only-Disposable-Operator-Secure-Password-2026!'

async function fixture(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-invited-owner-'))
  const storageRoot = path.join(work, 'households')
  fs.mkdirSync(storageRoot)
  const db = new DatabaseSync(path.join(work, 'identity.sqlite'))
  setFamilyAccount(db, 'operatorinvites', 'Verified System Operator', operatorPassword)
  setFamilyAccount(db, 'notinvited', 'Unrelated Account', password)
  createIndependentHouseholdInvitationTables(db)
  createPrivateActivationRecords(db)
  const operatorId = db.prepare(
    "SELECT id FROM family_users WHERE username='operatorinvites'"
  ).get().id
  const routed = new Set()
  const app = express()
  app.disable('x-powered-by')
  app.use('/api/auth/login', express.json({ limit: '32kb' }))
  installPrivateIndependentHouseholdSignup(app, {
    identityDatabase: db, serverDirectory: directory, storageRoot,
    trustedAdministratorUserIds: [operatorId],
  })
  installFamilyAuth(app, db, directory, 'required', {
    cookieName: '__Host-fc_gateway_session',
  })
  installPrivateSystemAdministrator(app, {
    identityDatabase: db, serverDirectory: directory,
    trustedAdministratorUserIds: [operatorId],
    routedHouseholdIds: [], // Static metadata fixture, not a real backend.
  })
  installPrivateInvitedOwnerOnboarding(app, {
    identityDatabase: db, serverDirectory: directory,
    getRoutedHouseholdIds: () => [...routed],
  })
  app.use('/api/admin', (_request, response) =>
    response.status(404).json({ error: 'Not found.' }))
  app.get('/api/households', (request, response) => {
    // Not an actual calendar route: this fixture tests only ownership and
    // onboarding. Other suites test real isolated backend routing.
    const id = request.familyAccount.user_id
    response.json({
      count: db.prepare([
        'SELECT COUNT(*) AS n FROM household_memberships m',
        'JOIN household_registry h ON h.id=m.household_id',
        'WHERE m.user_id=? AND m.disabled=0 AND h.disabled=0',
      ].join(' ')).get(id).n,
    })
  })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    db.close()
    fs.rmSync(work, { recursive: true, force: true })
  })
  const host = '127.0.0.1:' + server.address().port
  const base = 'http://' + host
  const origin = 'https://' + host
  async function req(url, { cookie, body, method } = {}) {
    const verb = method ?? (body === undefined ? 'GET' : 'POST')
    const response = await fetch(base + url, {
      redirect: 'manual', method: verb,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(verb !== 'GET' ? { Origin: origin } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = response.headers.get('content-type')?.includes('application/json')
      ? await response.json() : await response.text()
    return { response, data }
  }
  async function login(username, secret = password) {
    const result = await req('/api/auth/login', {
      body: { username, password: secret, deviceLabel: 'Disposable phone' },
    })
    assert.equal(result.response.status, 200, 'Password login for ' + username)
    const cookie = result.response.headers.get('set-cookie')
    assert.match(cookie, /Secure/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Strict/)
    return cookie.split(';')[0]
  }
  async function inviteAndJoin(username, householdName) {
    const invite = issueIndependentHouseholdInvitation(db, {
      serverVerifiedAdministratorUserId: operatorId,
      trustedAdministratorUserIds: [operatorId],
    })
    const payload = {
      token: invite.token, username, displayName: username,
      password, householdName,
    }
    const registration = await req('/api/households/create-from-invitation', {
      body: payload,
    })
    assert.equal(registration.response.status, 201)
    assert.deepEqual(registration.data, {
      ok: true, next: '/login', activation: 'pending',
    })
    assert.equal((await req('/api/households/create-from-invitation', {
      body: payload,
    })).response.status, 400, 'an invitation can never register a second Owner')
    const id = db.prepare([
      'SELECT h.storage_id AS householdId FROM household_registry h',
      'JOIN household_memberships m ON m.household_id=h.id',
      'JOIN family_users u ON u.id=m.user_id WHERE u.username=?',
    ].join(' ')).get(username).householdId
    return { id, cookie: await login(username) }
  }
  return { db, base, operatorId, routed, req, login, inviteAndJoin }
}

test('operator invitation creates two independent Owner logins; neither can view the other status', async t => {
  const { db, operatorId, req, login, inviteAndJoin } = await fixture(t)
  const [a, b] = await Promise.all([
    inviteAndJoin('owneroneinvite', 'First invited family'),
    inviteAndJoin('ownertwoinvite', 'Second invited family'),
  ])
  // Two registration calls can race on one SQLite file; the underlying
  // registration handlers must still serialize each one safely.
  assert.notEqual(a.id, b.id)
  const operator = await login('operatorinvites', operatorPassword)
  const unrelated = await login('notinvited')
  assert.equal((await req('/my-household')).response.status, 303)
  assert.equal((await req('/api/households/my-onboarding')).response.status, 401)
  assert.equal((await req('/my-household', { cookie: unrelated })).response.status, 403)
  assert.equal((await req('/my-household', { cookie: operator })).response.status, 403)
  assert.equal((await req('/system-admin', { cookie: a.cookie })).response.status, 403)
  assert.equal((await req('/api/admin/household-overview', {
    cookie: b.cookie,
  })).response.status, 403)
  const readA = await req('/api/households/my-onboarding?householdId=' +
    encodeURIComponent(b.id), { cookie: a.cookie })
  assert.equal(readA.response.status, 200)
  assert.deepEqual(readA.data.households, [{
    householdId: a.id, displayName: 'First invited family',
    state: 'pending-activation',
  }])
  const readB = await req('/api/households/my-onboarding', { cookie: b.cookie })
  assert.deepEqual(readB.data.households, [{
    householdId: b.id, displayName: 'Second invited family',
    state: 'pending-activation',
  }])
  assert.equal((await req('/my-household', { cookie: a.cookie })).response.status, 200)
  assert.equal((await req('/auth/my-household.js', { cookie: a.cookie })).response.status, 200)
  assert.equal((await req('/auth/my-household.js', { cookie: unrelated })).response.status, 403)
  const operatorOverview = await req('/api/admin/household-overview', {
    cookie: operator,
  })
  assert.equal(operatorOverview.response.status, 200)
  assert.equal(operatorOverview.data.households.length, 2)
  assert.equal(operatorOverview.data.households.every(x =>
    x.state === 'pending-activation' && x.memberCount === 1 &&
    x.ownerCount === 1), true)
  assert.equal((await req('/api/households', { cookie: a.cookie })).data.count, 1)
  assert.equal((await req('/api/households', { cookie: b.cookie })).data.count, 1)
  assert.equal(db.prepare([
    'SELECT COUNT(*) AS n FROM household_memberships WHERE role="owner"',
  ].join(' ')).get().n, 2, 'one Owner per independent family, not two Owners for one family')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n, 4)
  assert.equal((await req('/api/households/my-onboarding', { cookie: unrelated }))
    .data.households.length, 0)
  assert.equal(listMyInvitedHouseholdOnboarding(db, {
    serverVerifiedUserId: operatorId, routedHouseholdIds: [a.id, b.id],
  }).length, 0, 'operator does not acquire tenant Owner rights')
})

test('Owner sees pending, approved-unrouted and configured states without browser activation', async t => {
  const { db, req, routed, inviteAndJoin } = await fixture(t)
  const a = await inviteAndJoin('activatingowner', 'Awaiting review')
  assert.equal((await req('/api/households/my-onboarding', {
    cookie: a.cookie,
  })).data.households[0].state, 'pending-activation')
  // In the real private gateway, only a separately verified localhost
  // backend can call the privileged enrollHouseholdBackend callback. This
  // isolated status test simulates that TRUSTED supervisor decision only.
  assert.throws(() => approvePrivateHouseholdActivation(db, {
    householdId: 'family-' + 'b'.repeat(24),
  }), /active invited household owner/)
  const approved = approvePrivateHouseholdActivation(db, {
    householdId: a.id,
  })
  assert.equal(approved.householdId, a.id)
  assert.equal((await req('/api/households/my-onboarding', {
    cookie: a.cookie,
  })).data.households[0].state, 'approved-awaiting-route')
  routed.add(a.id)
  assert.equal((await req('/api/households/my-onboarding', {
    cookie: a.cookie,
  })).data.households[0].state, 'configured-route')
  const accountId = db.prepare(
    "SELECT id FROM family_users WHERE username='activatingowner'"
  ).get().id
  db.prepare('UPDATE household_memberships SET disabled = 1 WHERE user_id=?')
    .run(accountId)
  assert.deepEqual((await req('/api/households/my-onboarding', {
    cookie: a.cookie,
  })).data.households, [])
  assert.equal((await req('/my-household', { cookie: a.cookie })).response.status, 403)
})
