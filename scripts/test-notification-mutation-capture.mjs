import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  installAssignmentNotificationOutbox, pendingAssignmentNotifications,
} from '../Server/event-assignment-notifications.mjs'
import {
  installNotificationMutationCapture, reconcileNotificationMutations,
} from '../Server/notification-event-mutation-capture.mjs'

function schema(db) {
  db.exec([
    'PRAGMA foreign_keys = ON;',
    'CREATE TABLE events (id INTEGER PRIMARY KEY,date TEXT,title TEXT,',
    'end_date TEXT,time TEXT,end_time TEXT,notes TEXT,location TEXT,',
    'repeat_unit TEXT,repeat_interval INTEGER,repeat_end_type TEXT,',
    'repeat_end_date TEXT,repeat_count INTEGER) STRICT;',
    'CREATE TABLE event_people(event_id INTEGER NOT NULL,person_id INTEGER NOT NULL,',
    'PRIMARY KEY(event_id,person_id),',
    'FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE) STRICT;',
    'CREATE TABLE event_exceptions(event_id INTEGER NOT NULL,occurrence_date TEXT NOT NULL,',
    'PRIMARY KEY(event_id,occurrence_date),',
    'FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE) STRICT;',
  ].join('\n'))
}
function event(db, id=21, people=[7], title='Appointment') {
  db.prepare('INSERT INTO events(id,title,date) VALUES(?,?,?)')
    .run(id,title,'2027-02-03')
  for(const p of people) db.prepare(
    'INSERT INTO event_people(event_id,person_id) VALUES(?,?)'
  ).run(id,p)
}
function fixture(t, existing=[]) {
  const db=new DatabaseSync(':memory:')
  t.after(()=>db.close())
  schema(db)
  for(const args of existing) event(db,...args)
  installAssignmentNotificationOutbox(db)
  installNotificationMutationCapture(db)
  return db
}
const pending=db=>pendingAssignmentNotifications(db).map(x=>({
  eventId:x.eventId,personId:x.personId,kind:x.kind,
}))
const reconcile=(db,options={})=>reconcileNotificationMutations(db,{at:101,...options})
const dirty=db=>db.prepare('SELECT COUNT(*) AS n FROM notification_dirty_events').get().n

test('brand-new SQL event plus multiple assignments queues exactly one intent per person',t=>{
  const db=fixture(t)
  db.exec('BEGIN IMMEDIATE')
  event(db,21,[2,7,2].filter((id,index,arr)=>arr.indexOf(id)===index))
  db.exec('COMMIT')
  assert.equal(dirty(db),1)
  assert.deepEqual(reconcile(db),{processed:1,queued:2,remaining:0})
  assert.deepEqual(pending(db),[
    {eventId:21,personId:2,kind:'assigned'},
    {eventId:21,personId:7,kind:'assigned'},
  ])
  assert.deepEqual(reconcile(db),{processed:0,queued:0,remaining:0})
  assert.equal(pending(db).length,2)
})

test('existing calendar data is baselined without alerting; direct AI-style edits notify',t=>{
  const db=fixture(t,[[21,[1,2]]])
  assert.equal(dirty(db),0)
  assert.equal(pending(db).length,0)
  db.prepare('UPDATE events SET date=? WHERE id=?').run('2027-02-04',21)
  assert.deepEqual(reconcile(db),{processed:1,queued:2,remaining:0})
  assert.deepEqual(pending(db),[
    {eventId:21,personId:1,kind:'changed'},
    {eventId:21,personId:2,kind:'changed'},
  ])
  // A SQL no-op update may mark dirty but cannot generate a user notification.
  db.prepare('UPDATE events SET title=title WHERE id=21').run()
  assert.deepEqual(reconcile(db),{processed:1,queued:0,remaining:0})
})

test('event_people directly changed by SQL sends removed/new, not uninvolved people',t=>{
  const db=fixture(t,[[21,[1,2]]])
  db.prepare('DELETE FROM event_people WHERE event_id=21 AND person_id=2').run()
  db.prepare('INSERT INTO event_people(event_id,person_id) VALUES(21,3)').run()
  assert.deepEqual(reconcile(db),{processed:1,queued:2,remaining:0})
  assert.deepEqual(pending(db),[
    {eventId:21,personId:2,kind:'unassigned'},
    {eventId:21,personId:3,kind:'assigned'},
  ])
})

test('recurring exception additions and removals capture series updates',t=>{
  const db=fixture(t,[[21,[7]]])
  db.prepare("INSERT INTO event_exceptions VALUES(21,'2027-02-10')").run()
  assert.deepEqual(reconcile(db),{processed:1,queued:1,remaining:0})
  assert.deepEqual(pending(db),[{eventId:21,personId:7,kind:'changed'}])
  db.prepare("DELETE FROM event_exceptions WHERE event_id=21 AND occurrence_date='2027-02-10'").run()
  assert.deepEqual(reconcile(db),{processed:1,queued:1,remaining:0})
  assert.equal(pending(db).length,2)
})

