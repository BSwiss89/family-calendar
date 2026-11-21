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
import {
  createFamilyMemberAccessTables, setFamilyMemberType,
  setFamilyMemberPersonLink, setFamilyMemberPermission,
} from '../Server/family-member-access.mjs'
import {
  registerHousehold, grantHouseholdMembership,
  listGrantedHouseholdsForSessionUser,
} from '../Server/household-memberships.mjs'
import { createFamilyAssignedTaskTables } from '../Server/private-family-assigned-tasks.mjs'
import { installPrivateFamilyTaskRoutes } from '../Server/private-family-task-routes.mjs'
import { startPrivateHouseholdGateway } from '../Server/private-household-gateway.mjs'

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Server')
const password = 'Disposable-Assigned-Tasks-Only-Passphrase-With-No-Real-Secrets'

function fixture(t, { provisionB = true } = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), 'private-assigned-tasks-'))
  const identity = new DatabaseSync(':memory:')
  const files = {
    'family-a': path.join(temp, 'a.sqlite'),
    'family-b': path.join(temp, 'b.sqlite'),
  }
  const dbs = Object.fromEntries(Object.entries(files).map(([id, filepath]) =>
    [id, new DatabaseSync(filepath)]))
  t.after(() => {
    identity.close()
    for (const db of Object.values(dbs)) db.close()
    rmSync(temp, { recursive: true, force: true })
  })
  const users = {}
  for (const name of ['task-owner-a', 'task-adult-a', 'task-child-a',
    'task-owner-b', 'task-child-b', 'task-outsider', 'task-hub']) {
    const accountKind = name === 'task-hub' ? 'hub' : 'person'
    setFamilyAccount(identity, name, name, password, { accountKind })
    users[name] = identity.prepare('SELECT id FROM family_users WHERE username=?').get(name).id
  }
  createFamilyMemberAccessTables(identity)
  for (const home of ['family-a', 'family-b']) {
    registerHousehold(identity, { householdId: home, displayName: home })
  }
  for (const [name, home, role] of [
    ['task-owner-a', 'family-a', 'owner'], ['task-adult-a', 'family-a', 'member'],
    ['task-child-a', 'family-a', 'member'], ['task-owner-b', 'family-b', 'owner'],
    ['task-child-b', 'family-b', 'member'],
  ]) grantHouseholdMembership(identity, {
    householdId: home, serverVerifiedUserId: users[name], role,
  })
  for (const [name, home, owner, type] of [
    ['task-adult-a', 'family-a', 'task-owner-a', 'adult'],
    ['task-child-a', 'family-a', 'task-owner-a', 'child'],
    ['task-child-b', 'family-b', 'task-owner-b', 'child'],
  ]) setFamilyMemberType(identity, {
    householdId: home, serverVerifiedOwnerUserId: users[owner],
    targetUserId: users[name], memberType: type,
  })
  dbs['family-a'].exec(
    "CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT NOT NULL);" +
    "INSERT INTO people VALUES(11,'Owner A'),(12,'Child A'),(13,'Adult A');"
  )
  dbs['family-b'].exec(
    "CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT NOT NULL);" +
    "INSERT INTO people VALUES(21,'Owner B'),(22,'Child B');"
  )
  for (const [home, name, owner, personId] of [
    ['family-a', 'task-owner-a', 'task-owner-a', 11],
    ['family-a', 'task-adult-a', 'task-owner-a', 13],
    ['family-a', 'task-child-a', 'task-owner-a', 12],
    ['family-b', 'task-owner-b', 'task-owner-b', 21],
    ['family-b', 'task-child-b', 'task-owner-b', 22],
  ]) setFamilyMemberPersonLink(identity, {
    householdId: home, serverVerifiedOwnerUserId: users[owner],
    targetUserId: users[name], personId, householdDatabase: dbs[home],
  })
  createFamilyAssignedTaskTables(dbs['family-a'])
  if (provisionB) createFamilyAssignedTaskTables(dbs['family-b'])
  return { identity, files, dbs, users }
}

