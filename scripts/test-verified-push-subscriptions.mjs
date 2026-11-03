import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  createNotificationDeviceTables, registerVerifiedPushSubscription,
  unregisterVerifiedPushSubscription, listAuthorizedPushTargets,
} from '../Server/verified-push-subscriptions.mjs'

const keys = {
  p256dh: Buffer.alloc(65, 1).toString('base64url'),
  auth: Buffer.alloc(16, 2).toString('base64url'),
}
const push = (token) => ({
  endpoint: 'https://fcm.googleapis.com/fcm/send/' + token, keys,
})
function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec([
    'PRAGMA foreign_keys = ON;',
    'CREATE TABLE family_users (id INTEGER PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 0) STRICT;',
    'CREATE TABLE family_sessions (',
    'id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES family_users(id),',
    'revoked_at INTEGER, expires_at INTEGER NOT NULL,',
    "selected_profile_kind TEXT, selected_person_id INTEGER",
    ') STRICT;',
    'INSERT INTO family_users(id) VALUES(1),(2),(3);',
    "INSERT INTO family_sessions VALUES (11,1,NULL,999999,'person',7),",
    "(12,2,NULL,999999,'person',7),",
    "(13,1,NULL,999999,'home',NULL),",
    "(14,3,NULL,999999,'person',4);",
  ].join('\n'))
  createNotificationDeviceTables(db)
  createNotificationDeviceTables(db)
  // A stub for the verified *server-owned* account/person membership lookup.
  // The real gateway's mapping is in the separate unmerged PR #70.
  const links = new Map([
    [1, { householdId:'family-a', userId:1, personId:7 }],
    [2, { householdId:'family-b', userId:2, personId:7 }],
    [3, { householdId:'family-a', userId:3, personId:4 }],
  ])
  const resolveAccountPerson = ({ serverVerifiedUserId }) => links.get(serverVerifiedUserId) ?? null
  return { db, links, resolveAccountPerson }
}
const enroll = (ctx, session, user, subscription, overrides = {}) =>
  registerVerifiedPushSubscription(ctx.db, {
    serverVerifiedSessionId:session, serverVerifiedUserId:user,
    subscription, explicitOptIn:true, now:100,
    resolveAccountPerson:ctx.resolveAccountPerson, ...overrides,
  })
const target = (ctx, householdId, personId) =>
  listAuthorizedPushTargets(ctx.db, {
    trustedHouseholdId:householdId, trustedPersonId:personId,
    now:101, resolveAccountPerson:ctx.resolveAccountPerson,
  })

test('requires explicit user permission, active server session and bound personal profile', t => {
  const x=fixture(t)
  assert.throws(() => enroll(x, 11, 1, push('first'), {explicitOptIn:false}), /opt-in/)
  assert.throws(() => enroll(x, 11, 2, push('first')), /session/)
  assert.throws(() => enroll(x, 13, 1, push('first')), /Home profiles/)
  assert.equal(enroll(x, 11, 1, push('first')).registered, true)
  assert.equal(target(x,'family-a',7).length,1)
  x.db.prepare("UPDATE family_sessions SET selected_person_id=4 WHERE id=11").run()
  assert.equal(target(x,'family-a',7).length,0)
  assert.throws(() => enroll(x,11,1,push('other')), /Home profiles/)
})

test('household scoping prevents identical local person IDs from leaking subscriptions', t => {
  const x=fixture(t)
  enroll(x,11,1,push('a'))
  enroll(x,12,2,push('b'))
  assert.deepEqual(target(x,'family-a',7).map(x=>x.endpoint), [push('a').endpoint])
  assert.deepEqual(target(x,'family-b',7).map(x=>x.endpoint), [push('b').endpoint])
  assert.deepEqual(target(x,'family-a',4),[])
  assert.deepEqual(target(x,'family-c',7),[])
})

test('cannot silently transfer push endpoints to a different person, account or session', t => {
  const x=fixture(t)
  enroll(x,11,1,push('shared'))
  assert.throws(() => enroll(x,12,2,push('shared')), /already bound/)
  assert.equal(enroll(x,11,1,push('shared')).registered,true)
  assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM person_push_subscriptions').get().n,1)
  assert.equal(unregisterVerifiedPushSubscription(x.db, {
    serverVerifiedSessionId:12,serverVerifiedUserId:2,endpoint:push('shared').endpoint,now:100,
  }),false)
  assert.equal(unregisterVerifiedPushSubscription(x.db, {
    serverVerifiedSessionId:11,serverVerifiedUserId:1,endpoint:push('shared').endpoint,now:100,
  }),true)
  assert.equal(target(x,'family-a',7).length,0)
})

test('active revocation, account disable, membership removal and Home switch block delivery immediately', t => {
  const x=fixture(t)
  enroll(x,11,1,push('a'))
  assert.equal(target(x,'family-a',7).length,1)
  x.db.prepare("UPDATE family_sessions SET selected_profile_kind='home', selected_person_id=NULL WHERE id=11").run()
  assert.equal(target(x,'family-a',7).length,0)
  x.db.prepare("UPDATE family_sessions SET selected_profile_kind='person', selected_person_id=7 WHERE id=11").run()
  x.links.delete(1)
  assert.equal(target(x,'family-a',7).length,0)
  x.links.set(1,{householdId:'family-a',userId:1,personId:7})
  x.db.prepare('UPDATE family_users SET disabled=1 WHERE id=1').run()
  assert.equal(target(x,'family-a',7).length,0)
  x.db.prepare('UPDATE family_users SET disabled=0 WHERE id=1').run()
  x.db.prepare('UPDATE family_sessions SET revoked_at=101 WHERE id=11').run()
  assert.equal(target(x,'family-a',7).length,0)
})

test('invalid, spoofed or intranet push endpoints and keys are rejected', t => {
  const x=fixture(t)
  for(const endpoint of [
    'http://fcm.googleapis.com/fcm/send/a',
    'https://localhost/fcm/send/a',
    'https://127.0.0.1/a',
    'https://fcm.googleapis.com.evil.example/a',
    'https://secret@fcm.googleapis.com/a',
    'https://fcm.googleapis.com:444/a',
    'https://fcm.googleapis.com/a#frag',
  ]) {
    assert.throws(() => enroll(x,11,1,{endpoint,keys}), /endpoint/)
  }
  assert.throws(() => enroll(x,11,1,{endpoint:push('a').endpoint,keys:{p256dh:'abc',auth:keys.auth}}), /keys/)
  assert.throws(() => enroll(x,11,1,{endpoint:push('a').endpoint,keys:{p256dh:keys.p256dh,auth:'abc'}}), /keys/)
  assert.equal(target(x,'family-a',7).length,0)
})

test('resolver must confirm server user identity; no profile click can grant push permission', t => {
  const x=fixture(t)
  assert.throws(() => enroll(x,11,1,push('a'), {
    resolveAccountPerson:() => ({householdId:'family-a',userId:2,personId:7}),
  }), /Verified personal-account assignment/)
  assert.throws(() => enroll(x,11,1,push('a'), {
    resolveAccountPerson:() => Promise.resolve({householdId:'family-a',userId:1,personId:7}),
  }), /synchronous/)
  assert.equal(target(x,'family-a',7).length,0)
})
