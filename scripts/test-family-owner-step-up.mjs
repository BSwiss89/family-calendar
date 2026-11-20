import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { setFamilyAccount } from '../Server/family-auth.mjs'
import { createOwnerPasswordStepUp } from '../Server/family-owner-step-up.mjs'

const password = 'Only-An-Example-For-Disposable-Tests-2026!'

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  setFamilyAccount(db, 'familyowner', 'Family Owner', password)
  const userId = db.prepare('SELECT id FROM family_users WHERE username = ?').get('familyowner').id
  return { db, userId }
}

test('sensitive member changes require the actual authenticated Owner password', async t => {
  const { db, userId } = fixture(t)
  const stepUp = createOwnerPasswordStepUp()
  assert.deepEqual(await stepUp.verify(db, {
    serverVerifiedUserId: userId, password: 'Incorrect-Password',
  }), { status: 'denied' })
  assert.deepEqual(await stepUp.verify(db, {
    serverVerifiedUserId: userId, password,
  }), { status: 'verified' })
  assert.deepEqual(await stepUp.verify(db, {
    serverVerifiedUserId: userId, password,
  }), { status: 'verified' })
  assert.deepEqual(await stepUp.verify(db, {
    serverVerifiedUserId: 999, password,
  }), { status: 'denied' })
  assert.deepEqual(await stepUp.verify(db, {
    serverVerifiedUserId: '1', password,
  }), { status: 'denied' })
})

test('Owner password verification is rate-limited and recovers only after expiry', async t => {
  const { db, userId } = fixture(t)
  let clock = 5000
  const stepUp = createOwnerPasswordStepUp({
    now: () => clock, windowMs: 60000, maxFailures: 3,
  })
  for (let i = 0; i < 3; i++) {
    assert.equal((await stepUp.verify(db, {
      serverVerifiedUserId: userId, password: 'wrong-' + i,
    })).status, 'denied')
  }
  assert.deepEqual(await stepUp.verify(db, {
    serverVerifiedUserId: userId, password,
  }), { status: 'limited', retryAfter: 60 })
  clock += 60001
  assert.deepEqual(await stepUp.verify(db, {
    serverVerifiedUserId: userId, password,
  }), { status: 'verified' })
})

test('disabled, Hub, or changed-password account cannot pass stored phone authentication', async t => {
  const { db, userId } = fixture(t)
  const stepUp = createOwnerPasswordStepUp()
  db.prepare('UPDATE family_users SET disabled = 1 WHERE id = ?').run(userId)
  assert.equal((await stepUp.verify(db, { serverVerifiedUserId: userId, password })).status, 'denied')
  db.prepare('UPDATE family_users SET disabled = 0, account_kind = ? WHERE id = ?').run('hub', userId)
  assert.equal((await stepUp.verify(db, { serverVerifiedUserId: userId, password })).status, 'denied')
  db.prepare('UPDATE family_users SET account_kind = ? WHERE id = ?').run('person', userId)
  setFamilyAccount(db, 'familyowner', 'Family Owner', 'Different-Passphrase-For-Sensitive-Changes!')
  assert.equal((await stepUp.verify(db, { serverVerifiedUserId: userId, password })).status, 'denied')
  assert.equal((await stepUp.verify(db, {
    serverVerifiedUserId: userId, password: 'Different-Passphrase-For-Sensitive-Changes!',
  })).status, 'verified')
})