async function makeSite(t, f, { enabled = true } = {}) {
  const app = express()
  app.use('/api/auth/login', express.json({ limit: '32kb' }))
  installFamilyAuth(app, f.identity, directory, 'required', {
    cookieName: '__Host-fc_gateway_session',
  })
  const installed = installPrivateFamilyTaskRoutes(app, {
    enabled, identityDatabase: f.identity,
    resolveTrustedHousehold: (request, response) => {
      const homes = listGrantedHouseholdsForSessionUser(f.identity, {
        serverVerifiedUserId: request.familyAccount.user_id,
      })
      if (homes.length !== 1) {
        response.status(403).json({ error: 'Only one verified household accepted in this fixture.' })
        return null
      }
      return homes[0]
    },
    openHouseholdDatabase: householdId => {
      if (!Object.prototype.hasOwnProperty.call(f.files, householdId)) {
        throw new Error('Unapproved household DB')
      }
      return new DatabaseSync(f.files[householdId])
    },
  })
  // A missing task route never proxies into a backend that could interpret
  // a different actor or selected People avatar.
  app.use('/api', (_req, response) =>
    response.status(404).json({ error: 'Unreviewed API.' }))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const host = '127.0.0.1:' + server.address().port
  return { base: 'http://' + host, origin: 'https://' + host, installed }
}

async function signIn(site, username) {
  const response = await fetch(site.base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: site.origin },
    body: JSON.stringify({ username, password, deviceLabel: 'Private disposable fixture' }),
  })
  assert.equal(response.status, 200, username + ' must have a real central session')
  const cookie = response.headers.get('set-cookie')
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  return cookie.split(';')[0]
}

