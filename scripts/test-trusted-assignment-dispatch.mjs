import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  installAssignmentNotificationOutbox, queueEventAssignmentNotifications,
  pendingAssignmentNotifications, acknowledgeAssignmentNotification,
} from '../Server/event-assignment-notifications.mjs'
import {
  createNotificationDeviceTables, registerVerifiedPushSubscription,
} from '../Server/verified-push-subscriptions.mjs'
import { planTrustedAssignmentDispatch } from '../Server/trusted-assignment-dispatch.mjs'

const keys = {
  p256dh: Buffer.alloc(65,3).toString('base64url'),
  auth: Buffer.alloc(16,4).toString('base64url'),
}
const subscription = suffix => ({
  endpoint: 'https://fcm.googleapis.com/fcm/send/' + suffix, keys,
})
const event = personIds => ({
  id: 21, title: 'Appointment', date: '2027-02-03', personIds,
})
function setup(t) {
  const identityDatabase = new DatabaseSync(':memory:')
  t.after(()=>identityDatabase.close())
  identityDatabase.exec([
    'PRAGMA foreign_keys = ON;',
    'CREATE TABLE family_users(id INTEGER PRIMARY KEY, disabled INTEGER DEFAULT 0) STRICT;',
    'CREATE TABLE family_sessions(',
    'id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES family_users(id),',
    'revoked_at INTEGER,expires_at INTEGER NOT NULL,',
    'selected_profile_kind TEXT,selected_person_id INTEGER) STRICT;',
    'INSERT INTO family_users(id) VALUES(1),(2),(3);',
    "INSERT INTO family_sessions VALUES (11,1,NULL,999999,'person',7),",
    "(12,2,NULL,999999,'person',7),",
    "(13,3,NULL,999999,'home',NULL);",
  ].join('\n'))
  createNotificationDeviceTables(identityDatabase)
  const links = new Map([
    [1,{ householdId:'family-a', userId:1, personId:7 }],
    [2,{ householdId:'family-b', userId:2, personId:7 }],
  ])
  const resolveAccountPerson=({serverVerifiedUserId})=>
    links.get(serverVerifiedUserId)??null
  registerVerifiedPushSubscription(identityDatabase,{
    serverVerifiedSessionId:11,serverVerifiedUserId:1,
    resolveAccountPerson,explicitOptIn:true,subscription:subscription('device-a'),now:100,
  })
  registerVerifiedPushSubscription(identityDatabase,{
    serverVerifiedSessionId:12,serverVerifiedUserId:2,
    resolveAccountPerson,explicitOptIn:true,subscription:subscription('device-b'),now:100,
  })
  const sources = new WeakMap()
  function source(householdId) {
    const db = new DatabaseSync(':memory:')
    t.after(()=>db.close())
    db.exec([
      'PRAGMA foreign_keys = ON;',
      'CREATE TABLE events(id INTEGER PRIMARY KEY,title TEXT) STRICT;',
      'CREATE TABLE event_people(event_id INTEGER,person_id INTEGER,',
      'PRIMARY KEY(event_id,person_id),',
      'FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE) STRICT;',
    ].join('\n'))
    installAssignmentNotificationOutbox(db)
    sources.set(db,householdId)
    return db
  }
  // Stand-in for the existing PR #70 trusted physical-storage resolver.
  const verifySourceHousehold=({householdDatabase,trustedHouseholdId})=>
    sources.get(householdDatabase)===trustedHouseholdId
  const plan=(householdDatabase,trustedHouseholdId,id,more={})=>
    planTrustedAssignmentDispatch({
      householdDatabase,identityDatabase,trustedHouseholdId,trustedOutboxId:id,
      resolveAccountPerson,verifySourceHousehold,now:101,...more,
    })
  return {identityDatabase,source,plan,links,verifySourceHousehold,resolveAccountPerson}
}
function insert(db, personIds=[7]) {
  db.prepare('INSERT INTO events(id,title) VALUES(21,?)').run('Appointment')
  for(const id of personIds) {
    db.prepare('INSERT INTO event_people(event_id,person_id) VALUES(21,?)').run(id)
  }
  queueEventAssignmentNotifications(db,null,event(personIds),100)
  return pendingAssignmentNotifications(db)[0].id
}

test('routes matching local event/person IDs only to device in correct household', t=>{
  const f=setup(t)
  const a=f.source('family-a'),b=f.source('family-b')
  const aid=insert(a), bid=insert(b)
  const ar=f.plan(a,'family-a',aid),br=f.plan(b,'family-b',bid)
  assert.equal(ar.decision,'ready')
  assert.equal(br.decision,'ready')
  assert.deepEqual(ar.targets.map(x=>x.endpoint),[subscription('device-a').endpoint])
  assert.deepEqual(br.targets.map(x=>x.endpoint),[subscription('device-b').endpoint])
  assert.equal(ar.kind,'assigned')
  assert.equal(ar.personId,7)
  assert.equal(JSON.stringify(ar).includes('Appointment'),false)
  assert.throws(()=>f.plan(a,'family-b',aid),/Source household identity mismatch/)
  assert.throws(()=>f.plan(b,'family-a',bid),/Source household identity mismatch/)
})

