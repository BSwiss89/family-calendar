import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { setFamilyAccount, verifyFamilyPassword } from '../Server/family-auth.mjs'
import {
  RECOVERY_LINK_TTL_MS, createFamilyPasswordRecoveryTables,
  requestFamilyPasswordRecovery, listPendingFamilyPasswordRecovery,
  issueFamilyPasswordResetLink, denyFamilyPasswordRecovery,
  completeFamilyPasswordReset, readOptionalRecoveryContact,
  saveUnverifiedRecoveryContact,
} from '../Server/family-password-recovery.mjs'

const initialPassword = 'Original-Disposable-Password-For-Recovery-2026!'
const replacement = 'Replacement-Strong-Family-Account-Password-2026!'
const now = Date.now()
function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  setFamilyAccount(db, 'familyoperator', 'System Operator', initialPassword)
  setFamilyAccount(db, 'familyowner', 'Household Owner', initialPassword)
  setFamilyAccount(db, 'familychild', 'Household Child', initialPassword)
  createFamilyPasswordRecoveryTables(db)
  const id = username => db.prepare('SELECT id FROM family_users WHERE username=?').get(username).id
  return { db, admin: id('familyoperator'), owner: id('familyowner'), child: id('familychild') }
}
const request = (db, username, time = now) =>
  requestFamilyPasswordRecovery(db, { username, now: time })
const pending = (db, admin, time = now) =>
  listPendingFamilyPasswordRecovery(db, {
    serverVerifiedAdministratorUserId: admin,
    trustedAdministratorUserIds: [admin], now: time,
  })
const issue = (db, admin, id, time = now) =>
  issueFamilyPasswordResetLink(db, {
    serverVerifiedAdministratorUserId: admin,
    trustedAdministratorUserIds: [admin],
    recoveryRequestId: id, verifiedOutOfBand: true, now: time,
  })

test('forgot-password request does not disclose whether a username exists', t => {
  const { db, admin } = fixture(t)
  assert.deepEqual(request(db, 'NOBODY-AT-HOME'), { accepted: true })
  assert.deepEqual(request(db, 'familyowner'), { accepted: true })
  assert.deepEqual(request(db, 'FAMILYOWNER'), { accepted: true })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_recovery_requests').get().n, 1)
  assert.equal(pending(db, admin).length, 1)
  assert.equal(pending(db, admin)[0].username, 'familyowner')
  assert.equal(Object.keys(pending(db, admin)[0]).includes('password_hash'), false)
  assert.throws(() => listPendingFamilyPasswordRecovery(db, {
    serverVerifiedAdministratorUserId: admin + 1,
    trustedAdministratorUserIds: [admin],
  }), /system administrator/)
})

test('operator approval requires an existing pending request and attested identity', t => {
  const { db, admin, owner } = fixture(t)
  request(db, 'familyowner')
  const id = pending(db, admin)[0].id
  assert.throws(() => issueFamilyPasswordResetLink(db, {
    serverVerifiedAdministratorUserId: owner,
    trustedAdministratorUserIds: [admin],
    recoveryRequestId: id, verifiedOutOfBand: true, now,
  }), /administrator/)
  assert.throws(() => issueFamilyPasswordResetLink(db, {
    serverVerifiedAdministratorUserId: admin,
    trustedAdministratorUserIds: [admin],
    recoveryRequestId: id, verifiedOutOfBand: false, now,
  }), /independent identity/)
  const reset = issue(db, admin, id)
  assert.match(reset.token, /^[a-f0-9]{64}$/)
  assert.equal(reset.expiresAt - now, RECOVERY_LINK_TTL_MS)
  assert.equal(pending(db, admin).length, 0)
  const saved = db.prepare('SELECT token_hash, state FROM family_recovery_requests WHERE id=?').get(id)
  assert.equal(saved.state, 'issued')
  assert.equal(saved.token_hash, createHash('sha256').update(reset.token).digest('hex'))
  assert.notEqual(saved.token_hash, reset.token)
  assert.throws(() => issue(db, admin, id), /no longer pending/)
})

