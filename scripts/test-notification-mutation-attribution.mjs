import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  installAssignmentNotificationOutbox,
} from '../Server/event-assignment-notifications.mjs'
import {
  installNotificationMutationCapture, reconcileNotificationMutations,
} from '../Server/notification-event-mutation-capture.mjs'
import {
  applyAttributedEventMutation, attributeNewEvent, captureEventMutationAttribution,
} from '../Server/notification-mutation-attribution.mjs'

const human = sessionId => ({
  familyAccount: {id:sessionId,user_id:1},
  // No request-body actor can override the authenticated session.
  body: {actorPersonId:999,creatorPersonId:999},
})
const owner = human(11), other = human(12), home = human(13)
const exp = Date.now()+86_400_000

function setup(t, {preExisting=false, pilot=true}={}) {
  const db=new DatabaseSync(':memory:')
  t.after(()=>db.close())
  db.exec([
    'PRAGMA foreign_keys=ON;',
    'CREATE TABLE family_users(id INTEGER PRIMARY KEY,disabled INTEGER NOT NULL DEFAULT 0) STRICT;',
    'CREATE TABLE family_sessions(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,',
    'selected_profile_kind TEXT,selected_person_id INTEGER,revoked_at INTEGER,expires_at INTEGER) STRICT;',
    'CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT) STRICT;',
    'CREATE TABLE events(id INTEGER PRIMARY KEY,date TEXT,title TEXT,end_date TEXT,',
    'time TEXT,end_time TEXT,notes TEXT,location TEXT,repeat_unit TEXT,',
    'repeat_interval INTEGER,repeat_end_type TEXT,repeat_end_date TEXT,repeat_count INTEGER) STRICT;',
    'CREATE TABLE event_people(event_id INTEGER,person_id INTEGER,',
    'PRIMARY KEY(event_id,person_id),',
    'FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE) STRICT;',
    'CREATE TABLE event_exceptions(event_id INTEGER,occurrence_date TEXT,',
    'PRIMARY KEY(event_id,occurrence_date),',
    'FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE) STRICT;',
    "INSERT INTO family_users(id,disabled) VALUES(1,0);",
    "INSERT INTO people VALUES(7,'Creator'),(9,'Other'),(10,'Third');",
  ].join('\n'))
  const ins=db.prepare('INSERT INTO family_sessions VALUES(?,?,?,?,?,?)')
  ins.run(11,1,'person',7,null,exp)
  ins.run(12,1,'person',9,null,exp)
  ins.run(13,1,'home',null,null,exp)
  if(preExisting) create(db,1,[7,9])
  if(pilot) {
    installAssignmentNotificationOutbox(db)
    installNotificationMutationCapture(db)
  }
  return db
}
function create(db,id,people=[7,9]) {
  db.prepare('INSERT INTO events(id,date,title) VALUES (?,?,?)')
    .run(id,'2027-05-01','Family event')
  for(const person of people) db.prepare(
    'INSERT INTO event_people(event_id,person_id) VALUES (?,?)'
  ).run(id,person)
}
function createdBy(db,request,id,people=[7,9]) {
  db.exec('BEGIN IMMEDIATE')
  try {
    create(db,id,people)
    attributeNewEvent(db,request,id)
    db.exec('COMMIT')
  } catch(error) {db.exec('ROLLBACK');throw error}
}
function change(db,request,id,title) {
  return applyAttributedEventMutation(db,request,[id],()=>
    db.prepare('UPDATE events SET title=? WHERE id=?').run(title,id)
  )
}
function reconcile(db) {
  const result=reconcileNotificationMutations(db,{at:Date.now()})
  assert.equal(result.remaining,0)
  return result
}
function notices(db) {
  return db.prepare([
    'SELECT event_id AS eventId,person_id AS personId,kind',
    'FROM assignment_notification_outbox ORDER BY id',
  ].join(' ')).all().map(row => ({
    eventId: row.eventId, personId: row.personId, kind: row.kind,
  }))
}
const notice=(eventId,personId,kind)=>({eventId,personId,kind})

test('pilot-disabled: no attribution migration and normal event creation remains possible',t=>{
  const db=setup(t,{pilot:false})
  createdBy(db,owner,2)
  assert.equal(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE name='notification_dirty_event_attribution'"
  ).get(),undefined)
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n,1)
})

test('creator does not acknowledge their own new event; other assignee still notified',t=>{
  const db=setup(t)
  createdBy(db,owner,2)
  assert.equal(reconcile(db).queued,1)
  assert.deepEqual(notices(db),[notice(2,9,'assigned')])
  assert.deepEqual(db.prepare('SELECT * FROM notification_dirty_event_attribution').all(),[])
  assert.equal(reconcile(db).queued,0)
  assert.equal(notices(db).length,1)
})

test('self-only new event produces no acknowledgement; no stale notice on refresh',t=>{
  const db=setup(t)
  createdBy(db,owner,3,[7])
  assert.equal(reconcile(db).queued,0)
  assert.deepEqual(notices(db),[])
  assert.equal(reconcile(db).queued,0)
})

test('creator edit excludes self; another profile editing next notifies creator',t=>{
  const db=setup(t,{preExisting:true})
  change(db,owner,1,'Edited by creator')
  assert.equal(reconcile(db).queued,1)
  assert.deepEqual(notices(db),[notice(1,9,'changed')])
  change(db,other,1,'Edited by another person')
  assert.equal(reconcile(db).queued,1)
  assert.deepEqual(notices(db),[
    notice(1,9,'changed'),notice(1,7,'changed'),
  ])
})

