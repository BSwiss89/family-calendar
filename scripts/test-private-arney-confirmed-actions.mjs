import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { installPrivateEventIdentity } from '../Server/private-event-identity.mjs'
import { installPrivateEventSourceOutbox, countPrivateSourcePending } from '../Server/private-event-source-outbox.mjs'
import { previewPrivateArneyAction, confirmPrivateArneyAction } from '../Server/private-arney-confirmed-actions.mjs'

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec([
    'PRAGMA foreign_keys=ON;',
    'CREATE TABLE events (id INTEGER PRIMARY KEY, date TEXT, title TEXT,',
    'time TEXT, end_date TEXT, end_time TEXT, repeat_unit TEXT, notes TEXT);',
    'CREATE TABLE event_people (event_id INTEGER, person_id INTEGER);',
    "INSERT INTO events(id,date,title,time,notes) VALUES",
    "(1,'2026-12-20','Private family appointment','12:00','HIDDEN PRIVATE NOTE');",
  ].join(' '))
  installPrivateEventIdentity(db)
  installPrivateEventSourceOutbox(db)
  // Ignore initial fixture's insert backfill if any; later changes must queue.
  const tokenKey = randomBytes(32)
  const actor = { sourceDb: db, tokenKey, verifiedUserId: 10,
    verifiedSessionId: 22, householdId: 'family-a' }
  const preview = (request, now = 1000000) =>
    previewPrivateArneyAction({ ...actor, request, now })
  const confirm = (request, opts = {}) =>
    confirmPrivateArneyAction({ ...actor, request,
      now: opts.now ?? 1000001,
      beforeWrite: opts.beforeWrite ?? (() => {}),
    })
  return { db, tokenKey, actor, preview, confirm }
}
test('explicit preview and confirmed reschedule preserve notes/UID and queue a source update', t => {
  const f=fixture(t)
  const old=f.db.prepare('SELECT event_uid uid FROM events WHERE id=1').get().uid
  const proposed=f.preview({action:'reschedule',eventId:1,newDate:'2026-12-23',newTime:'15:30'})
  assert.equal(proposed.requiresConfirmation,true)
  assert.deepEqual(proposed.current, {title:'Private family appointment',date:'2026-12-20',time:'12:00'})
  assert.doesNotMatch(JSON.stringify(proposed),/HIDDEN PRIVATE NOTE/)
  assert.deepEqual(proposed.proposed,{date:'2026-12-23',time:'15:30'})
  const before=countPrivateSourcePending(f.db)
  let journal=0
  assert.deepEqual(f.confirm({previewToken:proposed.previewToken,confirm:true},
    {beforeWrite:({sourceEventId})=>{assert.equal(sourceEventId,1);journal++}}),
    {success:true,action:'reschedule',eventId:1})
  assert.equal(journal,1)
  const changed=f.db.prepare('SELECT date,time,notes,event_uid uid FROM events WHERE id=1').get()
  assert.equal(changed.date,'2026-12-23')
  assert.equal(changed.time,'15:30')
  assert.equal(changed.notes,'HIDDEN PRIVATE NOTE')
  assert.equal(changed.uid,old)
  assert.equal(countPrivateSourcePending(f.db),before+1)
  assert.throws(()=>f.confirm({previewToken:proposed.previewToken,confirm:true}), /Review|changed|available/)
})
test('single-event cancellation is previewed, explicit, and cannot delete a replacement numeric ID', t => {
  const f=fixture(t)
  const p=f.preview({action:'cancel',eventId:1})
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM events').get().n,1)
  assert.deepEqual(f.confirm({previewToken:p.previewToken,confirm:true}),
    {success:true,action:'cancel',eventId:1})
  f.db.prepare('INSERT INTO events(id,date,title) VALUES (1,?,?)')
    .run('2026-12-21','New unrelated event')
  assert.throws(()=>f.confirm({previewToken:p.previewToken,confirm:true}), /changed|available/)
  assert.equal(f.db.prepare('SELECT title FROM events WHERE id=1').get().title,'New unrelated event')
})
test('stale preview, person-link edits, token tampering, session/household switch, and expiry fail closed', t => {
  const f=fixture(t)
  const p=f.preview({action:'reschedule',eventId:1,newDate:'2026-12-22'})
  f.db.prepare('UPDATE events SET notes=? WHERE id=1').run('changed after preview')
  assert.throws(()=>f.confirm({previewToken:p.previewToken,confirm:true}),/changed/)
  assert.equal(f.db.prepare('SELECT date FROM events WHERE id=1').get().date,'2026-12-20')
  const next=f.preview({action:'cancel',eventId:1})
  f.db.prepare('INSERT INTO event_people(event_id,person_id) VALUES (1,2)').run()
  assert.throws(()=>f.confirm({previewToken:next.previewToken,confirm:true}),/changed/)
  assert.throws(()=>f.confirm({previewToken:p.previewToken+'x',confirm:true}),/valid/)
  assert.throws(()=>f.confirm({previewToken:p.previewToken,confirm:false}),/confirmation/)
  assert.throws(()=>confirmPrivateArneyAction({
    ...f.actor, householdId:'family-b', request:{previewToken:p.previewToken,confirm:true},
    beforeWrite:()=>{},now:1000001,
  }),/household/)
  assert.throws(()=>confirmPrivateArneyAction({
    ...f.actor,verifiedSessionId:23, request:{previewToken:p.previewToken,confirm:true},
    beforeWrite:()=>{},now:1000001,
  }),/household/)
  assert.throws(()=>f.confirm({previewToken:p.previewToken,confirm:true},{now:1000000+5*60*1000+1}),/expired/)
})
test('untrusted/unsupported payloads are rejected before writes', t => {
  const f=fixture(t)
  const bad=[
    {action:'cancel',eventId:1,newDate:'2026-12-23'},
    {action:'cancel',eventId:'1'},
    {action:'reschedule',eventId:1},
    {action:'reschedule',eventId:1,newDate:'2026-02-30'},
    {action:'reschedule',eventId:1,newDate:'2026-13-10'},
    {action:'reschedule',eventId:1,newTime:'25:00'},
    {action:'reschedule',eventId:1,newDate:'2026-12-20'},
    {action:'reschedule',eventId:1,newTime:'12:00'},
    {action:'cancel',eventId:1,householdId:'family-b'},
  ]
  for(const request of bad)
    assert.throws(()=>f.preview(request),/Invalid|would not change/)
  f.db.prepare('UPDATE events SET repeat_unit=? WHERE id=1').run('week')
  assert.throws(()=>f.preview({action:'cancel',eventId:1}),/Recurring/)
  f.db.prepare('UPDATE events SET repeat_unit=NULL,end_date=? WHERE id=1').run('2026-12-21')
  assert.throws(()=>f.preview({action:'reschedule',eventId:1,newDate:'2026-12-23'}),/multi-day/)
})
test('journal failure rolls back a pending source write and causes no outbox change', t => {
  const f=fixture(t)
  const p=f.preview({action:'cancel',eventId:1})
  const pending=countPrivateSourcePending(f.db)
  assert.throws(()=>f.confirm({previewToken:p.previewToken,confirm:true},
    {beforeWrite:()=>{throw Error('central SQLite unavailable')}}),/central SQLite/)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM events').get().n,1)
  assert.equal(countPrivateSourcePending(f.db),pending)
})
