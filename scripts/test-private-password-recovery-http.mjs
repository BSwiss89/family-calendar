import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setFamilyAccount, verifyFamilyPassword, installFamilyAuth } from '../Server/family-auth.mjs'
import { createFamilyPasswordRecoveryTables } from '../Server/family-password-recovery.mjs'
import {
  installPrivateRecoveryPublic, installPrivateRecoveryOperator,
} from '../Server/private-family-password-recovery.mjs'

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Server')
const oldPassword = 'Example-Operator-And-Family-Account-Password-2026!'
const newPassword = 'New-Strong-Private-Recovery-Password-2026!'
async function site(t) {
  const db = new DatabaseSync(':memory:')
  setFamilyAccount(db, 'recoveryoperator', 'System Operator', oldPassword)
  setFamilyAccount(db, 'recoverymember', 'Family Account', oldPassword)
  setFamilyAccount(db, 'recoveryoutsider', 'Unauthorized household user', oldPassword)
  createFamilyPasswordRecoveryTables(db)
  const getId = username => db.prepare('SELECT id FROM family_users WHERE username = ?').get(username).id
  const adminId = getId('recoveryoperator')
  const memberId = getId('recoverymember')
  const app = express()
  app.use('/api/auth/login', express.json({ limit: '32kb' }))
  installPrivateRecoveryPublic(app, { identityDatabase: db, serverDirectory: directory })
  installFamilyAuth(app, db, directory, 'required', {
    cookieName: '__Host-fc_gateway_session',
  })
  installPrivateRecoveryOperator(app, {
    identityDatabase: db, trustedAdministratorUserIds: [adminId],
  })
  app.use('/api/auth', (_req, res) => res.status(404).json({ error: 'Not found.' }))
  app.get('/api/events', (_req, res) => res.json({ privateCalendar: true }))
  const listener = createServer(app)
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => listener.close(resolve))
    db.close()
  })
  const host = '127.0.0.1:' + listener.address().port
  const base = 'http://' + host
  const origin = 'https://' + host
  async function fetchData(endpoint, { cookie, body, method } = {}) {
    const verb = method ?? (body ? 'POST' : 'GET')
    const response = await fetch(base + endpoint, {
      method: verb, redirect: 'manual',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(verb !== 'GET' ? { Origin: origin } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const isJson = response.headers.get('content-type')?.includes('application/json')
    return { response, data: isJson ? await response.json() : await response.text() }
  }
  async function login(username, password = oldPassword) {
    const result = await fetchData('/api/auth/login', {
      body: { username, password, deviceLabel: 'Disposable personal phone' },
    })
    assert.equal(result.response.status, 200, 'login ' + username)
    const cookie = result.response.headers.get('set-cookie')
    assert.match(cookie, /__Host-fc_gateway_session=/)
    return cookie.split(';')[0]
  }
  return { db, adminId, memberId, base, origin, fetchData, login }
}

test('anonymous forgotten username request returns generic response, not an account enumeration', async t => {
  const siteApi = await site(t)
  const { fetchData, db } = siteApi
  const forgot = await fetchData('/forgot-password')
  assert.equal(forgot.response.status, 200)
  assert.match(forgot.data, /Forgot password/)
  const availability = await fetchData('/api/auth/recovery/availability')
  assert.equal(availability.response.status, 200)
  assert.equal(availability.data.mode, 'administrator-assisted')
  const unknown = await fetchData('/api/auth/recovery/request', {
    body: { username: 'nonexistentaccount' },
  })
  const known = await fetchData('/api/auth/recovery/request', {
    body: { username: 'recoverymember' },
  })
  assert.equal(unknown.response.status, 202)
  assert.equal(known.response.status, 202)
  assert.deepEqual(unknown.data, known.data)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_recovery_requests').get().n, 1)
  const crossOrigin = await fetch(siteApi.base + '/api/auth/recovery/request', {
    method: 'POST',
    headers: { Origin: 'https://malicious.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'recoverymember' }),
  })
  assert.equal(crossOrigin.status, 403)
})

test('only an allowlisted, password-verified operator can issue a one-time reset link', async t => {
  const { db, fetchData, login, memberId } = await site(t)
  const operatorCookie = await login('recoveryoperator')
  const memberCookie = await login('recoverymember')
  const outsiderCookie = await login('recoveryoutsider')
  assert.equal((await fetchData('/api/admin/recovery/requests')).response.status, 401)
  assert.equal((await fetchData('/api/admin/recovery/requests', { cookie: memberCookie })).response.status, 403)
  assert.equal((await fetchData('/api/admin/recovery/requests', { cookie: outsiderCookie })).response.status, 403)
  await fetchData('/api/auth/recovery/request', { body: { username: 'recoverymember' } })
  const queue = await fetchData('/api/admin/recovery/requests', { cookie: operatorCookie })
  assert.equal(queue.response.status, 200)
  assert.equal(queue.data.requests.length, 1)
  const requestId = queue.data.requests[0].id
  assert.ok(!JSON.stringify(queue.data).includes('token_hash'))
  const issuePath = '/api/admin/recovery/requests/' + requestId + '/issue'
  assert.equal((await fetchData(issuePath, {
    cookie: memberCookie,
    body: { ownerPassword: oldPassword, verifiedOutOfBand: true },
  })).response.status, 403)
  assert.equal((await fetchData(issuePath, {
    cookie: operatorCookie,
    body: { ownerPassword: oldPassword, verifiedOutOfBand: false },
  })).response.status, 400)
  assert.equal((await fetchData(issuePath, {
    cookie: operatorCookie,
    body: { ownerPassword: 'bad-password', verifiedOutOfBand: true },
  })).response.status, 403)
  assert.equal((await fetchData(issuePath, {
    cookie: operatorCookie,
    body: { ownerPassword: oldPassword, verifiedOutOfBand: true, userId: memberId },
  })).response.status, 400)
  const issued = await fetchData(issuePath, {
    cookie: operatorCookie,
    body: { ownerPassword: oldPassword, verifiedOutOfBand: true },
  })
  assert.equal(issued.response.status, 200)
  assert.match(issued.data.resetUrl, /\/reset-password#token=[a-f0-9]{64}$/)
  const token = issued.data.resetUrl.split('#token=')[1]
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM family_recovery_requests').get()).includes(token))
  assert.equal((await fetchData(issuePath, {
    cookie: operatorCookie,
    body: { ownerPassword: oldPassword, verifiedOutOfBand: true },
  })).response.status, 409)
  const successful = await fetchData('/api/auth/recovery/complete', {
    body: { token, newPassword },
  })
  assert.equal(successful.response.status, 200)
  assert.deepEqual(successful.data, { ok: true, next: '/login' })
  assert.equal((await fetchData('/api/events', { cookie: memberCookie })).response.status, 401)
  assert.equal((await fetchData('/api/events', { cookie: operatorCookie })).response.status, 200)
  assert.equal((await fetchData('/api/auth/recovery/complete', {
    body: { token, newPassword: 'Another-Secure-Test-Passphrase-2026' },
  })).response.status, 400)
  const saved = db.prepare('SELECT password_hash FROM family_users WHERE id = ?').get(memberId)
  assert.equal(await verifyFamilyPassword(newPassword, saved.password_hash), true)
  await login('recoverymember', newPassword)
})

test('unverified optional contact is self-owned, password-protected and never used for recovery', async t => {
  const { db, fetchData, login } = await site(t)
  const member = await login('recoverymember')
  const outsider = await login('recoveryoutsider')
  assert.equal((await fetchData('/api/auth/recovery-contact')).response.status, 401)
  assert.equal((await fetchData('/api/auth/recovery-contact', { cookie: member })).data.email, null)
  assert.equal((await fetchData('/api/auth/recovery-contact', {
    cookie: member, body: { email: 'person@example.com', currentPassword: 'bad-password' },
  })).response.status, 403)
  const saved = await fetchData('/api/auth/recovery-contact', {
    cookie: member, body: { email: 'person@example.com', currentPassword: oldPassword },
  })
  assert.equal(saved.response.status, 200)
  assert.deepEqual(saved.data, { email: 'person@example.com', verified: false })
  const other = await fetchData('/api/auth/recovery-contact', { cookie: outsider })
  assert.equal(other.response.status, 200)
  assert.equal(other.data.email, null)
  const unknown = await fetchData('/api/auth/recovery/request', {
    body: { username: 'person@example.com' },
  })
  assert.equal(unknown.response.status, 202)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_recovery_requests').get().n, 0)
})

test('operator can deny requests without claiming identity verified; password is still mandatory', async t => {
  const { fetchData, login } = await site(t)
  const admin = await login('recoveryoperator')
  await fetchData('/api/auth/recovery/request', { body: { username: 'recoveryoutsider' } })
  const id = (await fetchData('/api/admin/recovery/requests', { cookie: admin })).data.requests[0].id
  const deny = '/api/admin/recovery/requests/' + id + '/deny'
  assert.equal((await fetchData(deny, {
    cookie: admin, body: { ownerPassword: oldPassword, verifiedOutOfBand: true },
  })).response.status, 400)
  assert.equal((await fetchData(deny, {
    cookie: admin, body: { ownerPassword: oldPassword },
  })).response.status, 200)
  assert.equal((await fetchData('/api/admin/recovery/requests', { cookie: admin })).data.requests.length, 0)
})
