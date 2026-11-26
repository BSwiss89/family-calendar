import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { DatabaseSync } from 'node:sqlite'
import {
  installTestNotificationInboxPilot,
} from '../Server/test-notification-inbox-pilot.mjs'

function makeDb(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec([
    'PRAGMA foreign_keys=ON;',
    'CREATE TABLE family_users(id INTEGER PRIMARY KEY,disabled INTEGER NOT NULL DEFAULT 0) STRICT;',
    'CREATE TABLE family_sessions(',
    'id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES family_users(id),',
    'revoked_at INTEGER,expires_at INTEGER NOT NULL,',
    'selected_profile_kind TEXT,selected_person_id INTEGER) STRICT;',
    'CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT NOT NULL) STRICT;',
    'CREATE TABLE events(id INTEGER PRIMARY KEY,date TEXT,title TEXT,',
    'end_date TEXT,time TEXT,end_time TEXT,notes TEXT,location TEXT,',
    'repeat_unit TEXT,repeat_interval INTEGER,repeat_end_type TEXT,',
    'repeat_end_date TEXT,repeat_count INTEGER) STRICT;',
    'CREATE TABLE event_people(event_id INTEGER NOT NULL,person_id INTEGER NOT NULL,',
    'PRIMARY KEY(event_id,person_id),',
    'FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE) STRICT;',
    'CREATE TABLE event_exceptions(event_id INTEGER NOT NULL,occurrence_date TEXT NOT NULL,',
    'PRIMARY KEY(event_id,occurrence_date),',
    'FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE) STRICT;',
    'INSERT INTO people VALUES(7,\'Person 7\'),(9,\'Person 9\');',
    'INSERT INTO family_users VALUES(1,0);',
    'INSERT INTO family_sessions VALUES',
    '(11,1,NULL,999999,\'person\',7),',
    '(12,1,NULL,999999,\'person\',9),',
    '(13,1,NULL,999999,\'home\',NULL);',
  ].join('\n'))
  return db
}
function exists(db,name) {
  return Boolean(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(name))
}
function setupApp(db) {
  const app=express()
  // TEST FIXTURE ONLY. Production authentication comes from installFamilyAuth,
  // which validates its HTTPS session cookie and enforces same-origin POSTs.
  app.use((req,res,next)=>{
    const s=Number(req.get('x-fixture-session'))
    if (s === 11 || s === 12 || s === 13) {
      req.familyAccount={id:s,user_id:1}
    }
    next()
  })
  return app
}
async function withServer(t,app) {
  const listener=await new Promise(resolve=>{
    const active=app.listen(0,'127.0.0.1',()=>resolve(active))
  })
  t.after(()=>new Promise(resolve=>listener.close(resolve)))
  return 'http://127.0.0.1:'+listener.address().port
}
function pilot(app,db,more={}) {
  return installTestNotificationInboxPilot(app,db,{
    flag:'enabled',port:13002,authMode:'required',
    rootFolder:'/tmp/family-calendar-test-security-stage',
    now:()=>1000,...more,
  })
}
async function get(base,path,id=11) {
  return fetch(base+path,{headers:{'x-fixture-session':String(id)},redirect:'manual'})
}
async function post(base,path,id=11) {
  return fetch(base+path,{method:'POST',headers:{'x-fixture-session':String(id)},redirect:'manual'})
}
function createEvent(db,id,people) {
  db.prepare('INSERT INTO events(id,date,title) VALUES(?,?,?)')
    .run(id,'2027-05-01','Appointment')
  for(const person of people) db.prepare(
    'INSERT INTO event_people(event_id,person_id) VALUES (?,?)'
  ).run(id,person)
}

test('disabled default makes no migration and installs no routes',async t=>{
  const db=makeDb(t),app=setupApp(db)
  assert.deepEqual(installTestNotificationInboxPilot(app,db,{
    rootFolder:'/tmp/family-calendar-test-security-stage',flag:'disabled',
  }),{enabled:false})
  assert.equal(exists(db,'assignment_notification_outbox'),false)
  assert.equal(exists(db,'notification_dirty_events'),false)
  const base=await withServer(t,app)
  assert.equal((await get(base,'/test-notification-pilot')).status,404)
})

