// Disposable two-household signup tests: no real identities, calendar or public listener.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { installPrivateHouseholdSignup } from '../Server/private-household-signup.mjs'
import { installFamilyAuth, setFamilyAccount, verifyFamilyPassword } from '../Server/family-auth.mjs'
import { registerHousehold, grantHouseholdMembership,
  listGrantedHouseholdsForSessionUser } from '../Server/household-memberships.mjs'
import { createHouseholdInvitationTables,
  issueHouseholdMemberInvitation } from '../Server/household-member-invitations.mjs'

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Server')
const password = 'Disposable-Unique-2026-Secure-Password'

async function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  createHouseholdInvitationTables(db)
  setFamilyAccount(db, 'familyownera', 'A owner', password)
  setFamilyAccount(db, 'familyownerb', 'B owner', password)
  registerHousehold(db, { householdId: 'family-a', displayName: 'A Family' })
  registerHousehold(db, { householdId: 'family-b', displayName: 'B Family' })
  const a = db.prepare("SELECT id FROM family_users WHERE username = 'familyownera'").get().id
  const b = db.prepare("SELECT id FROM family_users WHERE username = 'familyownerb'").get().id
  grantHouseholdMembership(db, { serverVerifiedUserId: a, householdId: 'family-a', role: 'owner' })
  grantHouseholdMembership(db, { serverVerifiedUserId: b, householdId: 'family-b', role: 'owner' })
  const app = express()
  // Match the real gateway's login JSON parser before the auth middleware.
  app.use('/api/auth/login', express.json({ limit: '32kb' }))
  installPrivateHouseholdSignup(app, db, directory)
  installFamilyAuth(app, db, directory, 'required', {
    cookieName: '__Host-fc_gateway_session',
  })
  app.get('/api/events', (_req, res) => res.json({ private: true }))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = 'http://127.0.0.1:' + server.address().port
  const origin = 'https://127.0.0.1:' + server.address().port
  const invite = (owner, householdId) =>
    issueHouseholdMemberInvitation(db, {
      householdId, serverVerifiedIssuerUserId: owner,
    })
  const request = (url, body, { originHeader = origin, method = 'POST',
    contentType = 'application/json' } = {}) => fetch(base + url, {
    method,
    headers: { Origin: originHeader, 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
  })
  const signup = (token, username = 'newmember') => ({
    token, username, displayName: 'Invited Person', password,
  })
  return { db, base, origin, a, b, invite, request, signup }
}

test('public join form uses fragment token, no query or stored secret; all calendar API remains protected', async t => {
  const f = await fixture(t)
  const page = await fetch(f.base + '/join')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /id="join-form"/)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
  const script = await fetch(f.base + '/auth/join.js')
  assert.equal(script.status, 200)
  const js = await script.text()
  assert.match(js, /location\.hash/)
  assert.match(js, /history\.replaceState/)
  assert.doesNotMatch(js, /localStorage|sessionStorage/)
  assert.equal((await fetch(f.base + '/api/events')).status, 401)
  assert.equal((await fetch(f.base + '/api/households/members')).status, 401)
})