test('multiple edits by same actor before reconciliation suppress only that actor',t=>{
  const db=setup(t,{preExisting:true})
  change(db,owner,1,'First')
  change(db,owner,1,'Second')
  assert.equal(reconcile(db).queued,1)
  assert.deepEqual(notices(db),[notice(1,9,'changed')])
})

test('mixed actors before reconciliation never hide other person changes',t=>{
  const db=setup(t,{preExisting:true})
  change(db,owner,1,'First')
  change(db,other,1,'Second')
  assert.equal(reconcile(db).queued,2)
  assert.deepEqual(notices(db),[
    notice(1,7,'changed'),notice(1,9,'changed'),
  ])
})

test('direct SQL mutations and unknown earlier revisions fail open for recipients',t=>{
  const db=setup(t,{preExisting:true})
  change(db,owner,1,'Owner')
  db.prepare("UPDATE events SET title='Unattributed update' WHERE id=1").run()
  assert.equal(reconcile(db).queued,2)
  assert.deepEqual(notices(db),[
    notice(1,7,'changed'),notice(1,9,'changed'),
  ])
  db.prepare("UPDATE events SET title='Direct SQL' WHERE id=1").run()
  change(db,owner,1,'Owner again')
  assert.equal(reconcile(db).queued,2)
})

test('Home, missing login, spoofed profile ID and revoked session never suppress',t=>{
  const db=setup(t,{preExisting:true})
  const run=(req,label)=>{
    change(db,req,1,label)
    assert.equal(reconcile(db).queued,2)
  }
  run(home,'Home edited')
  run({familyAccount:null,body:{personId:7}},'No auth')
  db.prepare('UPDATE family_sessions SET revoked_at=? WHERE id=11').run(Date.now())
  run(owner,'Revoked auth')
  assert.equal(notices(db).length,6)
})

test('reassignment notifies the newly assigned person, not person removing themselves',t=>{
  const db=setup(t,{preExisting:true})
  applyAttributedEventMutation(db,owner,[1],()=>{
    db.prepare('DELETE FROM event_people WHERE event_id=1 AND person_id=7').run()
    db.prepare('INSERT INTO event_people VALUES(1,10)').run()
  })
  assert.equal(reconcile(db).queued,1)
  assert.deepEqual(notices(db),[notice(1,10,'assigned')])
})

test('recurring occurrence exceptions are attributed; no-op and reversal do not notify',t=>{
  const db=setup(t,{preExisting:true})
  db.prepare("UPDATE events SET repeat_unit='weekly', repeat_interval=1 WHERE id=1").run()
  reconcile(db) // pre-test setup change, not actor-attributed
  db.prepare('DELETE FROM assignment_notification_outbox').run()
  applyAttributedEventMutation(db,owner,[1],()=>{
    db.prepare("INSERT INTO event_exceptions VALUES(1,'2027-05-08')").run()
  })
  assert.equal(reconcile(db).queued,1)
  assert.deepEqual(notices(db),[notice(1,9,'changed')])
  applyAttributedEventMutation(db,owner,[1],()=>{
    db.prepare("INSERT OR IGNORE INTO event_exceptions VALUES(1,'2027-05-08')").run()
  })
  assert.equal(reconcile(db).queued,0)
  applyAttributedEventMutation(db,other,[1],()=>{
    db.prepare("DELETE FROM event_exceptions WHERE event_id=1 AND occurrence_date='2027-05-08'").run()
  })
  assert.equal(reconcile(db).queued,1)
  assert.deepEqual(notices(db).at(-1),notice(1,7,'changed'))
})

test('deletion and batch deletion retain notifications for other assignees',t=>{
  const db=setup(t,{preExisting:true})
  createdBy(db,owner,2,[7,9])
  reconcile(db)
  db.prepare('DELETE FROM assignment_notification_outbox').run()
  applyAttributedEventMutation(db,owner,[1,2],()=>{
    db.prepare('DELETE FROM events WHERE id IN (1,2)').run()
  })
  assert.equal(reconcile(db).queued,2)
  assert.deepEqual(notices(db),[
    notice(1,9,'cancelled'),notice(2,9,'cancelled'),
  ])
})

test('rollback of actor-tagged event mutation rolls back its attribution and dirty revision',t=>{
  const db=setup(t,{preExisting:true})
  db.exec('BEGIN IMMEDIATE')
  const capture=captureEventMutationAttribution(db,owner,[1])
  db.prepare("UPDATE events SET title='Should roll back' WHERE id=1").run()
  capture.finish()
  db.exec('ROLLBACK')
  assert.equal(db.prepare('SELECT title FROM events WHERE id=1').get().title,'Family event')
  assert.deepEqual(db.prepare('SELECT * FROM notification_dirty_event_attribution').all(),[])
  assert.equal(reconcile(db).queued,0)
})

test('acknowledged notices and Ask Again Later are not changed by attribution',t=>{
  const db=setup(t)
  createdBy(db,owner,4,[7,9])
  reconcile(db)
  const pending=notices(db)
  assert.deepEqual(pending,[notice(4,9,'assigned')])
  // Dismissing the reminder UI temporarily leaves this pending outbox notice.
  // The attribution code never acknowledges or marks it delivered.
  assert.equal(db.prepare('SELECT delivered_at FROM assignment_notification_outbox').get().delivered_at,null)
  assert.equal(reconcile(db).queued,0)
  assert.deepEqual(notices(db),pending)
})