test('wrong port, auth mode, checkout and config fail before any migration',t=>{
  const db=makeDb(t),app=setupApp(db)
  for(const opts of [
    {port:3001},{port:13003},{authMode:'disabled'},
    {rootFolder:'/tmp/family-calendar-live'},{rootFolder:'/tmp/household-preview'},
    {flag:'unexpected'},
  ]) {
    assert.throws(()=>pilot(app,db,opts),/TEST notification pilot requires/)
  }
  assert.equal(exists(db,'notification_dirty_events'),false)
  assert.equal(exists(db,'assignment_notification_outbox'),false)
})

test('native refresh form keeps secure Origin while unrelated routes retain no-referrer',async t=>{
  const db=makeDb(t),app=setupApp(db)
  // Match production required family-auth securityHeaders middleware.
  app.use((_request,response,next)=>{
    response.set('Referrer-Policy','no-referrer')
    next()
  })
  pilot(app,db)
  const base=await withServer(t,app)
  const personPage=await get(base,'/test-notification-pilot',11)
  assert.equal(personPage.status,200)
  assert.equal(personPage.headers.get('referrer-policy'),'same-origin')
  const api=await get(base,'/api/test-notification-pilot',11)
  assert.equal(api.status,200)
  assert.equal(api.headers.get('referrer-policy'),'no-referrer')
  const homePage=await get(base,'/test-notification-pilot',13)
  assert.equal(homePage.status,403)
  assert.equal(homePage.headers.get('referrer-policy'),'no-referrer')
})