async function call(site, cookie, path, method = 'GET', body, {
  omitOrigin = false, contentType = 'application/json',
} = {}) {
  const headers = {}
  if (cookie) headers.Cookie = cookie
  if (method !== 'GET' && method !== 'HEAD') {
    if (!omitOrigin) headers.Origin = site.origin
    if (contentType) headers['Content-Type'] = contentType
  }
  const response = await fetch(site.base + path, {
    method, headers, redirect: 'manual',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await response.text()
  let json = null
  try { json = raw ? JSON.parse(raw) : null } catch {}
  return { status: response.status, body: json, headers: response.headers, raw }
}

test('disabled pilot mounts nothing and performs no DB writes', async t => {
  const f = fixture(t)
  const a = await makeSite(t, f, { enabled: false })
  assert.equal(a.installed.enabled, false)
  const cookie = await signIn(a, 'task-owner-a')
  assert.equal((await call(a, cookie, '/api/family-assigned-tasks')).status, 404)
  assert.equal(f.dbs['family-a'].prepare(
    'SELECT COUNT(*) AS n FROM family_assigned_tasks'
  ).get().n, 0)
  assert.throws(() => installPrivateFamilyTaskRoutes(express(), {
    enabled: true, identityDatabase: f.identity,
  }), /Trusted central identity/)
})

test('authenticated route assigns to real Person and only matching Child can complete', async t => {
  const f = fixture(t)
  const site = await makeSite(t, f)
  const adult = await signIn(site, 'task-adult-a')
  const child = await signIn(site, 'task-child-a')
  const owner = await signIn(site, 'task-owner-a')
  const outsider = await signIn(site, 'task-outsider')
  const unauth = await call(site, null, '/api/family-assigned-tasks')
  assert.equal(unauth.status, 401)
  assert.equal((await call(site, outsider, '/api/family-assigned-tasks')).status, 403)
  assert.equal((await call(site, child, '/api/family-assigned-tasks',
    'POST', { title: 'Self assigned', assignedPersonId: 12 })).status, 403)
  const created = await call(site, adult, '/api/family-assigned-tasks',
    'POST', { title: '  Feed the pets  ', assignedPersonId: 12 })
  assert.equal(created.status, 201)
  assert.equal(created.body.taskId, 1)
  assert.equal(created.body.assignedPersonId, 12)
  const own = await call(site, child, '/api/family-assigned-tasks')
  assert.equal(own.status, 200)
  assert.equal(own.body.tasks.length, 1)
  assert.equal(own.body.tasks[0].title, 'Feed the pets')
  assert.equal(own.headers.get('cache-control'), 'no-store')
  const route = '/api/family-assigned-tasks/1/complete'
  assert.equal((await call(site, owner, route, 'POST', {})).status, 403)
  assert.equal((await call(site, adult, route, 'POST', {})).status, 403)
  assert.equal((await call(site, child, route, 'POST', {
    actor: 'owner', personId: 11, selectedProfile: 'Home',
  })).status, 400)
  const done = await call(site, child, route, 'POST', {})
  assert.equal(done.status, 200)
  assert.deepEqual(done.body, { taskId: 1, completed: true, alreadyCompleted: false })
  const repeat = await call(site, child, route, 'POST', {})
  assert.equal(repeat.status, 200)
  assert.equal(repeat.body.alreadyCompleted, true)
  const completed = f.dbs['family-a'].prepare([
    'SELECT completed_at AS at, completed_by_user_id AS byUser,',
    'completed_by_person_id AS byPerson FROM family_assigned_tasks WHERE id=1',
  ].join(' ')).get()
  assert.ok(completed.at > 0)
  assert.equal(completed.byUser, f.users['task-child-a'])
  assert.equal(completed.byPerson, 12)
  assert.equal((await call(site, child, '/api/family-assigned-tasks/1/reopen', 'POST', {})).status, 403)
  assert.equal((await call(site, owner, '/api/family-assigned-tasks/1/reopen', 'POST', {})).status, 200)
  assert.equal(f.dbs['family-a'].prepare(
    'SELECT completed_at FROM family_assigned_tasks WHERE id=1'
  ).get().completed_at, null)
})

test('two independently provisioned household APIs do not mix identical task IDs', async t => {
  const f = fixture(t)
  const site = await makeSite(t, f)
  const ownerA = await signIn(site, 'task-owner-a')
  const childA = await signIn(site, 'task-child-a')
  const ownerB = await signIn(site, 'task-owner-b')
  const childB = await signIn(site, 'task-child-b')
  assert.equal((await call(site, ownerA, '/api/family-assigned-tasks',
    'POST', { title: 'A only', assignedPersonId: 12 })).body.taskId, 1)
  assert.equal((await call(site, ownerB, '/api/family-assigned-tasks',
    'POST', { title: 'B only', assignedPersonId: 22 })).body.taskId, 1)
  assert.deepEqual((await call(site, childA, '/api/family-assigned-tasks')).body.tasks.map(t => t.title), ['A only'])
  assert.deepEqual((await call(site, childB, '/api/family-assigned-tasks')).body.tasks.map(t => t.title), ['B only'])
  assert.equal((await call(site, ownerB, '/api/family-assigned-tasks',
    'POST', { title: 'Illegal', assignedPersonId: 12 })).status, 404)
  assert.equal((await call(site, childA, '/api/family-assigned-tasks/1/complete',
    'POST', { householdId: 'family-b' })).status, 400)
  assert.equal((await call(site, childA, '/api/family-assigned-tasks/1/complete',
    'POST', {})).status, 200)
  assert.equal(f.dbs['family-b'].prepare(
    'SELECT completed_at FROM family_assigned_tasks WHERE id=1'
  ).get().completed_at, null)
  assert.equal((await call(site, childB, '/api/family-assigned-tasks/1/complete',
    'POST', {})).status, 200)
  assert.equal(f.dbs['family-a'].prepare(
    'SELECT completed_by_user_id AS userId FROM family_assigned_tasks WHERE id=1'
  ).get().userId, f.users['task-child-a'])
  assert.equal(f.dbs['family-b'].prepare(
    'SELECT completed_by_user_id AS userId FROM family_assigned_tasks WHERE id=1'
  ).get().userId, f.users['task-child-b'])
})

test('revocation, expired session, hub account and alias paths fail closed', async t => {
  const f = fixture(t)
  const site = await makeSite(t, f)
  const owner = await signIn(site, 'task-owner-a')
  const child = await signIn(site, 'task-child-a')
  const hub = await signIn(site, 'task-hub')
  assert.equal((await call(site, hub, '/api/family-assigned-tasks')).status, 403)
  assert.equal((await call(site, owner, '/api/family-assigned-tasks', 'POST', {
    title: 'Help clean up', assignedPersonId: 12,
  })).status, 201)
  for (const path of [
    '/API/family-assigned-tasks', '/api/family-assigned-tasks/',
    '/api/family-assigned-tasks?owner=1', '/api/family-assigned-tasks/%31/complete',
    '/api/family-assigned-tasks/01/complete', '/api/family-assigned-tasks/1/complete?actor=owner',
    '/api/family-assigned-tasks/1/complete/', '/api/family-assigned-tasks/1/delete',
  ]) assert.equal((await call(site, child, path, path.includes('complete') ? 'POST' : 'GET',
    path.includes('complete') ? {} : undefined)).status, 404, path)
  assert.equal((await call(site, child, '/api/family-assigned-tasks',
    'POST', { title: 'Elevated', assignedPersonId: 12, userId: f.users['task-owner-a'] })).status, 400)
  assert.equal((await call(site, owner, '/api/family-assigned-tasks',
    'POST', { title: 'Not real', assignedPersonId: 999 })).status, 404)
  assert.equal((await call(site, child, '/api/family-assigned-tasks/1/complete',
    'POST', {}, { omitOrigin: true })).status, 403)
  setFamilyMemberPermission(f.identity, {
    householdId: 'family-a', serverVerifiedOwnerUserId: f.users['task-owner-a'],
    targetUserId: f.users['task-child-a'], action: 'tasks.completeAssigned',
    enabled: false,
  })
  assert.equal((await call(site, child, '/api/family-assigned-tasks/1/complete',
    'POST', {})).status, 403)
  setFamilyMemberPermission(f.identity, {
    householdId: 'family-a', serverVerifiedOwnerUserId: f.users['task-owner-a'],
    targetUserId: f.users['task-child-a'], action: 'tasks.completeAssigned',
    enabled: true,
  })
  f.identity.prepare('UPDATE household_memberships SET disabled=1 WHERE user_id=?')
    .run(f.users['task-child-a'])
  assert.equal((await call(site, child, '/api/family-assigned-tasks')).status, 403)
  f.identity.prepare('UPDATE household_memberships SET disabled=0 WHERE user_id=?')
    .run(f.users['task-child-a'])
  assert.equal((await call(site, child, '/api/family-assigned-tasks')).status, 200)
  f.identity.prepare('UPDATE family_sessions SET revoked_at=? WHERE user_id=?')
    .run(Date.now(), f.users['task-child-a'])
  assert.equal((await call(site, child, '/api/family-assigned-tasks')).status, 401)
})

test('unprovisioned household task table is refused, never auto-created by HTTP', async t => {
  const f = fixture(t, { provisionB: false })
  const site = await makeSite(t, f)
  const ownerB = await signIn(site, 'task-owner-b')
  assert.equal((await call(site, ownerB, '/api/family-assigned-tasks')).status, 503)
  assert.equal((await call(site, ownerB, '/api/family-assigned-tasks',
    'POST', { title: 'Not auto migrated', assignedPersonId: 22 })).status, 503)
  assert.equal(f.dbs['family-b'].prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='family_assigned_tasks'"
  ).get().n, 0)
})

test('gateway refuses task API without family permission enforcement before startup', async t => {
  const f = fixture(t)
  await assert.rejects(() => startPrivateHouseholdGateway({
    identityDatabase: f.identity, serverDirectory: directory,
    storageRoot: '/not/real', backendPorts: {}, backendTokens: {},
    enableVerifiedTaskApi: true, enforceFamilyMemberPermissions: false,
  }), /Assigned task API requires explicit private family enforcement/)
})
