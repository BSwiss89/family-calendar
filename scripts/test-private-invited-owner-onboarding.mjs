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
  installPrivateFamilyEntryRouting, resolvePrivateFamilyLanding,
} from '../Server/private-family-entry-routing.mjs'
import {
  installPrivateSystemAdministrator,
} from '../Server/private-system-administration.mjs'
import { resolveHouseholdStorage } from '../Server/household-storage.mjs'
import { startPrivateHouseholdGateway } from '../Server/private-household-gateway.mjs'

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
  const redirect = session => resolvePrivateFamilyLanding(db, {
    serverVerifiedUserId: session.user_id,
    trustedAdministratorUserIds: [operatorId],
    routedHouseholdIds: [...routed],
  })
  installFamilyAuth(app, db, directory, 'required', {
    cookieName: '__Host-fc_gateway_session',
    resolveSignedInLanding: redirect,
  })
  installPrivateSystemAdministrator(app, {
    identityDatabase: db, serverDirectory: directory, storageRoot,
    trustedAdministratorUserIds: [operatorId],
    // This changes only when our disposable fixture simulates a TRUSTED
    // already-reviewed operator route; ordinary HTTP cannot change it.
    getRoutedHouseholdIds: () => [...routed],
  })
  installPrivateInvitedOwnerOnboarding(app, {
    identityDatabase: db, serverDirectory: directory,
    getRoutedHouseholdIds: () => [...routed],
  })
  installPrivateFamilyEntryRouting(app, {
    identityDatabase: db, trustedAdministratorUserIds: [operatorId],
    getRoutedHouseholdIds: () => [...routed],
  })
  app.get('/', (_request, response) => response.send('Disposable household calendar route'))
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
  return { db, base, storageRoot, operatorId, routed, req, login, inviteAndJoin }
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
  const readiness = await req('/api/admin/activation-readiness', {
    cookie: operator,
  })
  assert.equal(readiness.response.status, 200)
  assert.equal(readiness.data.kind, 'read-only-private-activation-preflight-v1')
  assert.equal(readiness.data.canActivateFromBrowser, false)
  assert.deepEqual(new Set(readiness.data.checks.map(x => x.householdId)),
    new Set([a.id, b.id]))
  assert.equal(readiness.data.checks.every(x =>
    x.stage === 'storage-reviewed-awaiting-backend-proof' &&
    x.storagePreflight === 'passed'), true)
  assert.equal((await req('/api/admin/activation-readiness', {
    cookie: a.cookie,
  })).response.status, 403, 'household Owner cannot inspect system preflight')
  assert.equal((await req('/api/admin/activation-readiness')).response.status, 401)
  assert.equal((await req('/api/admin/activate', {
    cookie: operator, body: { householdId: a.id },
  })).response.status, 404, 'the HTTP dashboard cannot activate a household')
  assert.equal((await req('/api/households/my-onboarding', {
    cookie: a.cookie,
  })).data.households[0].state, 'pending-activation',
  'read-only activation inspection does not change the household')
  assert.equal((await req('/api/households', { cookie: a.cookie })).data.count, 1)
  assert.equal((await req('/api/households', { cookie: b.cookie })).data.count, 1)
  assert.equal(db.prepare([
    "SELECT COUNT(*) AS n FROM household_memberships WHERE role = 'owner'",
  ].join(' ')).get().n, 2, 'one Owner per independent family, not two Owners for one family')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n, 4)
  assert.equal((await req('/api/households/my-onboarding', { cookie: unrelated }))
    .data.households.length, 0)
  assert.equal(listMyInvitedHouseholdOnboarding(db, {
    serverVerifiedUserId: operatorId, routedHouseholdIds: [a.id, b.id],
  }).length, 0, 'operator does not acquire tenant Owner rights')
})