test('one-use recovery changes only requested user password and revokes remembered devices', async t => {
  const { db, admin, owner, child } = fixture(t)
  db.prepare([
    'INSERT INTO family_sessions(user_id,token_hash,device_label,created_at,last_seen_at,expires_at)',
    'VALUES (?, ?, ?, ?, ?, ?)',
  ].join(' ')).run(owner, 'a'.repeat(64), 'Owner Phone', now, now, now + 60000)
  db.prepare([
    'INSERT INTO family_sessions(user_id,token_hash,device_label,created_at,last_seen_at,expires_at)',
    'VALUES (?, ?, ?, ?, ?, ?)',
  ].join(' ')).run(child, 'b'.repeat(64), 'Child Phone', now, now, now + 60000)
  request(db, 'familyowner')
  const link = issue(db, admin, pending(db, admin)[0].id)
  assert.deepEqual(completeFamilyPasswordReset(db, {
    token: link.token, newPassword: replacement, now,
  }), { reset: true })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_sessions WHERE user_id=?').get(owner).n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_sessions WHERE user_id=?').get(child).n, 1)
  const ownerHash = db.prepare('SELECT password_hash FROM family_users WHERE id=?').get(owner).password_hash
  const childHash = db.prepare('SELECT password_hash FROM family_users WHERE id=?').get(child).password_hash
  assert.equal(await verifyFamilyPassword(replacement, ownerHash), true)
  assert.equal(await verifyFamilyPassword(initialPassword, ownerHash), false)
  assert.equal(await verifyFamilyPassword(initialPassword, childHash), true)
  assert.throws(() => completeFamilyPasswordReset(db, {
    token: link.token, newPassword: 'Third-Strong-Reset-Passphrase-2026!', now,
  }), /Invalid or expired/)
  assert.equal(db.prepare('SELECT token_hash FROM family_recovery_requests').get().token_hash, null)
})

test('expired or revoked links never change passwords, and operator denial is final', async t => {
  const { db, admin, owner } = fixture(t)
  request(db, 'familyowner')
  const first = pending(db, admin)[0].id
  assert.equal(denyFamilyPasswordRecovery(db, {
    serverVerifiedAdministratorUserId: admin,
    trustedAdministratorUserIds: [admin],
    recoveryRequestId: first, now,
  }), true)
  assert.equal(denyFamilyPasswordRecovery(db, {
    serverVerifiedAdministratorUserId: admin,
    trustedAdministratorUserIds: [admin],
    recoveryRequestId: first, now,
  }), false)
  request(db, 'familyowner', now + 61 * 60 * 1000)
  const second = pending(db, admin, now + 61 * 60 * 1000)[0].id
  const link = issue(db, admin, second, now + 61 * 60 * 1000)
  assert.throws(() => completeFamilyPasswordReset(db, {
    token: link.token, newPassword: replacement,
    now: now + 62 * 60 * 1000 + RECOVERY_LINK_TTL_MS,
  }), /Invalid or expired/)
  const password = db.prepare('SELECT password_hash FROM family_users WHERE id=?').get(owner).password_hash
  assert.equal(await verifyFamilyPassword(initialPassword, password), true)
})

test('optional recovery email is never verified or usable for password reset', t => {
  const { db, child } = fixture(t)
  assert.deepEqual(readOptionalRecoveryContact(db, {
    serverVerifiedUserId: child,
  }), { email: null, verified: false })
  assert.deepEqual(saveUnverifiedRecoveryContact(db, {
    serverVerifiedUserId: child, email: 'Child.Example@Family.org', now,
  }), { email: 'child.example@family.org', verified: false })
  assert.deepEqual(readOptionalRecoveryContact(db, {
    serverVerifiedUserId: child,
  }), { email: 'child.example@family.org', verified: false })
  assert.throws(() => saveUnverifiedRecoveryContact(db, {
    serverVerifiedUserId: child, email: 'not-an-email', now,
  }), /Invalid recovery email/)
  assert.deepEqual(request(db, 'child.example@family.org'), { accepted: true })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_recovery_requests').get().n, 0)
  assert.deepEqual(saveUnverifiedRecoveryContact(db, {
    serverVerifiedUserId: child, email: null, now,
  }), { email: null, verified: false })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_recovery_contacts').get().n, 0)
})

test('revoked or disabled operator/target accounts cannot issue recovery links', t => {
  const { db, admin, owner } = fixture(t)
  request(db, 'familyowner')
  const id = pending(db, admin)[0].id
  db.prepare('UPDATE family_users SET disabled = 1 WHERE id = ?').run(admin)
  assert.throws(() => issue(db, admin, id), /administrator/)
  db.prepare('UPDATE family_users SET disabled = 0 WHERE id = ?').run(admin)
  db.prepare('UPDATE family_users SET disabled = 1 WHERE id = ?').run(owner)
  assert.throws(() => issue(db, admin, id), /no longer pending/)
})