test('single-use invitation registers new person in A, keeps B private and requires regular sign-in', async t => {
  const f = await fixture(t)
  const token = f.invite(f.a, 'family-a').token
  const registered = await f.request('/api/households/join', f.signup(token))
  assert.equal(registered.status, 201)
  assert.deepEqual(await registered.json(), { ok: true, next: '/login' })
  assert.equal(registered.headers.get('set-cookie'), null)
  assert.equal(registered.headers.get('cache-control'), 'no-store')
  const user = f.db.prepare("SELECT * FROM family_users WHERE username = 'newmember'").get()
  assert.equal(user.account_kind, 'person')
  assert.equal(user.disabled, 0)
  assert.equal(await verifyFamilyPassword(password, user.password_hash), true)
  assert.deepEqual(listGrantedHouseholdsForSessionUser(f.db, {
    serverVerifiedUserId: user.id,
  }), [{ householdId: 'family-a', displayName: 'A Family', role: 'member' }])
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM family_sessions WHERE user_id = ?')
    .get(user.id).n, 0)
  assert.equal((await f.request('/api/households/join',
    f.signup(token, 'anothermember'))).status, 400)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM family_users').get().n, 3)
  const login = await f.request('/api/auth/login', {
    username: 'newmember', password,
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const result = await fetch(f.base + '/api/events', { headers: { Cookie: cookie } })
  assert.equal(result.status, 200)
  const households = await fetch(f.base + '/api/events?household=family-b',
    { headers: { Cookie: cookie } })
  // This fixture has no tenant routing: authorization against household B is
  // specifically asserted through verified central membership, not this stub.
  assert.equal(households.status, 200)
  assert.deepEqual(listGrantedHouseholdsForSessionUser(f.db, {
    serverVerifiedUserId: user.id,
  }).map(h => h.householdId), ['family-a'])
})

test('rejects forged origin, invalid JSON shape and extra role or tenant fields without consuming token', async t => {
  const f = await fixture(t)
  const token = f.invite(f.b, 'family-b').token
  const payload = f.signup(token, 'guestb')
  assert.equal((await f.request('/api/households/join', payload, {
    originHeader: 'https://evil.example',
  })).status, 403)
  assert.equal((await f.request('/api/households/join', payload, {
    originHeader: '',
  })).status, 403)
  assert.equal((await f.request('/api/households/join', {
    ...payload, householdId: 'family-a',
  })).status, 400)
  assert.equal((await f.request('/api/households/join', {
    ...payload, role: 'owner',
  })).status, 400)
  assert.equal((await f.request('/api/households/join', {
    ...payload, accountKind: 'hub',
  })).status, 400)
  assert.equal((await f.request('/api/households/join', payload, {
    contentType: 'text/plain',
  })).status, 400)
  assert.equal((await f.request('/api/households/join', payload)).status, 201)
  const created = f.db.prepare("SELECT id FROM family_users WHERE username = 'guestb'").get()
  assert.deepEqual(listGrantedHouseholdsForSessionUser(f.db, {
    serverVerifiedUserId: created.id,
  }).map(x => x.householdId), ['family-b'])
})

test('expired or revoked invitation, duplicate username, weak password and replay cannot create accounts', async t => {
  const f = await fixture(t)
  const invite = f.invite(f.a, 'family-a')
  assert.equal((await f.request('/api/households/join', {
    ...f.signup(invite.token, 'familyownera'),
  })).status, 400)
  assert.equal((await f.request('/api/households/join', {
    ...f.signup(invite.token, 'weakuser'), password: 'short',
  })).status, 400)
  assert.equal(f.db.prepare('SELECT redeemed_at FROM household_member_invitations WHERE id = ?')
    .get(invite.invitationId).redeemed_at, null)
  f.db.prepare('UPDATE household_member_invitations SET created_at = created_at - ?, expires_at = ? WHERE id = ?')
    .run(5 * 24 * 60 * 60 * 1000, Date.now() - 1, invite.invitationId)
  assert.equal((await f.request('/api/households/join',
    f.signup(invite.token, 'lateuser'))).status, 400)
  const revoked = f.invite(f.b, 'family-b')
  f.db.prepare('UPDATE household_member_invitations SET revoked_at = ? WHERE id = ?')
    .run(Date.now(), revoked.invitationId)
  assert.equal((await f.request('/api/households/join',
    f.signup(revoked.token, 'revokeduser'))).status, 400)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM family_users').get().n, 2)
})

test('bound repeated token failures and never leak household existence or raw token in HTTP errors', async t => {
  const f = await fixture(t)
  const token = f.invite(f.a, 'family-a').token
  let last
  for (let i = 0; i < 5; i++) {
    last = await f.request('/api/households/join',
      f.signup(token, 'familyownera'))
    assert.equal(last.status, 400)
    const result = JSON.stringify(await last.json())
    assert.equal(result.includes(token), false)
    assert.equal(/family-a|family-b|familyownera/i.test(result), false)
  }
  const blocked = await f.request('/api/households/join',
    f.signup(token, 'validguest'))
  assert.equal(blocked.status, 429)
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM family_users').get().n, 2)
})