test('Owner sees pending, approved-unrouted and configured states without browser activation', async t => {
  const { db, req, login, routed, inviteAndJoin } = await fixture(t)
  const a = await inviteAndJoin('activatingowner', 'Awaiting review')
  const operator = await login('operatorinvites', operatorPassword)
  const adminOverview = async () => (await req('/api/admin/household-overview', {
    cookie: operator,
  })).data.households[0]
  const adminReadiness = async () => (await req('/api/admin/activation-readiness', {
    cookie: operator,
  })).data.checks[0]
  assert.equal((await adminOverview()).state, 'pending-activation')
  assert.deepEqual(await adminReadiness(), {
    householdId: a.id,
    stage: 'storage-reviewed-awaiting-backend-proof',
    storagePreflight: 'passed',
  })
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
  assert.equal((await adminOverview()).state, 'approved-unrouted')
  assert.deepEqual(await adminReadiness(), {
    householdId: a.id, stage: 'approved-awaiting-route',
    storagePreflight: 'not-evaluated',
  })
  routed.add(a.id)
  assert.equal((await adminOverview()).state, 'configured-route',
    'newly enrolled private backend must appear without gateway restart')
  assert.deepEqual(await adminReadiness(), {
    householdId: a.id, stage: 'approved-route-configured',
    storagePreflight: 'not-evaluated',
  })
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


test('pending activation inspection holds damaged or populated tenant storage without copying data or granting access', async t => {
  const { db, storageRoot, req, login, inviteAndJoin } = await fixture(t)
  const owner = await inviteAndJoin('integrityowner', 'Fresh private family')
  const admin = await login('operatorinvites', operatorPassword)
  const inspect = async () => {
    const result = await req('/api/admin/activation-readiness?householdId=' +
      encodeURIComponent('family-' + 'f'.repeat(24)), { cookie: admin })
    assert.equal(result.response.status, 200)
    assert.equal(result.data.checks.length, 1,
      'caller-supplied household IDs must never change the operator scope')
    assert.equal(result.data.checks[0].householdId, owner.id)
    return result.data.checks[0]
  }
  assert.equal((await inspect()).stage, 'storage-reviewed-awaiting-backend-proof')
  const storage = resolveHouseholdStorage({
    serverDirectory: directory, storageRoot, householdId: owner.id,
  })
  // This is a disposable filesystem created in a unique OS temp folder.
  const household = new DatabaseSync(storage.databasePath)
  try {
    household.exec('CREATE TABLE events(id INTEGER PRIMARY KEY, title TEXT NOT NULL)')
    household.prepare('INSERT INTO events(title) VALUES (?)')
      .run('Private preactivation data must not be silently adopted')
    assert.deepEqual(await inspect(), {
      householdId: owner.id, stage: 'blocked-review',
      storagePreflight: 'failed',
    })
    assert.equal(household.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1,
      'the inspector does not overwrite or delete a tenant event')
    household.prepare('DELETE FROM events').run()
  } finally {
    household.close()
  }
  assert.equal((await inspect()).stage, 'storage-reviewed-awaiting-backend-proof')
  fs.writeFileSync(path.join(storage.uploadFolder, 'unreviewed-people-photo.txt'),
    'disposable private file')
  assert.equal((await inspect()).stage, 'blocked-review')
  assert.equal(fs.existsSync(path.join(storage.uploadFolder,
    'unreviewed-people-photo.txt')), true)
  fs.unlinkSync(path.join(storage.uploadFolder, 'unreviewed-people-photo.txt'))
  assert.equal((await inspect()).stage, 'storage-reviewed-awaiting-backend-proof')
  const actualOwner = db.prepare(
    "SELECT id FROM family_users WHERE username = 'integrityowner'"
  ).get().id
  db.prepare('UPDATE household_memberships SET disabled = 1 WHERE user_id = ?')
    .run(actualOwner)
  assert.deepEqual(await inspect(), {
    householdId: owner.id, stage: 'blocked-review',
    storagePreflight: 'not-evaluated',
  })
  assert.equal((await req('/api/households/my-onboarding', {
    cookie: owner.cookie,
  })).data.households.length, 0)
  db.prepare('UPDATE household_memberships SET disabled = 0 WHERE user_id = ?')
    .run(actualOwner)
  assert.equal((await inspect()).stage, 'storage-reviewed-awaiting-backend-proof')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM private_activated_households')
    .get().n, 0, 'readiness can never register approval')
})

test('signed-in invited Owner and operator receive session-derived destinations, not a guessed calendar', async t => {
  const { db, req, routed, operatorId, login, inviteAndJoin } = await fixture(t)
  const owner = await inviteAndJoin('landingowner', 'Pending Landing Family')
  const operator = await login('operatorinvites', operatorPassword)
  const unrelated = await login('notinvited')
  const landing = (cookie, url = '/api/auth/landing') => req(url, { cookie })

  const denied = await landing(undefined)
  assert.equal(denied.response.status, 401)
  const pending = await landing(owner.cookie)
  assert.equal(pending.response.status, 200)
  assert.deepEqual(pending.data, { destination: '/my-household' })
  assert.equal((await landing(owner.cookie, '/')).response.status, 303)
  assert.equal((await landing(owner.cookie, '/')).response.headers.get('location'), '/my-household')
  assert.equal((await landing(owner.cookie, '/login')).response.headers.get('location'),
    '/my-household', 'a remembered login must not bypass pending-activation status')
  assert.equal((await landing(owner.cookie, '/api/auth/landing?householdId=not-their-home'))
    .data.destination, '/my-household')
  assert.equal((await landing(owner.cookie, '/my-household')).response.status, 200)

  const admin = await landing(operator)
  assert.deepEqual(admin.data, { destination: '/system-admin' })
  assert.equal((await landing(operator, '/')).response.headers.get('location'), '/system-admin')
  assert.equal((await landing(operator, '/login')).response.headers.get('location'), '/system-admin')
  assert.equal((await landing(operator, '/system-admin')).response.status, 200)
  assert.equal((await landing(owner.cookie, '/system-admin')).response.status, 403)
  assert.equal((await landing(unrelated)).data.destination, '/',
    'unrelated signed-in account cannot pretend to be invited Owner or operator')
  assert.equal((await landing(owner.cookie, '/api/admin/household-overview')).response.status, 403)

  approvePrivateHouseholdActivation(db, { householdId: owner.id })
  assert.equal((await landing(owner.cookie)).data.destination, '/my-household',
    'approval is not proof of an actual configured private route')
  routed.add(owner.id)
  assert.equal((await landing(owner.cookie)).data.destination, '/',
    'an approved, configured invited Owner may open the existing calendar')
  assert.equal((await landing(owner.cookie, '/login')).response.headers.get('location'), '/')
  assert.equal((await landing(owner.cookie, '/')).response.status, 200)
  assert.equal((await landing(owner.cookie, '/')).data, 'Disposable household calendar route')

  // A malicious selected People profile or claimed role cannot give the
  // unrelated account access to the operator or invited Owner landing.
  assert.equal((await req('/api/auth/landing?role=operator&profile=Home',
    { cookie: unrelated })).data.destination, '/')
  db.prepare('UPDATE family_users SET disabled = 1 WHERE id = ?')
    .run(operatorId)
  assert.equal((await landing(operator)).response.status, 401)
  assert.equal((await landing(operator, '/system-admin')).response.status, 303)
  const ownerId = db.prepare("SELECT id FROM family_users WHERE username='landingowner'")
    .get().id
  db.prepare('UPDATE household_memberships SET disabled=1 WHERE user_id=?').run(ownerId)
  assert.equal((await landing(owner.cookie)).data.destination, '/',
    'revoked Owner membership cannot retain an activated Owner landing claim')
  assert.equal((await landing(owner.cookie, '/my-household')).response.status, 403)
})

test('private login destination never trusts unconfigured identity or arbitrary external URLs', async t => {
  const { db, operatorId } = await fixture(t)
  assert.equal(resolvePrivateFamilyLanding(db, {
    serverVerifiedUserId: 0, trustedAdministratorUserIds: [operatorId],
    routedHouseholdIds: [],
  }), null)
  assert.throws(() => resolvePrivateFamilyLanding(db, {
    serverVerifiedUserId: operatorId, trustedAdministratorUserIds: [operatorId],
    routedHouseholdIds: 'https://attacker.example',
  }), /Trusted private login routing/)
  assert.throws(() => installFamilyAuth(express(), db, directory, 'required', {
    resolveSignedInLanding: () => 'https://attacker.example',
  }), /restricted to the private gateway/)
  assert.throws(() => installPrivateFamilyEntryRouting(express(), {
    identityDatabase: db, trustedAdministratorUserIds: [operatorId],
  }), /Authenticated private gateway/)
})

test('first invited household can register with NO existing backend, without gaining calendar access', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-first-family-bootstrap-'))
  const storageRoot = path.join(work, 'households')
  fs.mkdirSync(storageRoot)
  const identityDatabase = new DatabaseSync(path.join(work, 'central.sqlite'))
  let gateway
  try {
    setFamilyAccount(identityDatabase, 'bootstrapoperator', 'Bootstrap Operator', operatorPassword)
    const operatorId = identityDatabase.prepare(
      "SELECT id FROM family_users WHERE username='bootstrapoperator'"
    ).get().id
    const args = {
      identityDatabase, serverDirectory: directory, storageRoot,
      backendPorts: {}, backendTokens: {},
      independentHouseholdAdministratorUserIds: [operatorId],
    }
    await assert.rejects(startPrivateHouseholdGateway(args),
      /At least one explicit household backend/,
      'missing opt-in must reject an accidental zero-backend configuration')
    await assert.rejects(startPrivateHouseholdGateway({
      ...args, allowEmptyGatewayBootstrap: true,
      independentHouseholdAdministratorUserIds: [],
    }), /explicit trusted administrator/,
    'untrusted empty control plane must not start')
    gateway = await startPrivateHouseholdGateway({
      ...args, allowEmptyGatewayBootstrap: true,
    })
    const base = gateway.base
    const request = async (route, cookie, body) => {
      const method = body === undefined ? 'GET' : 'POST'
      const response = await fetch(base + route, {
        method, redirect: 'manual',
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : {
            Origin: 'https://' + new URL(base).host,
            'Content-Type': 'application/json',
          }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const payload = response.headers.get('content-type')?.includes('application/json')
        ? await response.json() : await response.text()
      return { response, payload }
    }
    const signIn = async (username, pass) => {
      const login = await request('/api/auth/login', null,
        { username, password: pass, deviceLabel: 'Temporary test device' })
      assert.equal(login.response.status, 200)
      return login.response.headers.get('set-cookie').split(';')[0]
    }
    const operator = await signIn('bootstrapoperator', operatorPassword)
    assert.equal((await request('/api/auth/landing', operator)).payload.destination,
      '/system-admin')
    assert.equal((await request('/system-admin', operator)).response.status, 200)
    const invitation = issueIndependentHouseholdInvitation(identityDatabase, {
      serverVerifiedAdministratorUserId: operatorId,
      trustedAdministratorUserIds: [operatorId],
    })
    const signup = await request('/api/households/create-from-invitation', null, {
      token: invitation.token, username: 'brandnewhouseholdowner',
      displayName: 'First private Owner', password,
      householdName: 'New Family With No Backend',
    })
    assert.equal(signup.response.status, 201)
    const owner = await signIn('brandnewhouseholdowner', password)
    assert.equal((await request('/api/auth/landing', owner)).payload.destination,
      '/my-household')
    assert.equal((await request('/', owner)).response.headers.get('location'),
      '/my-household')
    const onboarding = await request('/api/households/my-onboarding', owner)
    assert.equal(onboarding.response.status, 200)
    assert.equal(onboarding.payload.households.length, 1)
    assert.equal(onboarding.payload.households[0].state, 'pending-activation')
    assert.equal((await request('/my-household', owner)).response.status, 200)
    assert.equal((await request('/api/admin/household-overview', owner)).response.status,
      403, 'Owner never becomes the system operator')
    assert.equal((await request('/api/events', owner)).response.status, 503,
      'a pending Owner cannot use a calendar backend that does not exist')
    const oversight = await request('/api/admin/household-overview', operator)
    assert.equal(oversight.response.status, 200)
    assert.equal(oversight.payload.households.length, 1)
    assert.equal(oversight.payload.households[0].state, 'pending-activation')
    assert.equal(identityDatabase.prepare(
      'SELECT COUNT(*) AS n FROM private_activated_households'
    ).get().n, 0, 'bootstrap must never automatically approve a household')
    assert.equal(gateway.port > 0 && ![3001, 13002].includes(gateway.port),
      true, 'test harness does not take an installed calendar port')
  } finally {
    if (gateway) await gateway.close()
    identityDatabase.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
})


test('two invited Owners activate into isolated real localhost backends without gateway restart', {
  // The two disposable calendar child processes must finish their real
  // startup/binding checks; no installed LIVE/TEST process or data is used.
  timeout: 120000,
}, async () => {
  const { spawn } = await import('node:child_process')
  const { randomBytes } = await import('node:crypto')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-two-invited-activation-'))
  const storageRoot = path.join(work, 'households')
  fs.mkdirSync(storageRoot)
  const identityDatabase = new DatabaseSync(path.join(work, 'identity.sqlite'))
  const backends = []
  const occupied = new Set([3001, 13001, 13002, 13003, 11434])
  let gateway
  async function freePort() {
    for (let i = 0; i < 30; i++) {
      const probe = createServer()
      await new Promise((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', resolve)
      })
      const port = probe.address().port
      await new Promise(resolve => probe.close(resolve))
      if (!occupied.has(port) && port >= 1024) {
        occupied.add(port)
        return port
      }
    }
    throw new Error('No unused private test port available.')
  }
  async function startBackend(householdId) {
    const port = await freePort()
    const upstreamToken = randomBytes(32).toString('hex')
    const child = spawn(process.execPath, [path.join(directory, 'index.mjs')], {
      cwd: path.dirname(directory),
      env: {
        ...process.env,
        FAMILY_CALENDAR_HOST: '127.0.0.1',
        FAMILY_CALENDAR_PORT: String(port),
        FAMILY_CALENDAR_AUTH_MODE: 'disabled',
        FAMILY_CALENDAR_HOUSEHOLD_STORAGE_ROOT: storageRoot,
        FAMILY_CALENDAR_HOUSEHOLD_ID: householdId,
        FAMILY_CALENDAR_HOUSEHOLD_TEST_ONLY: 'YES',
        FAMILY_CALENDAR_PRIVATE_UPSTREAM_TOKEN: upstreamToken,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let logs = ''
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', bytes => { logs = (logs + bytes.toString()).slice(-2500) })
    }
    const backend = { householdId, port, upstreamToken, child, logs: () => logs }
    backends.push(backend)
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break
      try {
        const health = await fetch('http://127.0.0.1:' + port + '/api/health', {
          headers: { 'x-family-calendar-upstream-token': upstreamToken },
          signal: AbortSignal.timeout(1000),
        })
        if (health.status === 200 && (await health.json()).status === 'ok') {
          return backend
        }
      } catch { /* Disposable Node backend still starting. */ }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('Disposable backend did not start: ' + logs)
  }
  async function stopBackend(backend) {
    const child = backend.child
    if (child.exitCode !== null || child.signalCode !== null) return
    const stopped = new Promise(resolve => child.once('exit', resolve))
    if (child.connected) child.send({
      type: 'private-household-test-shutdown', householdId: backend.householdId,
    })
    const orderly = await Promise.race([
      stopped.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 6000)),
    ])
    if (!orderly) {
      child.kill()
      await Promise.race([
        stopped,
        new Promise(resolve => setTimeout(resolve, 2500)),
      ])
      throw new Error('Disposable backend refused supervised shutdown.')
    }
  }
  try {
    setFamilyAccount(identityDatabase, 'twofamilyoperator', 'Operator', operatorPassword)
    const operatorId = identityDatabase.prepare(
      "SELECT id FROM family_users WHERE username='twofamilyoperator'"
    ).get().id
    gateway = await startPrivateHouseholdGateway({
      identityDatabase, serverDirectory: directory, storageRoot,
      backendPorts: {}, backendTokens: {},
      independentHouseholdAdministratorUserIds: [operatorId],
      allowEmptyGatewayBootstrap: true,
      // This is the strict member-role pilot. Other existing test and hosted
      // calendars keep their previous default-OFF enforcement behavior.
      enforceFamilyMemberPermissions: true,
    })
    let base = gateway.base
    async function request(route, { cookie, body, method, headers = {} } = {}) {
      const verb = method ?? (body === undefined ? 'GET' : 'POST')
      const response = await fetch(base + route, {
        method: verb, redirect: 'manual',
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(verb !== 'GET' ? { Origin: 'https://' + new URL(base).host } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(7000),
      })
      const payload = response.headers.get('content-type')?.includes('application/json')
        ? await response.json() : await response.text()
      return { status: response.status, payload, response }
    }
    async function login(username, secret) {
      const result = await request('/api/auth/login', {
        body: { username, password: secret, deviceLabel: 'Disposable device' },
      })
      assert.equal(result.status, 200, 'login ' + username)
      const sessionCookie = result.response.headers.get('set-cookie')
      assert.match(sessionCookie, /__Host-fc_gateway_session=/)
      return sessionCookie.split(';')[0]
    }
    const operator = await login('twofamilyoperator', operatorPassword)
    async function registerOwner(username, householdName) {
      const issued = await request('/api/households/independent-invitations', {
        cookie: operator, method: 'POST',
      })
      assert.equal(issued.status, 201)
      const signup = await request('/api/households/create-from-invitation', {
        body: {
          token: issued.payload.token, username, displayName: username,
          password, householdName,
        },
      })
      assert.equal(signup.status, 201)
      const cookie = await login(username, password)
      const status = await request('/api/households/my-onboarding', { cookie })
      assert.equal(status.status, 200)
      assert.equal(status.payload.households.length, 1)
      assert.equal(status.payload.households[0].state, 'pending-activation')
      return { id: status.payload.households[0].householdId, cookie }
    }
    const a = await registerOwner('firsttwofamilyowner', 'Private family one')
    const b = await registerOwner('secondtwofamilyowner', 'Private family two')
    assert.notEqual(a.id, b.id)
    assert.equal((await request('/api/events', { cookie: a.cookie })).status, 503)
    assert.equal((await request('/api/events', { cookie: b.cookie })).status, 503)
    assert.equal((await request('/api/events')).status, 401)
    assert.equal((await request('/api/events', { cookie: operator })).status, 403)
    assert.equal((await request('/api/admin/activate', {
      cookie: operator, body: { householdId: a.id },
    })).status, 404, 'browser cannot approve even its own invitation')

    // The wrong tenant's running backend must not activate a valid invited
    // Owner, even when a trusted test supervisor supplies its real secret.
    const backendB = await startBackend(b.id)
    await assert.rejects(gateway.enrollHouseholdBackend({
      householdId: a.id, port: backendB.port, upstreamToken: backendB.upstreamToken,
    }), /refused unverified household backend/)
    assert.equal((await request('/api/events', { cookie: a.cookie })).status, 503)
    assert.equal(identityDatabase.prepare(
      'SELECT COUNT(*) AS n FROM private_activated_households'
    ).get().n, 0, 'rejected tenant binding cannot create approval')

    const backendA = await startBackend(a.id)
    assert.deepEqual(await gateway.enrollHouseholdBackend({
      householdId: a.id, port: backendA.port, upstreamToken: backendA.upstreamToken,
    }), { householdId: a.id, activation: 'active' })
    assert.equal((await request('/api/auth/landing', {
      cookie: a.cookie,
    })).payload.destination, '/')
    assert.equal((await request('/api/events', { cookie: a.cookie })).status, 200)
    assert.equal((await request('/api/events', {
      cookie: b.cookie, headers: { 'x-household-id': a.id },
    })).status, 503, 'pending B cannot spoof the active Family A')
    assert.equal((await request('/api/auth/landing', {
      cookie: b.cookie,
    })).payload.destination, '/my-household')
    await assert.rejects(gateway.enrollHouseholdBackend({
      householdId: b.id, port: backendA.port, upstreamToken: backendA.upstreamToken,
    }), /already in use|overlap/i, 'two families cannot share one backend port')
    assert.deepEqual(await gateway.enrollHouseholdBackend({
      householdId: b.id, port: backendB.port, upstreamToken: backendB.upstreamToken,
    }), { householdId: b.id, activation: 'active' })
    assert.equal((await request('/api/events', { cookie: b.cookie })).status, 200)
    // Home PIN is a future kiosk preference, NOT a bypass around the current
    // verified user session/role checks. Default ON, controlled by the one
    // signed-in household Owner plus their password, isolated from B.
    const homePinRoute = '/api/households/home-pin'
    assert.deepEqual((await request(homePinRoute, { cookie: a.cookie })).payload,
      { pinEnabled: true })
    assert.deepEqual((await request(homePinRoute, { cookie: b.cookie })).payload,
      { pinEnabled: true })
    assert.equal((await request(homePinRoute, { cookie: operator })).status, 403)
    assert.equal((await request(homePinRoute, {
      cookie: a.cookie, body: { pinEnabled: false, ownerPassword: 'incorrect' },
    })).status, 403, 'wrong Owner password cannot disable shared Home PIN')
    assert.equal((await request(homePinRoute, {
      cookie: a.cookie, body: { pinEnabled: 'false', ownerPassword: password },
    })).status, 400, 'the input must be a strict boolean')
    assert.equal((await request(homePinRoute, {
      cookie: a.cookie, body: { pinEnabled: false, ownerPassword: password },
      headers: { Origin: 'https://untrusted.example' },
    })).status, 403, 'cross-origin form cannot bypass account protection')
    assert.equal((await request(homePinRoute, {
      cookie: a.cookie, body: { pinEnabled: false, ownerPassword: password },
      headers: { 'x-household-id': b.id },
    })).status, 200)
    assert.deepEqual((await request(homePinRoute, { cookie: a.cookie })).payload,
      { pinEnabled: false })
    assert.deepEqual((await request(homePinRoute, { cookie: b.cookie })).payload,
      { pinEnabled: true }, 'A Owner toggle never affects B')
    assert.equal((await request(homePinRoute, {
      cookie: b.cookie, body: { pinEnabled: false, ownerPassword: password },
      headers: { 'x-household-id': a.id },
    })).status, 200)
    assert.deepEqual((await request(homePinRoute, { cookie: a.cookie })).payload,
      { pinEnabled: false }, 'B cannot change A policy through forged header')
    assert.equal((await request(homePinRoute, {
      cookie: a.cookie, body: { pinEnabled: true, ownerPassword: password },
    })).status, 200, 'Owner can re-enable a disabled Home PIN')
    assert.deepEqual((await request(homePinRoute, { cookie: a.cookie })).payload,
      { pinEnabled: true })
    assert.deepEqual((await request(homePinRoute, { cookie: b.cookie })).payload,
      { pinEnabled: false })
    assert.equal((await request(homePinRoute + '/', { cookie: a.cookie })).status, 404,
      'noncanonical PIN API aliases cannot read the policy')

    // The original Capture Inbox was intentionally retired. There is no
    // reason for a multi-family gateway to expose its old API as a side door.
    // The real backend may still retain historical records for safe recovery.
    for (const owner of [a, b]) {
      assert.equal((await request('/api/capture-inbox', {
        cookie: owner.cookie,
      })).status, 404, 'no legacy inbox read access after activation')
      assert.equal((await request('/api/capture-inbox', {
        cookie: owner.cookie, body: { note: 'legacy upload attempt' },
      })).status, 404, 'no legacy inbox upload access after activation')
      assert.equal((await request('/api/capture-inbox/1', {
        cookie: owner.cookie, method: 'DELETE',
      })).status, 404, 'no legacy inbox deletion access after activation')
    }
    assert.equal((await request('/api/auth/landing', {
      cookie: b.cookie,
    })).payload.destination, '/')

    // Real post-activation writes must reach ONLY the signed-in Owner's
    // verified family, even when both freshly provisioned SQLite databases
    // assign the same numeric IDs and the browser spoofs another tenant.
    const eventA = await request('/api/events', {
      cookie: a.cookie, body: {
        date: '2026-12-20', title: 'Only invited household A', time: '12:00',
      }, headers: { 'x-household-id': b.id },
    })
    const eventB = await request('/api/events', {
      cookie: b.cookie, body: {
        date: '2026-12-21', title: 'Only invited household B', time: '13:00',
      }, headers: { 'x-household-id': a.id },
    })
    assert.equal(eventA.status, 201)
    assert.equal(eventB.status, 201)
    assert.equal(eventA.payload.id, eventB.payload.id,
      'disposable tenants intentionally reuse the same event row ID')
    const editedA = await request('/api/events/' + eventB.payload.id, {
      cookie: a.cookie, method: 'PUT',
      body: { date: '2026-12-20', title: 'Edited only in invited A', time: '12:30' },
      headers: { 'x-household-id': b.id },
    })
    assert.equal(editedA.status, 200)
    const ownEventsA = await request('/api/events?householdId=' + encodeURIComponent(b.id), {
      cookie: a.cookie, headers: { 'x-household-id': b.id },
    })
    const ownEventsB = await request('/api/events?householdId=' + encodeURIComponent(a.id), {
      cookie: b.cookie, headers: { 'x-household-id': a.id },
    })
    assert.equal(ownEventsA.status, 200)
    assert.equal(ownEventsB.status, 200)
    assert.deepEqual(ownEventsA.payload.map(e => e.title), ['Edited only in invited A'])
    assert.deepEqual(ownEventsB.payload.map(e => e.title), ['Only invited household B'])

    const listA = await request('/api/lists', {
      cookie: a.cookie, body: { name: 'Invited A shopping' },
      headers: { 'x-household-id': b.id },
    })
    const listB = await request('/api/lists', {
      cookie: b.cookie, body: { name: 'Invited B shopping' },
      headers: { 'x-household-id': a.id },
    })
    assert.equal(listA.status, 201)
    assert.equal(listB.status, 201)
    assert.equal(listA.payload.id, listB.payload.id,
      'disposable tenants intentionally reuse the same list row ID')
    assert.equal((await request('/api/lists', {
      cookie: a.cookie, headers: { 'x-household-id': b.id },
    })).payload[0].name, 'Invited A shopping')
    assert.equal((await request('/api/lists', {
      cookie: b.cookie, headers: { 'x-household-id': a.id },
    })).payload[0].name, 'Invited B shopping')
    const deleteA = await request('/api/lists/' + listB.payload.id, {
      cookie: a.cookie, method: 'DELETE', headers: { 'x-household-id': b.id },
    })
    assert.equal(deleteA.status, 200)
    assert.deepEqual((await request('/api/lists', { cookie: a.cookie })).payload, [])
    assert.equal((await request('/api/lists', { cookie: b.cookie })).payload[0].name,
      'Invited B shopping', 'a forged tenant header cannot delete B data')
    assert.equal((await request('/api/events/' + eventB.payload.id, {
      cookie: a.cookie, method: 'DELETE', headers: { 'x-household-id': b.id },
    })).status, 200)
    assert.deepEqual((await request('/api/events', { cookie: a.cookie })).payload, [])
    assert.deepEqual((await request('/api/events', { cookie: b.cookie })).payload
      .map(e => e.title), ['Only invited household B'])

    // A household Owner can invite a non-Owner account, but that account is
    // NOT allowed to use calendar APIs until the Owner configures a role.
    // All checks below go through real signed sessions, the optional strict
    // gateway role middleware and the separate localhost calendar backends.
    const memberInvitation = await request('/api/households/member-invitations', {
      cookie: a.cookie, method: 'POST',
    })
    assert.equal(memberInvitation.status, 201)
    assert.match(memberInvitation.payload.token, /^[a-f0-9]{64}$/)
    const memberUsername = 'invitedfamilychild'
    const memberSignup = await request('/api/households/join', {
      body: {
        token: memberInvitation.payload.token,
        username: memberUsername, displayName: 'Invited family Child', password,
      },
    })
    assert.equal(memberSignup.status, 201)
    assert.equal(memberSignup.response.headers.get('set-cookie'), null,
      'joining cannot automatically grant an authenticated session')
    const childCookie = await login(memberUsername, password)
    assert.equal((await request(homePinRoute, {
      cookie: childCookie, body: { pinEnabled: false, ownerPassword: password },
    })).status, 403, 'Child cannot toggle PIN using a guessed Owner password')
    const memberId = identityDatabase.prepare(
      'SELECT id FROM family_users WHERE username = ?'
    ).get(memberUsername).id
    assert.equal((await request('/api/events', { cookie: childCookie })).status, 403,
      'unconfigured member fails closed, even with a real signed login')
    assert.equal((await request('/api/households/member-access', {
      cookie: childCookie,
    })).status, 403, 'Child/member never gains the Owner roster')
    const memberTypeUrl = '/api/households/members/' + memberId + '/type'
    const memberGrantUrl = '/api/households/members/' + memberId + '/permission'
    assert.equal((await request(memberTypeUrl, {
      cookie: b.cookie, body: {
        memberType: 'adult', ownerPassword: password,
      },
    })).status, 403, 'another Owner cannot change this family member')
    assert.equal((await request(memberTypeUrl, {
      cookie: a.cookie, body: {
        memberType: 'child', ownerPassword: password,
      },
    })).status, 200)
    assert.equal((await request('/api/households/my-member-access', {
      cookie: childCookie,
    })).payload.memberType, 'child')
    assert.equal((await request('/api/events', { cookie: childCookie })).status, 200)
    assert.equal((await request('/api/people', { cookie: childCookie })).status, 200)
    assert.equal((await request('/api/lists', { cookie: childCookie })).status, 403,
      'Child has no list-view grant by default')
    const childHome = await request('/api/auth/device-profile', {
      cookie: childCookie, body: { kind: 'home' },
    })
    assert.equal(childHome.status, 200)
    assert.equal((await request('/api/events', {
      cookie: childCookie,
      body: { title: 'Forged Home event', date: '2026-12-22',
        selectedProfile: 'Home', role: 'owner' },
      headers: { 'x-household-id': b.id },
    })).status, 403, 'Home avatar and household header cannot elevate Child')
    assert.equal((await request('/api/events/' + eventB.payload.id, {
      cookie: childCookie, method: 'DELETE',
      headers: { 'x-household-id': b.id },
    })).status, 403)
    assert.equal((await request('/api/lists', {
      cookie: childCookie, body: { name: 'Unauthorized shopping list' },
    })).status, 403)
    assert.deepEqual((await request('/api/events', { cookie: b.cookie })).payload
      .map(event => event.title), ['Only invited household B'])

    // Actual Owner password step-up can explicitly allow one action, and
    // revoking that grant must take effect on the same signed-in session.
    assert.equal((await request(memberGrantUrl, {
      cookie: a.cookie, body: {
        action: 'events.create', enabled: true, ownerPassword: password,
      },
    })).status, 200)
    const authorizedChildEvent = await request('/api/events', {
      cookie: childCookie, body: {
        date: '2026-12-23', title: 'A Child-created event in family A', time: '09:00',
      }, headers: { 'x-household-id': b.id },
    })
    assert.equal(authorizedChildEvent.status, 201)
    assert.deepEqual((await request('/api/events', { cookie: b.cookie })).payload
      .map(event => event.title), ['Only invited household B'],
    'a Child grant in A can never write to B')
    assert.equal((await request(memberGrantUrl, {
      cookie: a.cookie, body: {
        action: 'events.create', enabled: false, ownerPassword: password,
      },
    })).status, 200)
    assert.equal((await request('/api/events', {
      cookie: childCookie, body: {
        date: '2026-12-24', title: 'Must not be created', time: '10:00',
      },
    })).status, 403)

    // Upgrading to Adult changes the effective permissions ONLY inside the
    // verified family. A second Owner cannot see or remove this member.
    assert.equal((await request(memberTypeUrl, {
      cookie: a.cookie, body: {
        memberType: 'adult', ownerPassword: password,
      },
    })).status, 200)
    assert.equal((await request('/api/households/my-member-access', {
      cookie: childCookie,
    })).payload.memberType, 'adult')
    const adultList = await request('/api/lists', {
      cookie: childCookie, body: { name: 'Adult shopping within A' },
      headers: { 'x-household-id': b.id },
    })
    assert.equal(adultList.status, 201)
    assert.deepEqual((await request('/api/lists', { cookie: b.cookie })).payload
      .map(list => list.name), ['Invited B shopping'])
    const otherOwnerMembers = await request('/api/households/member-access', {
      cookie: b.cookie,
    })
    assert.equal(otherOwnerMembers.status, 200)
    assert.equal(otherOwnerMembers.payload.members.some(member =>
      member.userId === memberId), false)
    assert.equal((await request('/api/households/members/' + memberId + '/remove', {
      cookie: b.cookie, method: 'POST',
    })).status, 404, 'another Owner cannot remove the member')
    const memberRemoved = await request('/api/households/members/' + memberId + '/remove', {
      cookie: a.cookie, method: 'POST',
    })
    assert.equal(memberRemoved.status, 200)
    assert.equal((await request('/api/events', { cookie: childCookie })).status, 403,
      'revoked member immediately loses calendar data access')
    assert.equal((await request('/api/lists', { cookie: childCookie })).status, 403,
      'revoked member immediately loses list access')
    assert.equal((await request('/api/events', { cookie: b.cookie })).status, 200,
      'revocation in household A never affects B')

    // Reuse the same local Person ID to prove lookup is tenant-scoped, not a
    // central People table or the currently selected browser avatar.
    const personId = 991
    for (const [owner, display] of [
      [a, 'Visible only to household one'],
      [b, 'Visible only to household two'],
    ]) {
      const storage = resolveHouseholdStorage({
        serverDirectory: directory, storageRoot, householdId: owner.id,
      })
      const db = new DatabaseSync(storage.databasePath)
      try {
        db.prepare([
          'INSERT INTO people(id,name,color,image,sort_order)',
          'VALUES (?,?,?,NULL,0)',
        ].join(' ')).run(personId, display, '#64748b')
      } finally { db.close() }
      const selected = await request('/api/auth/device-profile', {
        cookie: owner.cookie, body: { kind: 'person', personId },
      })
      assert.equal(selected.status, 200)
      const devices = await request('/api/auth/devices', { cookie: owner.cookie })
      assert.equal(devices.status, 200)
      assert.equal(devices.payload.devices[0].selectedProfile, display)
    }
    // A verified Owner creates a real actor PIN only for an account linked to
    // a current Person in A's own calendar database. Selecting Home alone
    // never approves a kiosk or unlocks the PIN for another household.
    const ownerAId = identityDatabase.prepare(
      'SELECT id FROM family_users WHERE username=?'
    ).get('firsttwofamilyowner').id
    const memberLink = await request(
      '/api/households/members/' + ownerAId + '/person', {
        cookie: a.cookie, body: { ownerPassword: password, personId },
      })
    assert.equal(memberLink.status, 200, 'Owner can link their current family Person')
    const homeDevice = '/api/households/home-device'
    const verifyPin = '/api/households/home-actor/verify'
    const setOwnerPin = '/api/households/home-pins/' + ownerAId
    assert.deepEqual((await request(homeDevice, { cookie: a.cookie })).payload,
      { trustedHome: false })
    assert.equal((await request(homeDevice + '/enroll', {
      cookie: a.cookie, body: { ownerPassword: password },
    })).status, 403, 'unselected Home device cannot be enrolled')
    assert.equal((await request('/api/auth/device-profile', {
      cookie: a.cookie, body: { kind: 'home' },
    })).status, 200)
    assert.deepEqual((await request(homeDevice, { cookie: a.cookie })).payload,
      { trustedHome: false }, 'selecting Home does not make a trusted kiosk')
    assert.equal((await request(homeDevice + '/enroll', {
      cookie: a.cookie, body: { ownerPassword: 'incorrect' },
    })).status, 403, 'Owner password is required to register a shared device')
    assert.deepEqual((await request(homeDevice + '/enroll', {
      cookie: a.cookie, body: { ownerPassword: password },
    })).payload, { trustedHome: true })
    assert.deepEqual((await request(homeDevice, { cookie: a.cookie })).payload,
      { trustedHome: true })
    assert.deepEqual((await request(homeDevice, { cookie: b.cookie })).payload,
      { trustedHome: false }, 'B is not enrolled by A device setup')
    assert.equal((await request(setOwnerPin, {
      cookie: b.cookie, body: { ownerPassword: password, pin: '2468' },
    })).status, 400, 'Owner B cannot assign Owner A private PIN')
    assert.equal((await request(setOwnerPin, {
      cookie: a.cookie, body: { ownerPassword: password, pin: '2468' },
      headers: { 'x-household-id': b.id },
    })).status, 200)
    const wrongPin = await request(verifyPin, {
      cookie: a.cookie, body: { memberId: ownerAId, pin: '0000' },
    })
    assert.equal(wrongPin.status, 403)
    const verifiedPin = await request(verifyPin, {
      cookie: a.cookie, body: { memberId: ownerAId, pin: '2468' },
      headers: { 'x-household-id': b.id },
    })
    assert.equal(verifiedPin.status, 200)
    assert.equal(verifiedPin.payload.verified, true)
    assert.match(verifiedPin.payload.proof, /^[a-f0-9]{64}$/)
    assert.equal(verifiedPin.payload.actorUserId, ownerAId)
    const untrustedSession = await login('firsttwofamilyowner', password)
    assert.equal((await request('/api/auth/devices', { cookie: a.cookie })).status, 403,
      'a shared kiosk cannot inspect or revoke Owner personal devices')
    assert.equal((await request('/api/households/member-access', {
      cookie: a.cookie,
    })).status, 403, 'shared Home cannot read privileged Owner account roster')
    assert.equal((await request('/api/households/member-invitations', {
      cookie: a.cookie, method: 'POST',
    })).status, 403, 'shared Home cannot issue Owner-only invitations')
    assert.equal((await request('/uploads/unsafe-image.jpg', {
      cookie: a.cookie, body: { pretend: 'owner upload' },
    })).status, 403, 'an unreviewed non-API upload cannot inherit kiosk Owner authority')
    assert.equal((await request('/api/events', {
      cookie: a.cookie, body: {
        date: '2026-12-26', title: 'PIN missing must not create event', time: '15:00',
        createdBy: 'owner', role: 'owner', selectedProfile: 'Home',
      },
    })).status, 428, 'PIN-enabled shared Home cannot inherit Owner event-create rights')
    assert.equal((await request('/api/events', {
      cookie: a.cookie, body: {
        date: '2026-12-26', title: 'Forged actor should not create', time: '15:00',
      }, headers: { 'x-fc-home-actor-proof': '0'.repeat(64) },
    })).status, 428, 'arbitrary actor proof cannot authorize writes')
    const ownerHomeCreate = await request('/api/events', {
      cookie: a.cookie,
      body: { date: '2026-12-26', title: 'Owner verified at kiosk', time: '15:00' },
      headers: { 'x-fc-home-actor-proof': verifiedPin.payload.proof },
    })
    assert.equal(ownerHomeCreate.status, 201)
    const homeCreator = await request('/api/event-creators', { cookie: a.cookie })
    assert.equal(homeCreator.status, 200)
    assert.equal(homeCreator.payload.creators.find(
      creator => creator.eventId === ownerHomeCreate.payload.id,
    )?.displayName, 'firsttwofamilyowner')

    assert.equal((await request(verifyPin, {
      cookie: untrustedSession, body: { memberId: ownerAId, pin: '2468' },
    })).status, 403, 'same account on another device cannot borrow kiosk trust')
    assert.equal((await request(verifyPin, {
      cookie: b.cookie, body: { memberId: ownerAId, pin: '2468' },
    })).status, 403, 'other household cannot use the PIN or trusted device')

    // Invite a real Child using the Owner's separately authenticated PHONE,
    // link a distinct Person in family A, then use that Child's PIN on kiosk.
    const kioskChildInvite = await request('/api/households/member-invitations', {
      cookie: untrustedSession, method: 'POST',
    })
    assert.equal(kioskChildInvite.status, 201)
    const newHomeChild = 'kioskverifiedchild'
    assert.equal((await request('/api/households/join', {
      body: {
        token: kioskChildInvite.payload.token, username: newHomeChild,
        displayName: 'Home verified child', password,
      },
    })).status, 201)
    const childHomeUserId = identityDatabase.prepare(
      'SELECT id FROM family_users WHERE username=?',
    ).get(newHomeChild).id
    const childHomeCookie = await login(newHomeChild, password)
    assert.equal((await request('/api/households/members/' + childHomeUserId + '/type', {
      cookie: untrustedSession, body: {
        memberType: 'child', ownerPassword: password,
      },
    })).status, 200)
    const childHomePersonId = 992
    {
      const storage = resolveHouseholdStorage({
        serverDirectory: directory, storageRoot, householdId: a.id,
      })
      const db = new DatabaseSync(storage.databasePath)
      try {
        db.prepare([
          'INSERT INTO people(id,name,color,image,sort_order)',
          'VALUES (?,?,?,NULL,0)',
        ].join(' ')).run(childHomePersonId, 'Home verified child', '#64748b')
      } finally { db.close() }
    }
    assert.equal((await request('/api/households/members/' + childHomeUserId + '/person', {
      cookie: untrustedSession, body: {
        personId: childHomePersonId, ownerPassword: password,
      },
    })).status, 200)
    assert.equal((await request('/api/households/home-pins/' + childHomeUserId, {
      cookie: untrustedSession, body: { pin: '1357', ownerPassword: password },
    })).status, 200)
    const verifiedChild = await request(verifyPin, {
      cookie: a.cookie, body: { memberId: childHomeUserId, pin: '1357' },
      headers: { 'x-household-id': b.id },
    })
    assert.equal(verifiedChild.status, 200)
    assert.equal(verifiedChild.payload.actorUserId, childHomeUserId)
    assert.equal((await request('/api/events', {
      cookie: a.cookie, body: {
        date: '2026-12-27', title: 'Child before grant should fail', time: '10:00',
      },
      headers: { 'x-fc-home-actor-proof': verifiedChild.payload.proof },
    })).status, 403, 'Child PIN cannot inherit shared kiosk Owner grants')
    assert.equal((await request('/api/households/members/' + childHomeUserId + '/permission', {
      cookie: untrustedSession, body: {
        action: 'events.create', enabled: true, ownerPassword: password,
      },
    })).status, 200)
    const allowedChildEvent = await request('/api/events', {
      cookie: a.cookie, body: {
        date: '2026-12-27', title: 'PIN-verified child creator', time: '10:00',
        createdBy: ownerAId, selectedProfile: 'Home', role: 'owner',
      },
      headers: {
        'x-fc-home-actor-proof': verifiedChild.payload.proof,
        'x-household-id': b.id,
      },
    })
    assert.equal(allowedChildEvent.status, 201)
    const childAuthors = await request('/api/event-creators', { cookie: a.cookie })
    assert.equal(childAuthors.payload.creators.find(
      creator => creator.eventId === allowedChildEvent.payload.id,
    )?.displayName, 'Home verified child',
    'a spoofed role and Owner cookie never forge the event author')
    assert.equal((await request('/api/events/' + allowedChildEvent.payload.id, {
      cookie: a.cookie, method: 'DELETE',
      headers: { 'x-fc-home-actor-proof': verifiedChild.payload.proof },
    })).status, 403, 'Child may create but not delete family events')
    assert.equal((await request('/api/households/members/' + childHomeUserId + '/permission', {
      cookie: untrustedSession, body: {
        action: 'events.create', enabled: false, ownerPassword: password,
      },
    })).status, 200)
    assert.equal((await request('/api/events', {
      cookie: a.cookie, body: {
        date: '2026-12-27', title: 'Revoked Child grant', time: '11:00',
      },
      headers: { 'x-fc-home-actor-proof': verifiedChild.payload.proof },
    })).status, 403, 'a current proof cannot retain revoked Child permissions')
    assert.equal((await request('/api/events', { cookie: childHomeCookie })).status, 200)
    assert.deepEqual((await request('/api/events', { cookie: b.cookie })).payload
      .map(event => event.title), ['Only invited household B'],
    'PIN-selected actor cannot write into the other household')

    assert.equal((await request(homePinRoute, {
      cookie: a.cookie, body: { pinEnabled: false, ownerPassword: password },
    })).status, 403, 'shared kiosk cannot change protected Owner settings')
    assert.equal((await request(homePinRoute, {
      cookie: untrustedSession, body: { pinEnabled: false, ownerPassword: password },
    })).status, 200)
    assert.equal((await request(verifyPin, {
      cookie: a.cookie, body: { memberId: ownerAId, pin: '2468' },
    })).status, 409, 'PIN disabled stops PIN challenge')
    // PIN disabled: usable Home event/list writes, but no silent Owner role.
    const sharedHomeEvent = await request('/api/events', {
      cookie: a.cookie, body: {
        date: '2026-12-28', title: 'Created on Shared Home', time: '08:00',
        createdBy: ownerAId, actor: 'owner', selectedProfile: 'Home',
      },
      headers: { 'x-household-id': b.id },
    })
    assert.equal(sharedHomeEvent.status, 201)
    const sharedHomeList = await request('/api/lists', {
      cookie: a.cookie, body: { name: 'Shared Home shopping' },
      headers: { 'x-household-id': b.id },
    })
    assert.equal(sharedHomeList.status, 201)
    assert.equal((await request('/api/events/' + sharedHomeEvent.payload.id, {
      cookie: a.cookie, method: 'DELETE',
    })).status, 403, 'PIN-off Shared Home cannot delete events')
    assert.equal((await request('/api/households/member-access', {
      cookie: a.cookie,
    })).status, 403, 'PIN off does not expose Owner member management')
    assert.equal((await request('/api/households/member-invitations', {
      cookie: a.cookie, method: 'POST',
    })).status, 403, 'PIN off does not issue member invitations')
    const creatorsAfterHome = await request('/api/event-creators', { cookie: a.cookie })
    assert.equal(creatorsAfterHome.status, 200)
    const sharedAttribution = creatorsAfterHome.payload.creators.find(
      creator => creator.eventId === sharedHomeEvent.payload.id,
    )
    assert.equal(sharedAttribution?.displayName, 'Shared Home')
    assert.equal(sharedAttribution?.accountKind, 'home')
    assert.equal(sharedAttribution?.username, null)
    const homeWriteAudits = identityDatabase.prepare([
      'SELECT actor_kind AS kind, actor_user_id AS actorUserId,',
      'method,route FROM private_home_write_audit',
      'WHERE kiosk_session_id=? ORDER BY id',
    ].join(' ')).all(identityDatabase.prepare([
      'SELECT id FROM family_sessions WHERE user_id=?',
      'AND selected_profile_kind=? ORDER BY id LIMIT 1',
    ].join(' ')).get(ownerAId, 'home').id)
    assert.ok(homeWriteAudits.some(record =>
      record.kind === 'shared-home' && record.actorUserId === null &&
      record.method === 'POST' && record.route === '/api/lists'),
    'shared shopping actions must be audited without pretending Owner did them')
    assert.deepEqual((await request('/api/lists', { cookie: b.cookie })).payload
      .map(list => list.name), ['Invited B shopping'],
    'Shared Home write remains isolated to household A')

    assert.equal((await request(homePinRoute, {
      cookie: untrustedSession, body: { pinEnabled: true, ownerPassword: password },
    })).status, 200)
    assert.equal((await request('/api/events', {
      cookie: a.cookie, body: {
        date: '2026-12-29', title: 'Must require reverify', time: '08:00',
      }, headers: { 'x-fc-home-actor-proof': verifiedChild.payload.proof },
    })).status, 428, 'PIN toggle invalidates old proofs')
    assert.equal((await request(verifyPin, {
      cookie: a.cookie, body: { memberId: ownerAId, pin: '2468' },
    })).status, 200, 'PIN enabled can again verify the linked actor')
    assert.equal((await request('/api/auth/device-profile', {
      cookie: untrustedSession, body: { kind: 'person', personId },
    })).status, 200, 'separate Owner phone keeps its own People display')
    const kioskRetired = await request(homeDevice + '/revoke', {
      cookie: a.cookie, body: { ownerPassword: password },
    })
    assert.deepEqual(kioskRetired.payload, { trustedHome: false, changed: true })
    assert.match(kioskRetired.response.headers.get('set-cookie') ?? '',
      /__Host-fc_gateway_session=;/i, 'kiosk cookie is cleared')
    assert.equal((await request(verifyPin, {
      cookie: a.cookie, body: { memberId: ownerAId, pin: '2468' },
    })).status, 401, 'retired kiosk loses the Owner login, not just the PIN')
    assert.equal((await request('/api/events', { cookie: a.cookie })).status, 401,
      'retiring a kiosk must not restore unrestricted Owner event access')

    const peopleA = await request('/api/people', {
      cookie: untrustedSession, headers: { 'x-household-id': b.id },
    })
    const peopleB = await request('/api/people', {
      cookie: b.cookie, headers: { 'x-household-id': a.id },
    })
    assert.equal(peopleA.status, 200)
    assert.equal(peopleB.status, 200)
    assert.match(JSON.stringify(peopleA.payload), /Visible only to household one/)
    assert.doesNotMatch(JSON.stringify(peopleA.payload), /Visible only to household two/)
    assert.match(JSON.stringify(peopleB.payload), /Visible only to household two/)
    assert.doesNotMatch(JSON.stringify(peopleB.payload), /Visible only to household one/)
    assert.deepEqual((await request('/api/households', {
      cookie: untrustedSession,
    })).payload.households.map(h => h.householdId), [a.id])
    assert.deepEqual((await request('/api/households', {
      cookie: b.cookie,
    })).payload.households.map(h => h.householdId), [b.id])

    // PHASE 1 PILOT RESTART: same two real backends/SQLite tenants, but with
    // a fresh explicitly opted-in, Owner-only limited gateway route surface.
    // No third persistent calendar/site, deployed TEST, or LIVE host exists.
    await gateway.close()
    gateway = null
    gateway = await startPrivateHouseholdGateway({
      identityDatabase, serverDirectory: directory, storageRoot,
      backendPorts: { [a.id]: backendA.port, [b.id]: backendB.port },
      backendTokens: { [a.id]: backendA.upstreamToken, [b.id]: backendB.upstreamToken },
      independentHouseholdAdministratorUserIds: [operatorId],
      enforceFamilyMemberPermissions: true,
      phase1OwnerPilotOnly: true,
    })
    base = gateway.base
    const pilotStart = await request('/', { cookie: untrustedSession })
    assert.equal(pilotStart.status, 303)
    assert.equal(pilotStart.response.headers.get('location'), '/phase1',
      'activated household Owner enters the limited Phase 1 UI')
    for (const ownerCookie of [untrustedSession, b.cookie]) {
      const screen = await request('/phase1', { cookie: ownerCookie })
      assert.equal(screen.status, 200)
      assert.match(screen.payload, /Phase 1: household account isolation/)
      assert.match(screen.payload, /id="event-form"/)
      assert.match(screen.payload, /id="list-form"/)
      assert.match(screen.response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
      assert.equal(screen.response.headers.get('cache-control'), 'no-store')
      const script = await request('/auth/phase1-pilot.js', { cookie: ownerCookie })
      assert.equal(script.status, 200)
      assert.match(script.payload, /\/api\/events/)
      assert.match(script.payload, /\/api\/lists/)
      const stylesheet = await request('/auth/phase1-pilot.css', {
        cookie: ownerCookie,
      })
      assert.equal(stylesheet.status, 200)
    }
    assert.equal((await request('/phase1', { cookie: operator })).status, 403,
      'operator cannot enter household calendar screen')
    assert.equal((await request('/auth/phase1-pilot.js', {
      cookie: operator,
    })).status, 403, 'operator cannot load Owner-specific pilot assets')
    assert.equal((await request('/phase1', {
      cookie: childHomeCookie,
    })).status, 403, 'Child cannot enter Owner-only Phase 1')
    assert.equal((await request('/phase1')).status, 303,
      'anonymous browser must be sent through signed-in login')
    assert.equal((await request('/phase1?role=owner', {
      cookie: untrustedSession,
    })).status, 404, 'query alias cannot impersonate Owner landing')

    assert.equal((await request('/api/health')).status, 200,
      'private Phase 1 keeps generic no-session health status')
    assert.equal((await request('/api/events')).status, 401,
      'pilot still needs an authenticated central session')
    assert.equal((await request('/api/admin/household-overview', {
      cookie: operator,
    })).status, 200, 'operator sees metadata-only inventory')
    assert.equal((await request('/api/events', { cookie: operator })).status, 404,
      'operator never receives a household calendar route')
    assert.equal((await request('/api/admin/household-overview', {
      cookie: untrustedSession,
    })).status, 404, 'Owner cannot access system operator metadata')
    assert.equal((await request('/api/households/my-onboarding', {
      cookie: untrustedSession,
    })).status, 200, 'Owner can inspect their activation status')
    assert.equal((await request('/api/households/my-onboarding', {
      cookie: b.cookie,
    })).status, 200, 'second Owner can inspect own activation status')
    const pilotPeopleA = await request('/api/people', {
      cookie: untrustedSession, headers: { 'x-household-id': b.id },
    })
    const pilotPeopleB = await request('/api/people', {
      cookie: b.cookie, headers: { 'x-household-id': a.id },
    })
    assert.equal(pilotPeopleA.status, 200)
    assert.equal(pilotPeopleB.status, 200)
    assert.match(JSON.stringify(pilotPeopleA.payload), /Visible only to household one/)
    assert.doesNotMatch(JSON.stringify(pilotPeopleA.payload), /Visible only to household two/)
    assert.match(JSON.stringify(pilotPeopleB.payload), /Visible only to household two/)
    assert.equal((await request('/api/lists', {
      cookie: untrustedSession,
    })).status, 200, 'existing household lists remain readable')
    assert.equal((await request('/api/events', {
      cookie: b.cookie,
    })).status, 200, 'other Owner events remain readable')
    const pilotCreated = await request('/api/events', {
      cookie: untrustedSession, body: {
        date: '2027-01-03', title: 'Only private Phase 1 family A',
        time: '14:00', role: 'owner', householdId: b.id,
      }, headers: { 'x-household-id': b.id },
    })
    assert.equal(pilotCreated.status, 201)
    assert.deepEqual((await request('/api/events', { cookie: b.cookie })).payload
      .map(e => e.title), ['Only invited household B'],
    'the pilot never lets one Owner write another family calendar')
    const pilotList = await request('/api/lists', {
      cookie: b.cookie, body: { name: 'Only private Phase 1 family B' },
      headers: { 'x-household-id': a.id },
    })
    assert.equal(pilotList.status, 201)
    assert.equal((await request('/api/lists', { cookie: untrustedSession }))
      .payload.some(list => list.name === 'Only private Phase 1 family B'), false)
    for (const [method, route, body] of [
      ['GET', '/api/recipes'],
      ['GET', '/api/meal-plans'],
      ['GET', '/api/households/member-access'],
      ['GET', '/api/households/home-pin'],
      ['GET', '/uploads/any-private-photo.png'],
      ['GET', '/api/ai-budget'],
      ['POST', '/api/people', { name: 'Unreviewed People write' }],
      ['POST', '/api/households/member-invitations', {}],
      ['POST', '/api/households/home-pin',
        { pinEnabled: false, ownerPassword: password }],
      ['POST', '/api/ai/intent', { text: 'Change event' }],
      ['POST', '/api/capture/analyze-photo', { image: 'blocked' }],
      ['POST', '/api/arney/public-recipe-image', { imageUrl: 'https://example.org/' }],
      ['POST', '/API/events', { title: 'Bad route' }],
      ['POST', '/api/events/', { title: 'Bad route' }],
      ['POST', '/api/events?role=owner', { title: 'Bad route' }],
    ]) {
      const denied = await request(route, {
        cookie: untrustedSession, method, ...(body === undefined ? {} : { body }),
      })
      assert.equal(denied.status, 404, method + ' ' + route + ' is not Phase 1 approved')
    }
    assert.equal((await request('/api/events', {
      cookie: childHomeCookie, headers: { 'x-household-id': a.id },
    })).status, 404, 'registered Child must wait for Phase 2')
    assert.equal((await request('/api/lists', {
      cookie: childHomeCookie, body: { name: 'Child bypass' },
    })).status, 404, 'member UI is not enabled by known URL')
    assert.equal((await request('/api/households/independent-invitations', {
      cookie: untrustedSession, method: 'POST',
    })).status, 404, 'household Owner cannot become a system operator')

    // A revoked Owner's previously valid browser cookie may not continue to
    // reach their backend or disclose the saved Person name. B remains active.
    identityDatabase.prepare([
      'UPDATE household_memberships SET disabled=1',
      'WHERE household_id=(SELECT id FROM household_registry WHERE storage_id=?)',
    ].join(' ')).run(a.id)
    assert.equal((await request('/api/events', { cookie: untrustedSession })).status, 404,
      'revoked Owner fails closed before backend access in Phase 1')
    assert.equal((await request('/api/auth/devices', {
      cookie: untrustedSession,
    })).payload.devices.find(device => device.current)?.selectedProfile, null)
    assert.equal((await request('/api/events', { cookie: b.cookie })).status, 200)
    assert.equal(identityDatabase.prepare(
      'SELECT COUNT(*) AS n FROM private_activated_households'
    ).get().n, 2)
  } finally {
    if (gateway) await gateway.close()
    for (const backend of [...backends].reverse()) await stopBackend(backend)
    identityDatabase.close()
    fs.rmSync(work, { recursive: true, force: true })
  }
})