test('batch deletes capture each deleted assigned event despite cascaded people/exception SQL',t=>{
  const db=fixture(t,[[21,[2,7]],[22,[9]]])
  db.prepare("INSERT INTO event_exceptions VALUES(21,'2027-02-10')").run()
  reconcile(db)
  db.prepare('DELETE FROM events WHERE id IN (21,22)').run()
  assert.deepEqual(reconcile(db),{processed:2,queued:3,remaining:0})
  assert.deepEqual(pending(db).filter(x=>x.kind==='cancelled'),[
    {eventId:21,personId:2,kind:'cancelled'},
    {eventId:21,personId:7,kind:'cancelled'},
    {eventId:22,personId:9,kind:'cancelled'},
  ])
})

test('rolled back SQL create, person update and AI-style edit never leave phantom intents',t=>{
  const db=fixture(t,[[21,[7]]])
  db.exec('BEGIN IMMEDIATE')
  event(db,22,[9])
  db.prepare("UPDATE events SET date='2027-02-04' WHERE id=21").run()
  db.prepare('DELETE FROM event_people WHERE event_id=21 AND person_id=7').run()
  assert.equal(dirty(db),2)
  db.exec('ROLLBACK')
  assert.equal(dirty(db),0)
  assert.deepEqual(reconcile(db),{processed:0,queued:0,remaining:0})
  assert.equal(pending(db).length,0)
})

test('several committed event updates coalesce to final material state',t=>{
  const db=fixture(t,[[21,[7]]])
  db.prepare("UPDATE events SET title='Temporary' WHERE id=21").run()
  db.prepare("UPDATE events SET title='Appointment' WHERE id=21").run()
  assert.deepEqual(reconcile(db),{processed:1,queued:0,remaining:0})
  assert.equal(pending(db).length,0)
})

test('reconciliation transaction rolls back intents and baselines on error',t=>{
  const db=fixture(t,[[21,[7]],[22,[9]]])
  db.prepare("UPDATE events SET date='2027-03-01' WHERE id IN (21,22)").run()
  // Force a second-row malformed baseline to fail AFTER processing first row.
  db.prepare("UPDATE notification_event_baselines SET person_ids_json='bad' WHERE event_id=22").run()
  assert.throws(()=>reconcile(db),/Unexpected token|JSON/)
  assert.equal(dirty(db),2)
  assert.equal(pending(db).length,0)
  db.prepare("UPDATE notification_event_baselines SET person_ids_json='[9]' WHERE event_id=22").run()
  assert.deepEqual(reconcile(db),{processed:2,queued:2,remaining:0})
})

test('restart retains dirty SQL mutations, does not reseed over old shadow, and never double-enqueues',t=>{
  const temp=mkdtempSync(path.join(os.tmpdir(),'fc-notification-capture-'))
  t.after(()=>rmSync(temp,{recursive:true,force:true}))
  const file=path.join(temp,'calendar.db')
  let db=new DatabaseSync(file)
  schema(db)
  event(db,21,[7])
  installAssignmentNotificationOutbox(db)
  installNotificationMutationCapture(db)
  db.prepare("UPDATE events SET time='09:15' WHERE id=21").run()
  assert.equal(dirty(db),1)
  db.close()
  db=new DatabaseSync(file)
  installNotificationMutationCapture(db)
  assert.equal(dirty(db),1)
  assert.deepEqual(reconcile(db),{processed:1,queued:1,remaining:0})
  db.close()
  db=new DatabaseSync(file)
  installNotificationMutationCapture(db)
  assert.deepEqual(reconcile(db),{processed:0,queued:0,remaining:0})
  assert.deepEqual(pending(db),[{eventId:21,personId:7,kind:'changed'}])
  db.close()
})

test('failed notification insert leaves the source dirty, allowing recovery after outbox installation',t=>{
  const db=new DatabaseSync(':memory:')
  t.after(()=>db.close())
  schema(db)
  event(db,21,[7])
  installNotificationMutationCapture(db)
  db.prepare("UPDATE events SET time='11:30' WHERE id=21").run()
  assert.throws(()=>reconcile(db),/assignment_notification_outbox/)
  assert.equal(dirty(db),1)
  installAssignmentNotificationOutbox(db)
  assert.deepEqual(reconcile(db),{processed:1,queued:1,remaining:0})
})

test('delete then recreate same local event ID before reconcile yields net change, not cancellation',t=>{
  const db=fixture(t,[[21,[7]]])
  db.prepare('DELETE FROM events WHERE id=21').run()
  event(db,21,[7],'Replacement appointment')
  assert.deepEqual(reconcile(db),{processed:1,queued:1,remaining:0})
  assert.deepEqual(pending(db),[{eventId:21,personId:7,kind:'changed'}])
})

test('untrusted DB shape and invalid batch options fail closed',t=>{
  const db=new DatabaseSync(':memory:')
  t.after(()=>db.close())
  assert.throws(()=>installNotificationMutationCapture(db),/event_people/)
  schema(db)
  installNotificationMutationCapture(db)
  assert.throws(()=>reconcile(db,{limit:0}),/options/)
  assert.throws(()=>reconcile(db,{at:0}),/options/)
})
