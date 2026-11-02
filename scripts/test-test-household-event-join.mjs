import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { DatabaseSync } from 'node:sqlite'
import { installTestHouseholdEventJoin } from '../Server/test-household-event-join.mjs'

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(()=>db.close())
  db.exec([
    'PRAGMA foreign_keys=ON;',
    'CREATE TABLE family_users(id INTEGER PRIMARY KEY,disabled INTEGER NOT NULL DEFAULT 0) STRICT;',
    'CREATE TABLE family_sessions(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,',
    'selected_profile_kind TEXT,selected_person_id INTEGER,revoked_at INTEGER,expires_at INTEGER) STRICT;',
    'CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT NOT NULL) STRICT;',
    'CREATE TABLE events(id INTEGER PRIMARY KEY,title TEXT NOT NULL) STRICT;',
    'CREATE TABLE event_people(event_id INTEGER NOT NULL REFERENCES events(id),',
    'person_id INTEGER NOT NULL REFERENCES people(id),PRIMARY KEY(event_id,person_id)) STRICT;',
    "INSERT INTO family_users VALUES (1,0);",
    "INSERT INTO family_sessions VALUES (11,1,'person',7,NULL,999999),",
    "(12,1,'person',9,NULL,999999),(13,1,'home',NULL,NULL,999999),",
    "(14,1,'person',7,500,999999);",
    "INSERT INTO people VALUES (7,'Member A'),(9,'Member B');",
    "INSERT INTO events VALUES (22,'Family Dinner');",
  ].join('\n'))
  const app=express()
  // The real deployment mounts this after required family-auth, which
  // validates secure cookies and HTTPS same-origin POSTs.
  app.use((req,_res,next)=>{
    const session=Number(req.get('x-fixture-session'))
    if ([11,12,13,14].includes(session)) req.familyAccount={id:session,user_id:1}
    next()
  })
  return {app,db}
}
function mount(app,db,options={}) {
  return installTestHouseholdEventJoin(app,db,{
    flag:'enabled',port:13002,authMode:'required',
    rootFolder:'/tmp/family-calendar-test-security-stage',
    now:()=>1000,...options,
  })
}
async function server(t,app) {
  const listener=await new Promise(resolve=>{
    const s=app.listen(0,'127.0.0.1',()=>resolve(s))
  })
  t.after(()=>new Promise(resolve=>listener.close(resolve)))
  return 'http://127.0.0.1:'+listener.address().port
}
function request(base,path,id=11,method='GET') {
  return fetch(base+path,{method,headers:{'x-fixture-session':String(id)}})
}
test('TEST only: absent flag creates no routes or writes', async t=>{
  const {app,db}=fixture(t)
  assert.deepEqual(installTestHouseholdEventJoin(app,db,{flag:'disabled'}),{enabled:false})
  const base=await server(t,app)
  assert.equal((await request(base,'/api/test-household-events/join-capability')).status,404)
})
test('TEST only: wrong port, mode, or checkout fail closed',t=>{
  const {app,db}=fixture(t)
  for (const options of [
    {port:3001},{port:13003},{authMode:'disabled'},
    {rootFolder:'/tmp/family-calendar-live'},{rootFolder:'/tmp/other'},
    {flag:'surprise'},
  ]) assert.throws(()=>mount(app,db,options),/isolated TEST/)
})
test('joining and leaving are idempotent and scoped to selected person',async t=>{
  const {app,db}=fixture(t)
  assert.deepEqual(mount(app,db),{enabled:true})
  const base=await server(t,app)
  assert.equal((await request(base,'/api/test-household-events/join-capability',13)).status,200)
  assert.equal((await request(base,'/api/test-household-events/22/join',13,'POST')).status,403)
  assert.equal((await request(base,'/api/test-household-events/22/join',14,'POST')).status,403)
  assert.equal((await request(base,'/api/test-household-events/022/join',11,'POST')).status,400)
  assert.equal((await request(base,'/api/test-household-events/999/join',11,'POST')).status,404)
  const first=await request(base,'/api/test-household-events/22/join',11,'POST')
  assert.equal(first.status,200)
  assert.deepEqual(await first.json(),{joined:true,alreadyJoined:false})
  const again=await request(base,'/api/test-household-events/22/join',11,'POST')
  assert.deepEqual(await again.json(),{joined:true,alreadyJoined:true})
  assert.deepEqual(db.prepare('SELECT person_id FROM event_people ORDER BY person_id').all().map(row=>row.person_id),[7])
  assert.equal((await request(base,'/api/test-household-events/22/leave',12,'POST')).status,200)
  assert.deepEqual(db.prepare('SELECT person_id FROM event_people').all().map(row=>row.person_id),[7])
  const left=await request(base,'/api/test-household-events/22/leave',11,'POST')
  assert.deepEqual(await left.json(),{joined:false,alreadyLeft:false})
  const secondLeave=await request(base,'/api/test-household-events/22/leave',11,'POST')
  assert.deepEqual(await secondLeave.json(),{joined:false,alreadyLeft:true})
  assert.deepEqual(db.prepare('SELECT person_id FROM event_people').all().map(row=>row.person_id),[])
})