test('real HTTP pilot shows person-selected event changes, never Home or other persons',async t=>{
  const db=makeDb(t)
  createEvent(db,1,[7]) // preexisting data must not notify on migration
  const app=setupApp(db)
  assert.deepEqual(pilot(app,db),{enabled:true})
  const base=await withServer(t,app)
  const start=await get(base,'/api/test-notification-pilot')
  assert.equal(start.status,200)
  assert.deepEqual((await start.json()).notifications,[])
  assert.equal((await get(base,'/test-notification-pilot',13)).status,403)
  assert.equal((await get(base,'/api/test-notification-pilot',13)).status,403)
  assert.equal((await post(base,'/test-notification-pilot/refresh',13)).status,403)
  assert.equal((await get(base,'/api/test-notification-pilot',99)).status,401)
  db.prepare("UPDATE events SET title='Updated appointment' WHERE id=1").run()
  createEvent(db,2,[9])
  let result=await post(base,'/test-notification-pilot/refresh')
  assert.equal(result.status,303)
  assert.equal(result.headers.get('location'),'/test-notification-pilot')
  const for7=await (await get(base,'/api/test-notification-pilot',11)).json()
  const for9=await (await get(base,'/api/test-notification-pilot',12)).json()
  assert.deepEqual(for7.notifications.map(x=>({eventId:x.eventId,kind:x.kind})),[
    {eventId:1,kind:'changed'},
  ])
  assert.deepEqual(for9.notifications.map(x=>({eventId:x.eventId,kind:x.kind})),[
    {eventId:2,kind:'assigned'},
  ])
  const html=await (await get(base,'/test-notification-pilot',11)).text()
  assert.match(html,/TEST Notification Inbox/)
  assert.match(html,/Updated/)
  assert.doesNotMatch(html,/Updated appointment/) // private title not in inbox
  assert.doesNotMatch(html,/Event #2/)
  result=await post(base,'/test-notification-pilot/refresh')
  assert.equal(result.status,303)
  assert.equal((await (await get(base,'/api/test-notification-pilot',11)).json()).notifications.length,1)
})

test('changing device profile to Home and revoking session immediately blocks inbox',async t=>{
  const db=makeDb(t),app=setupApp(db)
  pilot(app,db)
  const base=await withServer(t,app)
  assert.equal((await get(base,'/test-notification-pilot',11)).status,200)
  db.prepare("UPDATE family_sessions SET selected_profile_kind='home',selected_person_id=NULL WHERE id=11").run()
  assert.equal((await get(base,'/test-notification-pilot',11)).status,403)
  db.prepare("UPDATE family_sessions SET selected_profile_kind='person',selected_person_id=7 WHERE id=11").run()
  db.prepare('UPDATE family_sessions SET revoked_at=1000 WHERE id=11').run()
  assert.equal((await get(base,'/api/test-notification-pilot',11)).status,401)
})

test('TEST pilot catches direct batch deletion, event reassignments and recurring exceptions',async t=>{
  const db=makeDb(t)
  createEvent(db,21,[7])
  const app=setupApp(db)
  pilot(app,db)
  const base=await withServer(t,app)
  db.prepare('DELETE FROM event_people WHERE event_id=21 AND person_id=7').run()
  db.prepare('INSERT INTO event_people(event_id,person_id) VALUES(21,9)').run()
  assert.equal((await post(base,'/test-notification-pilot/refresh',12)).status,303)
  assert.deepEqual((await (await get(base,'/api/test-notification-pilot',11)).json())
    .notifications.map(x=>x.kind),['unassigned'])
  assert.deepEqual((await (await get(base,'/api/test-notification-pilot',12)).json())
    .notifications.map(x=>x.kind),['assigned'])
  db.prepare("INSERT INTO event_exceptions VALUES(21,'2027-05-08')").run()
  assert.equal((await post(base,'/test-notification-pilot/refresh',12)).status,303)
  assert.equal((await (await get(base,'/api/test-notification-pilot',12)).json())
    .notifications[0].kind,'changed')
  db.prepare('DELETE FROM events WHERE id=21').run()
  assert.equal((await post(base,'/test-notification-pilot/refresh',12)).status,303)
  assert.equal((await (await get(base,'/api/test-notification-pilot',12)).json())
    .notifications[0].kind,'cancelled')
})


test('assignment acknowledgements belong to selected profile and survive refresh',async t=>{
  const db=makeDb(t),app=setupApp(db)
  pilot(app,db)
  const base=await withServer(t,app)
  createEvent(db,56,[7])
  assert.equal((await post(base,'/test-notification-pilot/refresh')).status,303)
  const inbox=await (await get(base,'/api/test-notification-pilot',11)).json()
  assert.equal(inbox.notifications.length,1)
  assert.equal(inbox.notifications[0].acknowledged,false)
  const id=inbox.notifications[0].id
  assert.equal((await post(base,'/api/test-notification-pilot/'+id+'/acknowledge',13)).status,403)
  assert.equal((await post(base,'/api/test-notification-pilot/'+id+'/acknowledge',12)).status,404)
  assert.equal((await post(base,'/api/test-notification-pilot/0001/acknowledge',11)).status,400)
  assert.equal((await post(base,'/api/test-notification-pilot/'+id+'/acknowledge',11)).status,200)
  assert.equal((await post(base,'/api/test-notification-pilot/'+id+'/acknowledge',11)).status,200)
  const after=await (await get(base,'/api/test-notification-pilot',11)).json()
  assert.equal(after.notifications.length,1)
  assert.equal(after.notifications[0].acknowledged,true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM test_assignment_acknowledgements').get().n,1)
  assert.equal((await post(base,'/test-notification-pilot/refresh')).status,303)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assignment_notification_outbox').get().n,1)
})

test('updated-event acknowledgements name changed fields without exposing private values',async t=>{
  const db=makeDb(t)
  createEvent(db,88,[7,9])
  const app=setupApp(db)
  pilot(app,db)
  const base=await withServer(t,app)
  db.prepare([
    'UPDATE events SET title=?,date=?,time=?,end_time=?,',
    'location=?,notes=?,repeat_unit=?,repeat_interval=? WHERE id=?',
  ].join(' ')).run('Private dinner','2027-05-06','18:30','20:00',
    'Private house','Bring medication', 'weekly', 2, 88)
  assert.equal((await post(base,'/test-notification-pilot/refresh',11)).status,303)
  const seven=await (await get(base,'/api/test-notification-pilot',11)).json()
  const nine=await (await get(base,'/api/test-notification-pilot',12)).json()
  assert.deepEqual(seven.notifications[0].changedFields,
    ['title','date','time','endTime','location','notes','repeatUnit','repeatInterval'])
  assert.deepEqual(nine.notifications[0].changedFields,seven.notifications[0].changedFields)
  assert.equal(seven.notifications[0].kind,'changed')
  assert.doesNotMatch(JSON.stringify(seven),/Private dinner|Private house|Bring medication/)
  assert.equal((await get(base,'/api/test-notification-pilot',13)).status,403)
  const firstId=seven.notifications[0].id
  // Newer changes must not rewrite what an unacknowledged earlier notice recorded.
  db.prepare("UPDATE events SET date='2027-05-08' WHERE id=88").run()
  assert.equal((await post(base,'/test-notification-pilot/refresh')).status,303)
  const pending=(await (await get(base,'/api/test-notification-pilot')).json()).notifications
  assert.deepEqual(pending[0].changedFields,['date'])
  assert.equal(pending[1].id,firstId)
  assert.deepEqual(pending[1].changedFields,seven.notifications[0].changedFields)
})

test('recurring exception update records the affected schedule field, not private event text',async t=>{
  const db=makeDb(t)
  createEvent(db,89,[7])
  const app=setupApp(db)
  pilot(app,db)
  const base=await withServer(t,app)
  db.prepare("INSERT INTO event_exceptions VALUES(89,'2027-05-08')").run()
  assert.equal((await post(base,'/test-notification-pilot/refresh')).status,303)
  const data=await (await get(base,'/api/test-notification-pilot')).json()
  assert.deepEqual(data.notifications[0].changedFields,['occurrences'])
  assert.equal(data.notifications[0].kind,'changed')
})

test('deleted event keeps its original details for each recipient until acknowledgement',async t=>{
  const db=makeDb(t)
  createEvent(db,90,[7,9])
  const app=setupApp(db)
  pilot(app,db)
  const base=await withServer(t,app)
  db.prepare([
    'UPDATE events SET title=?,date=?,end_date=?,time=?,end_time=?,',
    'location=?,notes=? WHERE id=?',
  ].join(' ')).run('Team practice','2027-05-04','2027-05-05',
    '18:30','20:00','Community center','Private note not in notice',90)
  db.prepare('DELETE FROM events WHERE id=90').run()
  assert.equal((await post(base,'/test-notification-pilot/refresh',11)).status,303)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_deleted_event_details')
    .get().n,0,'temporary pre-delete snapshot must be erased after reconciliation')
  const seven=(await (await get(base,'/api/test-notification-pilot',11)).json()).notifications
  const nine=(await (await get(base,'/api/test-notification-pilot',12)).json()).notifications
  const expected={
    title:'Team practice',date:'2027-05-04',endDate:'2027-05-05',
    time:'18:30',endTime:'20:00',location:'Community center',
  }
  for(const notices of [seven,nine]) {
    assert.equal(notices.length,1)
    assert.equal(notices[0].kind,'cancelled')
    assert.deepEqual(notices[0].cancelledEvent,expected)
    assert.equal(notices[0].acknowledged,false)
    assert.doesNotMatch(JSON.stringify(notices),/Private note not in notice/)
  }
  assert.notEqual(seven[0].id,nine[0].id)
  assert.equal((await get(base,'/api/test-notification-pilot',13)).status,403)
  assert.equal((await get(base,'/api/test-notification-pilot',99)).status,401)
  assert.equal((await post(base,
    '/api/test-notification-pilot/'+nine[0].id+'/acknowledge',11)).status,404)
  assert.equal((await post(base,
    '/api/test-notification-pilot/'+seven[0].id+'/acknowledge',11)).status,200)
  const after=(await (await get(base,'/api/test-notification-pilot',12)).json()).notifications
  assert.deepEqual(after[0].cancelledEvent,expected)
  assert.equal(after[0].acknowledged,false)
})

test('legacy cancellation notices remain readable without falsely guessing event data',async t=>{
  const db=makeDb(t),app=setupApp(db)
  pilot(app,db)
  db.prepare([
    'INSERT INTO assignment_notification_outbox(',
    'event_id,person_id,kind,created_at)',
    "VALUES (999,7,'cancelled',1000)",
  ].join(' ')).run()
  const base=await withServer(t,app)
  const notes=(await (await get(base,'/api/test-notification-pilot',11)).json()).notifications
  assert.equal(notes.length,1)
  assert.equal(notes[0].kind,'cancelled')
  assert.equal(notes[0].cancelledEvent,null)
})

test('TEST cancellation replaces older pending notifications for the same event and person',async t=>{
  const db=makeDb(t),app=setupApp(db)
  pilot(app,db)
  const base=await withServer(t,app)
  createEvent(db,101,[7,9])
  createEvent(db,102,[7]) // unrelated event must remain in the inbox
  assert.equal((await post(base,'/test-notification-pilot/refresh',11)).status,303)
  const originally=(await (await get(base,'/api/test-notification-pilot',11)).json()).notifications
  const oldAssignment=originally.find(x=>x.eventId===101&&x.kind==='assigned')
  assert.ok(oldAssignment)
  // Earlier acknowledgement remains durable, even once its notice is superseded.
  assert.equal((await post(base,
    '/api/test-notification-pilot/'+oldAssignment.id+'/acknowledge',11)).status,200)
  db.prepare("UPDATE events SET title='Updated appointment' WHERE id=101").run()
  assert.equal((await post(base,'/test-notification-pilot/refresh',11)).status,303)
  const beforeDelete=(await (await get(base,'/api/test-notification-pilot',11)).json()).notifications
  assert.ok(beforeDelete.some(x=>x.eventId===101&&x.kind==='changed'))
  db.prepare('DELETE FROM events WHERE id=101').run()
  assert.equal((await post(base,'/test-notification-pilot/refresh',11)).status,303)
  const for7=(await (await get(base,'/api/test-notification-pilot',11)).json()).notifications
  const for9=(await (await get(base,'/api/test-notification-pilot',12)).json()).notifications
  assert.deepEqual(for7.filter(x=>x.eventId===101).map(x=>x.kind),['cancelled'])
  assert.deepEqual(for9.filter(x=>x.eventId===101).map(x=>x.kind),['cancelled'])
  assert.ok(for7.some(x=>x.eventId===102&&x.kind==='assigned'))
  assert.equal(db.prepare([
    'SELECT COUNT(*) AS n FROM assignment_notification_outbox',
    'WHERE event_id=101 AND person_id=7',
  ].join(' ')).get().n,3,'assigned, changed and cancelled history must be kept')
  assert.equal(db.prepare([
    'SELECT COUNT(*) AS n FROM test_assignment_acknowledgements WHERE notification_id=?',
  ].join(' ')).get(oldAssignment.id).n,1,'do not rewrite past acknowledgement')
  const cancelled=for7.find(x=>x.eventId===101)
  assert.ok(cancelled.cancelledEvent?.title==='Updated appointment')
  assert.equal((await post(base,
    '/api/test-notification-pilot/'+cancelled.id+'/acknowledge',11)).status,200)
  const after=(await (await get(base,'/api/test-notification-pilot',11)).json()).notifications
  assert.deepEqual(after.filter(x=>x.eventId===101).map(x=>[x.kind,x.acknowledged]),
    [['cancelled',true]],'older pending notices must not resurface after acknowledgement')
  // If an ID is reused for a new event, its later assignment is not suppressed.
  createEvent(db,101,[7])
  assert.equal((await post(base,'/test-notification-pilot/refresh',11)).status,303)
  const reused=(await (await get(base,'/api/test-notification-pilot',11)).json()).notifications
  assert.deepEqual(reused.filter(x=>x.eventId===101).map(x=>x.kind),
    ['assigned','cancelled'])
})

test('TEST cancellation suppresses prior notices only for its recipient',async t=>{
  const db=makeDb(t),app=setupApp(db)
  pilot(app,db)
  const base=await withServer(t,app)
  createEvent(db,110,[7,9])
  assert.equal((await post(base,'/test-notification-pilot/refresh',11)).status,303)
  db.prepare('DELETE FROM event_people WHERE event_id=110 AND person_id=9').run()
  assert.equal((await post(base,'/test-notification-pilot/refresh',11)).status,303)
  db.prepare('DELETE FROM events WHERE id=110').run()
  assert.equal((await post(base,'/test-notification-pilot/refresh',11)).status,303)
  const for7=(await (await get(base,'/api/test-notification-pilot',11)).json()).notifications
  const for9=(await (await get(base,'/api/test-notification-pilot',12)).json()).notifications
  assert.deepEqual(for7.map(x=>x.kind),['cancelled'])
  assert.deepEqual(for9.map(x=>x.kind),['unassigned','assigned'])
  assert.equal((await get(base,'/api/test-notification-pilot',13)).status,403)
})
