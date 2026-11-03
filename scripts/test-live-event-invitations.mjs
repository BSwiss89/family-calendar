import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {installLiveEventInvitations} from '../Server/live-event-invitations.mjs'

const now=1783116000000
const account={id:10,user_id:1}
function fixture() {
  const db=new DatabaseSync(':memory:')
  db.exec([
    'PRAGMA foreign_keys=ON;',
    'CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT NOT NULL);',
    "INSERT INTO people VALUES (1,'Bobby'),(2,'Haylee'),(3,'Home Live');",
    'CREATE TABLE events(id INTEGER PRIMARY KEY,date TEXT,title TEXT,time TEXT);',
    'CREATE TABLE event_people(event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,',
    'person_id INTEGER REFERENCES people(id),PRIMARY KEY(event_id,person_id));',
    'CREATE TABLE family_users(id INTEGER PRIMARY KEY,disabled INTEGER NOT NULL DEFAULT 0);',
    'INSERT INTO family_users VALUES(1,0);',
    'CREATE TABLE family_sessions(id INTEGER PRIMARY KEY,user_id INTEGER,',
    'selected_profile_kind TEXT,selected_person_id INTEGER,revoked_at INTEGER,expires_at INTEGER);',
    "INSERT INTO family_sessions VALUES(10,1,'person',1,NULL,1783119600000);",
  ].join(' '))
  const routes={get:new Map(),post:new Map()}
  const app={
    get(path,handler){routes.get.set(path,handler)},
    post(path,handler){routes.post.set(path,handler)},
  }
  function call(method,url,body={},session=account) {
    const [path,id]=url.includes('/respond')
      ? ['/api/live-event-invitations/:id/respond',url.split('/')[3]]
      : [url,null]
    const handler=routes[method].get(path)
    assert.ok(handler,'Missing handler '+path)
    const result={status:200,data:null}
    const response={
      set(){return this},
      status(code){result.status=code;return this},
      json(value){result.data=value;return this},
    }
    handler({body,params:{id},familyAccount:session},response)
    return result
  }
  return {db,app,call}
}

const flags={flag:'enabled',port:3001,authMode:'required',
  rootFolder:'/var/test/family-calendar-live',now:()=>now}

test('Disabled pilot changes no schema or routes; LIVE path/port fail closed',()=>{
  const {app,db}=fixture()
  assert.equal(installLiveEventInvitations(app,db,{flag:'disabled'}).enabled,false)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='live_event_invitations'").get().n,0)
  for(const opts of [{port:13002},{rootFolder:'/tmp/family-calendar-test-stage'},{authMode:'disabled'}]){
    assert.throws(()=>installLiveEventInvitations(app,db,{...flags,...opts}))
  }
  db.close()
})

test('New event proposes participation to recipient, not creator; existing events remain untouched',()=>{
  const {app,db,call}=fixture()
  db.exec("INSERT INTO events VALUES (1,'2026-11-03','Old Event',NULL)")
  db.exec("INSERT INTO event_people VALUES(1,2)")
  const pilot=installLiveEventInvitations(app,db,flags)
  assert.equal(pilot.enabled,true)
  assert.equal(call('get','/api/live-event-invitations').data.invitations.length,0)

  db.exec('BEGIN')
  db.exec("INSERT INTO events VALUES (2,'2026-11-04','Family Event','18:00')")
  db.exec('INSERT INTO event_people VALUES(2,1),(2,2)')
  pilot.recordAssignments({familyAccount:account},2,[],[1,2])
  db.exec('COMMIT')
  const statuses=db.prepare('SELECT person_id AS personId,status FROM live_event_invitations WHERE event_id=2 ORDER BY person_id')
    .all().map(row=>({personId:row.personId,status:row.status}))
  assert.deepEqual(statuses,[{personId:1,status:'accepted'},{personId:2,status:'pending'}])
  assert.equal(call('get','/api/live-event-invitations').data.invitations.length,0)
  db.exec("UPDATE family_sessions SET selected_person_id=2 WHERE id=10")
  const invitations=call('get','/api/live-event-invitations').data.invitations
  assert.equal(invitations.length,1)
  assert.equal(invitations[0].title,'Family Event')
  assert.equal(invitations[0].invitedBy,'Bobby')
  assert.equal(call('get','/api/live-event-invitations',{}, {id:11,user_id:1}).status,401)
  const accepted=call('post','/api/live-event-invitations/'+invitations[0].id+'/respond',{decision:'accepted'})
  assert.equal(accepted.status,200)
  assert.equal(accepted.data.joined,true)
  assert.equal(call('get','/api/live-event-invitations').data.invitations.length,0)
  assert.ok(db.prepare('SELECT 1 FROM event_people WHERE event_id=2 AND person_id=2').get())
  assert.equal(call('post','/api/live-event-invitations/'+invitations[0].id+'/respond',{decision:'accepted'}).status,404)
  db.close()
})

test('Decline leaves assignment; Home cannot respond; editing preserves accepted decisions',()=>{
  const {app,db,call}=fixture()
  const pilot=installLiveEventInvitations(app,db,flags)
  db.exec("INSERT INTO events VALUES (3,'2026-11-04','Invite Demo',NULL)")
  db.exec('INSERT INTO event_people VALUES(3,1),(3,2)')
  pilot.recordAssignments({familyAccount:account},3,[],[1,2])
  db.exec("UPDATE family_sessions SET selected_person_id=2 WHERE id=10")
  const id=call('get','/api/live-event-invitations').data.invitations[0].id
  db.exec("UPDATE family_sessions SET selected_profile_kind='home',selected_person_id=NULL WHERE id=10")
  assert.equal(call('get','/api/live-event-invitations').status,403)
  assert.equal(call('post','/api/live-event-invitations/'+id+'/respond',{decision:'declined'}).status,403)
  db.exec("UPDATE family_sessions SET selected_profile_kind='person',selected_person_id=2 WHERE id=10")
  assert.equal(call('post','/api/live-event-invitations/'+id+'/respond',{decision:'declined'}).data.joined,false)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM event_people WHERE event_id=3 AND person_id=2').get().n,0)
  assert.equal(db.prepare('SELECT status FROM live_event_invitations WHERE id=?').get(id).status,'declined')
  db.exec('INSERT INTO event_people VALUES(3,2)')
  pilot.recordAssignments({familyAccount:account},3,[1],[1,2])
  assert.equal(db.prepare('SELECT status FROM live_event_invitations WHERE id=?').get(id).status,'accepted')
  // Now a new edit that keeps both people preserves current accepted statuses.
  pilot.recordAssignments({familyAccount:account},3,[1,2],[1,2])
  assert.equal(db.prepare('SELECT status FROM live_event_invitations WHERE id=?').get(id).status,'accepted')
  db.exec('UPDATE family_sessions SET revoked_at=? WHERE id=10'.replace('?',String(now)))
  assert.equal(call('get','/api/live-event-invitations').status,401)
  db.close()
})
