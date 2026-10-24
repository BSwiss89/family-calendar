// All fixtures are disposable CENTRAL identity databases; no live/test files.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createHouseholdInvitationTables, issueHouseholdMemberInvitation,
  listHouseholdMemberInvitations, revokeHouseholdMemberInvitation,
  redeemHouseholdMemberInvitation, INVITATION_TTL_MS,
} from '../Server/household-member-invitations.mjs'
import {
  registerHousehold, grantHouseholdMembership,
  listGrantedHouseholdsForSessionUser,
} from '../Server/household-memberships.mjs'
import { verifyFamilyPassword } from '../Server/family-auth.mjs'

const NOW = Date.UTC(2026, 9, 24, 10)
const PASSWORD = 'Secure-Disposable-Member-Password-2026!'
const signup = (token, username, now = NOW + 1000) =>
  ({ token, username, displayName: 'Invited Person', password: PASSWORD, now })

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-household-invites-'))
  const db = new DatabaseSync(path.join(folder, 'central.db'))
  t.after(() => { db.close(); fs.rmSync(folder, { recursive: true, force: true }) })
  createHouseholdInvitationTables(db)
  const add = db.prepare(`
    INSERT INTO family_users(username, display_name, password_hash, account_kind)
    VALUES (?, ?, 'fixture-owner-no-login', ?)`)
  const ownerA = Number(add.run('aowner', 'Owner A', 'person').lastInsertRowid)
  const ownerB = Number(add.run('bowner', 'Owner B', 'person').lastInsertRowid)
  const memberA = Number(add.run('amember', 'Member A', 'person').lastInsertRowid)
  const hubA = Number(add.run('ahub', 'Kiosk', 'hub').lastInsertRowid)
  registerHousehold(db, { householdId: 'household-a', displayName: 'A Family' })
  registerHousehold(db, { householdId: 'household-b', displayName: 'B Family' })
  for (const [user, householdId, role] of [
    [ownerA, 'household-a', 'owner'], [ownerB, 'household-b', 'owner'],
    [memberA, 'household-a', 'member'], [hubA, 'household-a', 'owner'],
  ]) grantHouseholdMembership(db, {
    serverVerifiedUserId: user, householdId, role,
  })
  return { db, ownerA, ownerB, memberA, hubA }
}
const issueA = (db, owner, now = NOW) => issueHouseholdMemberInvitation(db, {
  householdId: 'household-a', serverVerifiedIssuerUserId: owner, now,
})
const listA = (db, owner, now = NOW) => listHouseholdMemberInvitations(db, {
  householdId: 'household-a', serverVerifiedOwnerUserId: owner, now,
})

test('owner issues 256-bit token stored only as hash; pending metadata hides secrets', t => {
  const { db, ownerA } = fixture(t)
  const created = issueA(db, ownerA)
  assert.match(created.token, /^[a-f0-9]{64}$/)
  assert.equal(created.expiresAt, NOW + INVITATION_TTL_MS)
  const saved = db.prepare('SELECT * FROM household_member_invitations').get()
  assert.notEqual(saved.token_hash, created.token)
  assert.match(saved.token_hash, /^[a-f0-9]{64}$/)
  assert.equal(saved.role, 'member')
  assert.deepEqual(listA(db, ownerA), [{
    id: created.invitationId, createdAt: NOW, expiresAt: NOW + INVITATION_TTL_MS,
  }])
  assert.equal(JSON.stringify(listA(db, ownerA)).includes(created.token), false)
})

test('invitation signup atomically creates person login and member grant in only one family', async t => {
  const { db, ownerA } = fixture(t)
  const invited = issueA(db, ownerA)
  const result = redeemHouseholdMemberInvitation(db, signup(invited.token, 'NEW.Person'))
  assert.deepEqual(result, { userId: result.userId, householdId: 'household-a', role: 'member' })
  assert.deepEqual(listGrantedHouseholdsForSessionUser(db, {
    serverVerifiedUserId: result.userId,
  }), [{ householdId: 'household-a', displayName: 'A Family', role: 'member' }])
  const user = db.prepare('SELECT * FROM family_users WHERE id = ?').get(result.userId)
  assert.equal(user.username, 'new.person')
  assert.equal(user.account_kind, 'person')
  assert.equal(await verifyFamilyPassword(PASSWORD, user.password_hash), true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_sessions WHERE user_id = ?')
    .get(result.userId).n, 0, 'redemption does not silently login the device')
  assert.deepEqual(listA(db, ownerA), [])
  const row = db.prepare('SELECT redeemed_user_id, redeemed_at FROM household_member_invitations WHERE id = ?')
    .get(invited.invitationId)
  assert.equal(row.redeemed_user_id, result.userId)
  assert.equal(row.redeemed_at, NOW + 1000)
  assert.throws(() => redeemHouseholdMemberInvitation(db,
    signup(invited.token, 'replayperson')), /Invalid or expired invitation/)
})

