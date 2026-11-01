// Disposable independent-family onboarding tests: never use LIVE/TEST storage.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import express from 'express'
import {
  createIndependentHouseholdInvitationTables, issueIndependentHouseholdInvitation,
  revokeIndependentHouseholdInvitation, redeemIndependentHouseholdInvitation,
  INDEPENDENT_INVITATION_TTL_MS,
} from '../Server/independent-household-invitations.mjs'
import { installPrivateIndependentHouseholdSignup } from '../Server/private-independent-household-signup.mjs'
import { installFamilyAuth, setFamilyAccount, verifyFamilyPassword } from '../Server/family-auth.mjs'
import { listGrantedHouseholdsForSessionUser } from '../Server/household-memberships.mjs'
import { resolveHouseholdStorage } from '../Server/household-storage.mjs'

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Server')
const NOW = Date.UTC(2026, 9, 26, 12)
const PASSWORD = 'Strong-Private-Owner-Password-2026!'
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-independent-invites-'))
  const storageRoot = path.join(root, 'storage')
  fs.mkdirSync(storageRoot, { mode: 0o700 })
  const db = new DatabaseSync(':memory:')
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  createIndependentHouseholdInvitationTables(db)
  setFamilyAccount(db, 'calendaradmin', 'Calendar Admin', PASSWORD)
  setFamilyAccount(db, 'ordinaryuser', 'Ordinary', PASSWORD)
  setFamilyAccount(db, 'devicehub', 'Device', PASSWORD, { accountKind: 'hub' })
  const ids = Object.fromEntries(db.prepare('SELECT id, username FROM family_users').all()
    .map(x => [x.username, x.id]))
  const allowed = [ids.calendaradmin]
  const issue = (issuer = ids.calendaradmin, now = NOW) =>
    issueIndependentHouseholdInvitation(db, {
      serverVerifiedAdministratorUserId: issuer,
      trustedAdministratorUserIds: allowed, now,
    })
  const redeem = (token, overrides = {}) =>
    redeemIndependentHouseholdInvitation(db, {
      token, username: 'newowner', displayName: 'New Owner',
      password: PASSWORD, householdName: 'Private New Household',
      serverDirectory, storageRoot, trustedAdministratorUserIds: allowed,
      now: NOW + 1000, ...overrides,
    })
  return { root, storageRoot, db, ids, allowed, issue, redeem }
}

test('explicit administrator allowlist is required; ordinary and hub accounts cannot create families', t => {
  const f = fixture(t)
  for (const id of [f.ids.ordinaryuser, f.ids.devicehub]) {
    assert.throws(() => f.issue(id), /administrator permission/)
  }
  assert.throws(() => issueIndependentHouseholdInvitation(f.db, {
    serverVerifiedAdministratorUserId: f.ids.calendaradmin,
    trustedAdministratorUserIds: [],
  }), /administrator permission/)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM independent_household_invitations').get().n, 0)
  const invite = f.issue()
  assert.match(invite.token, /^[a-f0-9]{64}$/)
  assert.equal(invite.expiresAt, NOW + INDEPENDENT_INVITATION_TTL_MS)
  const row = f.db.prepare('SELECT * FROM independent_household_invitations').get()
  assert.equal(row.token_hash.length, 64)
  assert.notEqual(row.token_hash, invite.token)
  assert.equal(JSON.stringify(row).includes(invite.token), false)
})

test('new invited owner gets own empty SQLite, upload path and ONE household membership', async t => {
  const f = fixture(t)
  const invitation = f.issue()
  const registered = f.redeem(invitation.token)
  assert.equal(registered.role, 'owner')
  assert.equal(registered.activation, 'pending')
  assert.match(registered.householdId, /^family-[a-f0-9]{24}$/)
  const storage = resolveHouseholdStorage({
    serverDirectory, storageRoot: f.storageRoot, householdId: registered.householdId,
  })
  assert.equal(fs.existsSync(storage.databasePath), true)
  assert.deepEqual(fs.readdirSync(storage.uploadFolder), [])
  assert.deepEqual(f.db.prepare('SELECT * FROM family_sessions').all(), [])
  const account = f.db.prepare("SELECT * FROM family_users WHERE username = 'newowner'").get()
  assert.equal(account.account_kind, 'person')
  assert.equal(await verifyFamilyPassword(PASSWORD, account.password_hash), true)
  assert.deepEqual(listGrantedHouseholdsForSessionUser(f.db, {
    serverVerifiedUserId: account.id,
  }), [{
    householdId: registered.householdId, displayName: 'Private New Household', role: 'owner',
  }])
  assert.throws(() => f.redeem(invitation.token, { username: 'anotherowner' }), /Invalid or expired/)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM household_registry').get().n, 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM household_memberships').get().n, 1)
})

