import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installFamilyAuth, setFamilyAccount } from '../Server/family-auth.mjs'
import {
  createFamilyMemberAccessTables, setFamilyMemberType,
  setFamilyMemberPersonLink, setFamilyMemberPermission,
} from '../Server/family-member-access.mjs'
import { registerHousehold, grantHouseholdMembership } from '../Server/household-memberships.mjs'
import {
  installExistingTestLoginFamilyPermissions,
  verifyExistingTestLoginFamilyActor,
} from '../Server/test-existing-login-family-bridge.mjs'

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Server')
const password = 'Test-Only-Long-Passphrase-Without-Any-Production-Secret'
const home = 'family-a'

function seededDatabases(t) {
  const loginDatabase = new DatabaseSync(':memory:')
  const identityDatabase = new DatabaseSync(':memory:')
  t.after(() => { identityDatabase.close(); loginDatabase.close() })
  loginDatabase.exec('CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  loginDatabase.prepare('INSERT INTO people(id, name) VALUES (1, ?)').run('Existing Adult')
  loginDatabase.prepare('INSERT INTO people(id, name) VALUES (2, ?)').run('Existing Child')
  for (const [username, displayName] of [
    ['real-owner', 'Owner'], ['real-adult', 'Adult'], ['real-child', 'Child'],
    ['real-outsider', 'Unenrolled account'],
  ]) setFamilyAccount(loginDatabase, username, displayName, password)
  createFamilyMemberAccessTables(identityDatabase)
  const source = loginDatabase.prepare('SELECT id, username, display_name FROM family_users').all()
  // Explicit offline map: no passwords, cookies, session tokens, photos or
  // events are duplicated. A deliberately invalid hash is NOT a login.
  const seed = identityDatabase.prepare(
    'INSERT INTO family_users(id, username, display_name, password_hash) VALUES (?, ?, ?, ?)'
  )
  for (const account of source) {
    seed.run(account.id, account.username, account.display_name, 'unusable-password-shadow')
  }
  registerHousehold(identityDatabase, { householdId: home, displayName: 'My Family' })
  const users = Object.fromEntries(source.map(user => [user.username, user.id]))
  for (const [username, role] of [
    ['real-owner', 'owner'], ['real-adult', 'member'], ['real-child', 'member'],
  ]) grantHouseholdMembership(identityDatabase, {
    serverVerifiedUserId: users[username], householdId: home, role,
  })
  setFamilyMemberType(identityDatabase, {
    householdId: home, serverVerifiedOwnerUserId: users['real-owner'],
    targetUserId: users['real-adult'], memberType: 'adult',
  })
  setFamilyMemberType(identityDatabase, {
    householdId: home, serverVerifiedOwnerUserId: users['real-owner'],
    targetUserId: users['real-child'], memberType: 'child',
  })
  setFamilyMemberPersonLink(identityDatabase, {
    householdId: home, serverVerifiedOwnerUserId: users['real-owner'],
    targetUserId: users['real-child'], personId: 2, householdDatabase: loginDatabase,
  })
  assert.equal(identityDatabase.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n, 0)
  assert.equal(identityDatabase.prepare(
    "SELECT COUNT(*) AS n FROM family_users WHERE password_hash LIKE 'scrypt-v1:%'"
  ).get().n, 0)
  return { loginDatabase, identityDatabase, users }
}

async function makeSite(loginDatabase, identityDatabase) {
  const app = express()
  app.use(express.json())
  installFamilyAuth(app, loginDatabase, directory, 'required')
  installExistingTestLoginFamilyPermissions(app, {
    loginDatabase, identityDatabase, householdId: home,
  })
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
  app.get('/api/events', (_req, res) => res.json({ eventTitles: ['Private household'] }))
  app.post('/api/events', (_req, res) => res.status(201).json({ wrote: true }))
  app.post('/api/ai/event-action-confirm', (_req, res) => res.json({ wrote: true }))
  app.get('/api/lists', (_req, res) => res.json({ lists: ['Store'] }))
  app.post('/api/lists/1/items', (_req, res) => res.status(201).json({ wrote: true }))
  app.get('/api/recipes', (_req, res) => res.json({ recipes: [] }))
  app.get('/api/emoji-markers', (_req, res) => res.json({ markers: [] }))
  app.post('/api/emoji-markers', (_req, res) => res.status(201).json({ wrote: true }))
  app.get('/api/family-daily-note', (_req, res) => res.json({ note: '' }))
  app.put('/api/family-daily-note', (_req, res) => res.json({ wrote: true }))
  app.get('/api/arney/local-transcription/status', (_req, res) => res.json({ ready: true }))
  app.post('/api/arney/local-transcription', (_req, res) => res.json({ text: 'test' }))
  app.get('/api/test-event-invitations', (_req, res) => res.json({ privateData: 'not reviewed' }))
  app.post('/api/auth/unreviewed-owner-change', (_req, res) => res.json({ unsafe: true }))
  app.get('/uploads/person-photo', (_req, res) => res.send('private photo'))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  return {
    base, origin: 'https://127.0.0.1:' + server.address().port,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}
async function signIn(site, username) {
  const res = await fetch(site.base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: site.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, deviceLabel: 'Personal phone' }),
  })
  assert.equal(res.status, 200, username + ' can keep normal password login')
  const cookie = res.headers.get('set-cookie')
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  return cookie.split(';')[0]
}
async function call(site, cookie, route, method = 'GET', body) {
  const result = await fetch(site.base + route, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { Origin: site.origin, 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  return result
}

test('existing username/password and remembered cookie establish family actor without any additional PIN', async t => {
  const { loginDatabase, identityDatabase, users } = seededDatabases(t)
  const site = await makeSite(loginDatabase, identityDatabase)
  t.after(() => site.close())
  const child = await signIn(site, 'real-child')
  const adult = await signIn(site, 'real-adult')
  const owner = await signIn(site, 'real-owner')
  const outsider = await signIn(site, 'real-outsider')
  assert.equal((await call(site, child, '/api/auth/status')).status, 200)
  const identity = await call(site, child, '/api/auth/my-family-access')
  assert.equal(identity.status, 200)
  const childAccess = await identity.json()
  assert.equal(childAccess.memberType, 'child')
  assert.equal(childAccess.linkedPersonId, 2)
  assert.equal(childAccess.allowedActions.includes('events.create'), false)
  assert.equal((await call(site, child, '/api/events')).status, 200)
  assert.equal((await call(site, child, '/api/events', 'POST', {
    actor: 'owner', selectedProfile: 'Home',
  })).status, 403)
  assert.equal((await call(site, child, '/api/lists/1/items', 'POST', {})).status, 403)
  assert.equal((await call(site, child, '/api/ai/event-action-confirm', 'POST', {})).status, 403)
  assert.equal((await call(site, child, '/api/lists')).status, 403)
  assert.equal((await call(site, adult, '/api/lists')).status, 200)
  assert.equal((await call(site, adult, '/api/events', 'POST', {})).status, 201)
  assert.equal((await call(site, owner, '/api/events', 'POST', {})).status, 201)
  assert.equal((await call(site, outsider, '/api/events')).status, 403)
  assert.equal((await call(site, null, '/api/events')).status, 401)
  assert.equal((await call(site, child, '/uploads/person-photo')).status, 200)
  assert.equal((await call(site, child, '/api/emoji-markers')).status, 200)
  assert.equal((await call(site, child, '/api/family-daily-note')).status, 200)
  assert.equal((await call(site, child, '/api/arney/local-transcription/status')).status, 200)
  assert.equal((await call(site, child, '/api/arney/local-transcription', 'POST', {})).status, 200)
  assert.equal((await call(site, child, '/api/emoji-markers', 'POST', {})).status, 403)
  assert.equal((await call(site, child, '/api/family-daily-note', 'PUT', {})).status, 403)
  assert.equal((await call(site, adult, '/api/emoji-markers', 'POST', {})).status, 201)
  assert.equal((await call(site, adult, '/api/family-daily-note', 'PUT', {})).status, 200)
  assert.equal((await call(site, owner, '/api/test-event-invitations')).status, 403,
    'unreviewed selected-avatar invitation routes remain denied even to Owner')
  assert.equal((await call(site, owner, '/api/auth/unreviewed-owner-change', 'POST', {})).status, 403)
  assert.equal((await call(site, child, '/API/events')).status, 403)
  const chosenHome = await call(site, child, '/api/auth/device-profile', 'POST', { kind: 'home' })
  assert.equal(chosenHome.status, 200)
  assert.equal((await call(site, child, '/api/events', 'POST', {
    selectedProfile: 'Home', userId: users['real-owner'],
  })).status, 403)
  assert.equal((await call(site, child, '/api/auth/my-family-access')).status, 200)

  setFamilyMemberPermission(identityDatabase, {
    householdId: home, serverVerifiedOwnerUserId: users['real-owner'],
    targetUserId: users['real-child'], action: 'events.create', enabled: true,
  })
  assert.equal((await call(site, child, '/api/events', 'POST', {})).status, 201)
  setFamilyMemberPermission(identityDatabase, {
    householdId: home, serverVerifiedOwnerUserId: users['real-owner'],
    targetUserId: users['real-child'], action: 'events.create', enabled: false,
  })
  assert.equal((await call(site, child, '/api/events', 'POST', {})).status, 403)
  assert.equal((await call(site, child, '/api/events')).status, 200)
  assert.equal(loginDatabase.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n, 4)
})

test('stale session, missing shadow, disabled account and changed identity mappings deny access', async t => {
  const { loginDatabase, identityDatabase, users } = seededDatabases(t)
  const site = await makeSite(loginDatabase, identityDatabase)
  t.after(() => site.close())
  const child = await signIn(site, 'real-child')
  const owner = await signIn(site, 'real-owner')
  const savedSession = loginDatabase.prepare(
    "SELECT s.id, s.user_id, u.username FROM family_sessions s JOIN family_users u ON u.id = s.user_id WHERE u.username = 'real-child'"
  ).get()
  assert.equal(verifyExistingTestLoginFamilyActor({
    loginDatabase, identityDatabase, householdId: home, authenticatedSession: {
      ...savedSession, id: savedSession.id, user_id: savedSession.user_id,
    },
  }).role, 'child')
  assert.equal(verifyExistingTestLoginFamilyActor({
    loginDatabase, identityDatabase, householdId: home, authenticatedSession: {
      ...savedSession, id: savedSession.id, user_id: users['real-owner'],
    },
  }), null, 'cannot relabel a Child session as Owner')
  identityDatabase.prepare('UPDATE family_users SET username = ? WHERE id = ?')
    .run('not-the-existing-login', users['real-child'])
  assert.equal((await call(site, child, '/api/events')).status, 403)
  identityDatabase.prepare('UPDATE family_users SET username = ? WHERE id = ?')
    .run('real-child', users['real-child'])
  assert.equal((await call(site, child, '/api/events')).status, 200)
  identityDatabase.prepare('UPDATE household_memberships SET disabled=1 WHERE user_id=?')
    .run(users['real-child'])
  assert.equal((await call(site, child, '/api/events')).status, 403)
  identityDatabase.prepare('UPDATE household_memberships SET disabled=0 WHERE user_id=?')
    .run(users['real-child'])
  assert.equal((await call(site, child, '/api/events')).status, 200)
  // Existing logout still revokes the remembered cookie, not just the role.
  assert.equal((await call(site, owner, '/api/auth/logout', 'POST')).status, 200)
  assert.equal((await call(site, owner, '/api/events')).status, 401)
  assert.equal((await call(site, child, '/api/events')).status, 200)
  // A local password reset leaves the central membership untouched but
  // invalidates the old trusted session, so no write survives the reset.
  setFamilyAccount(loginDatabase, 'real-child', 'Child', 'Brand-New-Strong-Secure-Passphrase')
  assert.equal((await call(site, child, '/api/events')).status, 401)
})

test('missing separate identity backend is never interpreted as an Owner login', t => {
  const { loginDatabase, identityDatabase, users } = seededDatabases(t)
  assert.throws(() => installExistingTestLoginFamilyPermissions(express(), {
    loginDatabase, identityDatabase: loginDatabase, householdId: home,
  }), /separate trusted databases/)
  assert.equal(verifyExistingTestLoginFamilyActor({
    loginDatabase, identityDatabase, householdId: home,
    authenticatedSession: { id: 0, user_id: users['real-owner'], username: 'real-owner' },
  }), null)
})