test('cross-household owners, members and hub cannot issue, list or revoke invitations', t => {
  const { db, ownerA, ownerB, memberA, hubA } = fixture(t)
  const { invitationId } = issueA(db, ownerA)
  for (const uid of [ownerB, memberA, hubA]) {
    assert.throws(() => issueA(db, uid), /owner permission/)
    assert.throws(() => listA(db, uid), /owner permission/)
    assert.throws(() => revokeHouseholdMemberInvitation(db, {
      householdId: 'household-a', serverVerifiedOwnerUserId: uid,
      invitationId, now: NOW + 1,
    }), /owner permission/)
  }
  assert.throws(() => issueHouseholdMemberInvitation(db, {
    householdId: 'household-b', serverVerifiedIssuerUserId: ownerA, now: NOW,
  }), /owner permission/)
  assert.deepEqual(listA(db, ownerA).map(x => x.id), [invitationId])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM household_memberships').get().n, 4)
})

test('revoke prevents redemption and cannot affect invitations in the other family', t => {
  const { db, ownerA, ownerB } = fixture(t)
  const inviteA = issueA(db, ownerA)
  const inviteB = issueHouseholdMemberInvitation(db, {
    householdId: 'household-b', serverVerifiedIssuerUserId: ownerB, now: NOW,
  })
  assert.equal(revokeHouseholdMemberInvitation(db, {
    householdId: 'household-a', serverVerifiedOwnerUserId: ownerA,
    invitationId: inviteB.invitationId, now: NOW + 1,
  }), false)
  assert.equal(revokeHouseholdMemberInvitation(db, {
    householdId: 'household-a', serverVerifiedOwnerUserId: ownerA,
    invitationId: inviteA.invitationId, now: NOW + 1,
  }), true)
  assert.equal(revokeHouseholdMemberInvitation(db, {
    householdId: 'household-a', serverVerifiedOwnerUserId: ownerA,
    invitationId: inviteA.invitationId, now: NOW + 2,
  }), false)
  assert.throws(() => redeemHouseholdMemberInvitation(db, signup(inviteA.token, 'gone')), /Invalid or expired invitation/)
  assert.deepEqual(redeemHouseholdMemberInvitation(db,
    signup(inviteB.token, 'friendb')).householdId, 'household-b')
})

test('expired token fails precisely at 72h and revoked issuer loses invitation authority', t => {
  const { db, ownerA } = fixture(t)
  const invited = issueA(db, ownerA)
  assert.throws(() => redeemHouseholdMemberInvitation(db,
    signup(invited.token, 'late', NOW + INVITATION_TTL_MS)), /Invalid or expired invitation/)
  assert.deepEqual(listA(db, ownerA, NOW + INVITATION_TTL_MS), [])
  const second = issueA(db, ownerA, NOW + INVITATION_TTL_MS + 1)
  db.prepare(`
    UPDATE household_memberships SET disabled = 1
    WHERE user_id = ?`).run(ownerA)
  assert.throws(() => redeemHouseholdMemberInvitation(db,
    signup(second.token, 'revoked', NOW + INVITATION_TTL_MS + 2)),
  /Invalid or expired invitation/)
  assert.throws(() => listA(db, ownerA), /owner permission/)
})

test('invalid role, tokens, username, password and duplicate username never consume valid token', t => {
  const { db, ownerA } = fixture(t)
  assert.throws(() => issueHouseholdMemberInvitation(db, {
    householdId: 'household-a', serverVerifiedIssuerUserId: ownerA, now: NOW, role: 'owner',
  }), /cannot confer owner/)
  const invite = issueA(db, ownerA)
  for (const token of ['', null, '../secret', invite.token.toUpperCase(), 'x'.repeat(64)]) {
    assert.throws(() => redeemHouseholdMemberInvitation(db,
      signup(token, 'something')), /Invalid or expired invitation/)
  }
  assert.throws(() => redeemHouseholdMemberInvitation(db, signup(invite.token, 'a')), /Username/)
  assert.throws(() => redeemHouseholdMemberInvitation(db, {
    ...signup(invite.token, 'validuser'), password: 'short',
  }), /password/i)
  assert.throws(() => redeemHouseholdMemberInvitation(db, signup(invite.token, 'aowner')), /UNIQUE/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_users').get().n, 4)
  assert.equal(db.prepare('SELECT redeemed_at FROM household_member_invitations').get().redeemed_at, null)
  assert.equal(redeemHouseholdMemberInvitation(db, signup(invite.token, 'validuser')).role, 'member')
})

test('owner rate limit bounds automated invitation bursts', t => {
  const { db, ownerA } = fixture(t)
  for (let i = 0; i < 5; i++) issueA(db, ownerA, NOW + i)
  assert.throws(() => issueA(db, ownerA, NOW + 6), /Too many invitations/)
  assert.equal(listA(db, ownerA).length, 5)
  assert.equal(issueA(db, ownerA, NOW + 60 * 60 * 1000 + 7).token.length, 64)
})

test('invalid/unknown household or server-verified actor never creates new records', t => {
  const { db, ownerA } = fixture(t)
  for (const householdId of ['household-b', '../../home', 'HOUSEHOLD-A', 'missing']) {
    assert.throws(() => issueHouseholdMemberInvitation(db, {
      householdId, serverVerifiedIssuerUserId: ownerA, now: NOW,
    }))
  }
  for (const uid of [0, -1, '1', null, undefined]) {
    assert.throws(() => issueA(db, uid), /Invalid verified owner/)
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM household_member_invitations').get().n, 0)
})