test('supersedes older pending changes and suppresses no-longer-assigned notices', t=>{
  const f=setup(t),a=f.source('family-a'),first=insert(a)
  const updated={...event([7]),title:'Moved appointment'}
  queueEventAssignmentNotifications(a,event([7]),updated,101)
  const last=pendingAssignmentNotifications(a).at(-1).id
  assert.equal(f.plan(a,'family-a',first).decision,'superseded')
  assert.equal(f.plan(a,'family-a',last).decision,'ready')
  assert.equal(f.plan(a,'family-a',last).kind,'changed')
  a.prepare('DELETE FROM event_people WHERE event_id=21').run()
  assert.equal(f.plan(a,'family-a',last).decision,'stale')
})

test('unassigned routes to former assignee only if event still exists and person is absent', t=>{
  const f=setup(t),a=f.source('family-a')
  insert(a)
  a.prepare('DELETE FROM event_people WHERE event_id=21').run()
  queueEventAssignmentNotifications(a,event([7]),event([]),101)
  const pending=pendingAssignmentNotifications(a)
  const row=pending.at(-1)
  assert.equal(f.plan(a,'family-a',row.id).kind,'unassigned')
  assert.deepEqual(f.plan(a,'family-a',row.id).targets.map(x=>x.endpoint),
    [subscription('device-a').endpoint])
  a.prepare('INSERT INTO event_people(event_id,person_id) VALUES(21,7)').run()
  assert.equal(f.plan(a,'family-a',row.id).decision,'stale')
})

test('cancellation only applies to genuinely missing event, not recreated ID', t=>{
  const f=setup(t),a=f.source('family-a')
  insert(a)
  a.prepare('DELETE FROM events WHERE id=21').run()
  queueEventAssignmentNotifications(a,event([7]),null,101)
  const row=pendingAssignmentNotifications(a).at(-1)
  assert.equal(f.plan(a,'family-a',row.id).decision,'ready')
  assert.equal(f.plan(a,'family-a',row.id).kind,'cancelled')
  a.prepare('INSERT INTO events(id,title) VALUES(21,?)').run('Different appointment')
  assert.equal(f.plan(a,'family-a',row.id).decision,'stale')
})

test('revocation, Home switch and withdrawn person membership block dispatch', t=>{
  const f=setup(t),a=f.source('family-a'),id=insert(a)
  assert.equal(f.plan(a,'family-a',id).decision,'ready')
  f.identityDatabase.prepare('UPDATE family_sessions SET revoked_at=101 WHERE id=11').run()
  assert.equal(f.plan(a,'family-a',id).decision,'no_authorized_device')
  f.identityDatabase.prepare('UPDATE family_sessions SET revoked_at=NULL WHERE id=11').run()
  f.identityDatabase.prepare("UPDATE family_sessions SET selected_profile_kind='home',selected_person_id=NULL WHERE id=11").run()
  assert.equal(f.plan(a,'family-a',id).decision,'no_authorized_device')
  f.identityDatabase.prepare("UPDATE family_sessions SET selected_profile_kind='person',selected_person_id=7 WHERE id=11").run()
  f.links.delete(1)
  assert.equal(f.plan(a,'family-a',id).decision,'no_authorized_device')
})

test('outbox delivery is never acknowledged by planning, and no repeats after explicit ack', t=>{
  const f=setup(t),a=f.source('family-a'),id=insert(a)
  assert.equal(f.plan(a,'family-a',id).decision,'ready')
  assert.equal(f.plan(a,'family-a',id).decision,'ready')
  assert.equal(pendingAssignmentNotifications(a).length,1)
  assert.equal(acknowledgeAssignmentNotification(a,id,102),true)
  assert.deepEqual(f.plan(a,'family-a',id),{decision:'not_pending'})
})

test('invalid DB binding, ID, resolver, timestamps and nonexistent source fail closed', t=>{
  const f=setup(t),a=f.source('family-a'),id=insert(a)
  assert.throws(()=>f.plan(a,'family-a',id,{
    verifySourceHousehold:undefined,
  }),/source-household resolvers/)
  assert.throws(()=>f.plan(a,'family-a',id,{
    verifySourceHousehold:()=>Promise.resolve(true),
  }),/must be synchronous/)
  assert.throws(()=>f.plan(a,'family-a',id,{
    verifySourceHousehold:()=>false,
  }),/identity mismatch/)
  assert.throws(()=>f.plan(a,'family-a',0),/outbox IDs/)
  assert.throws(()=>f.plan(a,'family-a',id,{resolveAccountPerson:()=>Promise.resolve(null)}),/synchronous/)
  assert.throws(()=>f.plan(a,'family-a',id,{now:0}),/resolvers and time/)
  assert.deepEqual(f.plan(a,'family-a',999),{decision:'not_pending'})
})