test('revoked, expired, disabled administrator and duplicate usernames cannot grant ownership', t => {
  const f = fixture(t)
  const revoked = f.issue()
  assert.equal(revokeIndependentHouseholdInvitation(f.db, {
    serverVerifiedAdministratorUserId: f.ids.calendaradmin,
    trustedAdministratorUserIds: f.allowed, invitationId: revoked.invitationId, now: NOW + 1,
  }), true)
  assert.throws(() => f.redeem(revoked.token), /Invalid or expired/)
  const expired = f.issue(f.ids.calendaradmin, NOW + 3600001)
  assert.throws(() => f.redeem(expired.token, {
    now: NOW + 3600001 + INDEPENDENT_INVITATION_TTL_MS,
  }), /Invalid or expired/)
  const pending = f.issue(f.ids.calendaradmin, NOW + 7200002)
  f.db.prepare("UPDATE family_users SET disabled = 1 WHERE username = 'calendaradmin'").run()
  assert.throws(() => f.redeem(pending.token), /Invalid or expired/)
  f.db.prepare("UPDATE family_users SET disabled = 0 WHERE username = 'calendaradmin'").run()
  assert.throws(() => f.redeem(pending.token, { username: 'ordinaryuser' }), /Username unavailable/)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM household_registry').get().n, 0)
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM independent_household_invitations WHERE redeemed_at IS NOT NULL").get().n, 0)
  assert.throws(() => f.redeem(pending.token, { password: 'weak' }), /14/)
  assert.throws(() => f.redeem(pending.token, { role: 'hub', householdId: '../../other' , username: 'invalid*' }), /Invalid registration/)
})

test('quota and cross-issuer revocation reject unauthorized administration', t => {
  const f = fixture(t)
  const invitations = [f.issue(), f.issue(f.ids.calendaradmin, NOW + 1), f.issue(f.ids.calendaradmin, NOW + 2)]
  assert.throws(() => f.issue(f.ids.calendaradmin, NOW + 3), /limit reached/)
  assert.throws(() => revokeIndependentHouseholdInvitation(f.db, {
    serverVerifiedAdministratorUserId: f.ids.ordinaryuser,
    trustedAdministratorUserIds: f.allowed, invitationId: invitations[0].invitationId,
    now: NOW + 4,
  }), /administrator permission/)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM independent_household_invitations WHERE revoked_at IS NULL').get().n, 3)
})

test('SQLite failure after exclusive storage creation rolls back all account authority', t => {
  const f = fixture(t)
  const invite = f.issue()
  f.db.exec("CREATE TRIGGER reject_registry BEFORE INSERT ON household_registry BEGIN SELECT RAISE(ABORT, 'blocked'); END")
  assert.throws(() => f.redeem(invite.token), /blocked/)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM household_registry').get().n, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM household_memberships').get().n, 0)
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM family_users WHERE username = 'newowner'").get().n, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM independent_household_invitations WHERE redeemed_at IS NOT NULL').get().n, 0)
  assert.equal(fs.readdirSync(path.join(f.storageRoot, 'households')).length, 1,
    'Unregistered orphan remains quarantined for trusted offline review')
})

test('anonymous fragment-only registration rejects role, origin, replay and oversized payloads', async t => {
  const f = fixture(t)
  const app = express()
  app.use('/api/auth/login', express.json({ limit: '32kb' }))
  installPrivateIndependentHouseholdSignup(app, {
    identityDatabase: f.db, serverDirectory, storageRoot: f.storageRoot,
    trustedAdministratorUserIds: f.allowed,
  })
  installFamilyAuth(app, f.db, serverDirectory, 'required', {
    cookieName: '__Host-fc_gateway_session',
  })
  app.get('/api/events', (_req, res) => res.json({ error: 'never anonymous' }))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = 'http://127.0.0.1:' + server.address().port
  const origin = 'https://127.0.0.1:' + server.address().port
  const invite = f.issue(f.ids.calendaradmin, Date.now())
  const body = { token: invite.token, username: 'friendone', displayName: 'Friend',
    householdName: 'Friends Own Home', password: PASSWORD }
  const post = (payload, options = {}) => fetch(base + '/api/households/create-from-invitation', {
    method: 'POST',
    headers: { Origin: options.origin ?? origin,
      'Content-Type': options.contentType ?? 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
  const page = await fetch(base + '/start-family')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Start your own family calendar/)
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
  const script = await (await fetch(base + '/auth/start-family.js')).text()
  assert.match(script, /location\.hash/)
  assert.match(script, /history\.replaceState/)
  assert.doesNotMatch(script, /localStorage|sessionStorage/)
  assert.equal((await fetch(base + '/api/events')).status, 401)
  assert.equal((await post(body, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await post({ ...body, householdId: 'some-other', role: 'hub' })).status, 400)
  assert.equal((await post({ ...body, accountKind: 'hub' })).status, 400)
  const malformed = await post('{"token":"' + invite.token + '",bad-json')
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.text()).includes(invite.token), false)
  const oversized = await post('{"filler":"' + 'z'.repeat(5000) + '"}')
  assert.equal(oversized.status, 413)
  const created = await post(body)
  assert.equal(created.status, 201)
  assert.deepEqual(await created.json(), { ok: true, next: '/login', activation: 'pending' })
  assert.equal(created.headers.get('set-cookie'), null)
  assert.equal((await post({ ...body, username: 'friendtwo' })).status, 400)
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM household_registry').get().n, 1)
})
