import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHouseholdMembershipTables, registerHousehold, grantHouseholdMembership } from '../Server/household-memberships.mjs'
import { setFamilyAccount } from '../Server/family-auth.mjs'
import { createEventShareTables } from '../Server/event-only-shares.mjs'
import { listPrivateArneyCalendar, validatePrivateArneyLookupRange } from '../Server/private-arney-calendar-lookup.mjs'

function fixture(t) {
  const central = new DatabaseSync(':memory:')
  const a = new DatabaseSync(':memory:')
  const b = new DatabaseSync(':memory:')
  t.after(() => { central.close(); a.close(); b.close() })
  createHouseholdMembershipTables(central)
  createEventShareTables(central)
  setFamilyAccount(central, 'testadmina', 'Family A owner', 'Disposable-Only-Long-Password-123!')
  setFamilyAccount(central, 'testadminb', 'Family B owner', 'Disposable-Only-Long-Password-456!')
  registerHousehold(central, { householdId:'family-a', displayName:'Family A' })
  registerHousehold(central, { householdId:'family-b', displayName:'Family B' })
  const aUser = central.prepare("SELECT id FROM family_users WHERE username='testadmina'").get().id
  const bUser = central.prepare("SELECT id FROM family_users WHERE username='testadminb'").get().id
  grantHouseholdMembership(central, { serverVerifiedUserId:aUser, householdId:'family-a', role:'owner' })
  grantHouseholdMembership(central, { serverVerifiedUserId:bUser, householdId:'family-b', role:'owner' })
  for (const db of [a,b]) db.exec([
    'CREATE TABLE events (',
    'id INTEGER PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL,',
    'end_date TEXT, time TEXT, end_time TEXT, notes TEXT, location TEXT,',
    'person TEXT, repeat_unit TEXT)',
  ].join(' '))
  a.prepare('INSERT INTO events(id,title,date,end_date,time,notes,location,person) VALUES (1,?,?,?,?,?,?,?)')
    .run('Family A event','2026-12-20','2026-12-22','09:00','A SECRET NOTE','HOME ADDRESS','Private person')
  b.prepare('INSERT INTO events(id,title,date,time,notes) VALUES (1,?,?,?,?)')
    .run('Family B event','2026-12-21','15:00','B SECRET NOTE')
  return { central, a, b, aUser, bUser }
}
const query = (f, id, fromDate = '2026-12-20', toDate = '2026-12-24') =>
  listPrivateArneyCalendar({
    identityDatabase:f.central,
    sourceDatabase:id==='family-a'?f.a:f.b,
    serverVerifiedUserId:id==='family-a'?f.aUser:f.bUser,
    householdId:id, fromDate, toDate,
  })

test('Arney only reads selected household and allowlisted safe fields, including multiday overlaps', t => {
  const f=fixture(t)
  const a=query(f,'family-a', '2026-12-21','2026-12-22')
  assert.equal(a.readOnly,true)
  assert.equal(a.scope,'selected_household')
  assert.deepEqual(a.events,[{
    source:'household',eventId:1,title:'Family A event',date:'2026-12-20',
    endDate:'2026-12-22',time:'09:00',endTime:null,
  }])
  assert.doesNotMatch(JSON.stringify(a),/SECRET|ADDRESS|person|Family B event/)
  const b=query(f,'family-b')
  assert.deepEqual(b.events.map(e=>e.title),['Family B event'])
  assert.doesNotMatch(JSON.stringify(b),/A event|SECRET/)
})

test('Arney shows only explicitly accepted shares, never a pending, declined or revoked invitation', t => {
  const f=fixture(t)
  const from=f.central.prepare("SELECT id FROM household_registry WHERE storage_id='family-a'").get().id
  const to=f.central.prepare("SELECT id FROM household_registry WHERE storage_id='family-b'").get().id
  const insert=f.central.prepare([
    'INSERT INTO event_share_grants',
    '(source_household_id,recipient_household_id,source_event_id,source_event_uid,',
    'created_by_user_id,status,title,date,time,created_at,updated_at)',
    'VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  ].join(' '))
  const add=(state,title)=>insert.run(from,to,1,'11223344556677889900aabbccddeeff',
    f.aUser,state,title,'2026-12-20','09:00',1,1)
  const accepted=Number(add('accepted','Approved share').lastInsertRowid)
  add('declined','Private declined')
  add('revoked','Private revoked')
  add('pending','Private pending')
  const b=query(f,'family-b')
  assert.deepEqual(b.events.map(e=>e.title),['Approved share','Family B event'])
  assert.equal(b.events[0].shareId,accepted)
  assert.equal(b.events[0].sharedBy,'Family A')
  assert.equal(b.events[0].source,'accepted_invitation')
  assert.doesNotMatch(JSON.stringify(b),/Private declined|Private revoked|Private pending|sourceEventId/)
  f.central.prepare("UPDATE event_share_grants SET status='removed' WHERE id=?").run(accepted)
  assert.deepEqual(query(f,'family-b').events.map(e=>e.title),['Family B event'])
})

test('strict Gregorian UTC date range validation and maximum 31 days', () => {
  assert.deepEqual(validatePrivateArneyLookupRange('2026-10-01','2026-10-31'),
    {fromDate:'2026-10-01',toDate:'2026-10-31'})
  for(const [from,to] of [
    ['2026-02-30','2026-03-01'],['2026-01-01','2026-02-01'],
    ['2026-12-24','2026-12-20'],['2026-9-1','2026-09-02'],
    ['2026-01-01','2026-01-00'],[null,'2026-01-01'],
  ]) assert.throws(()=>validatePrivateArneyLookupRange(from,to),/Arney/)
})

test('recurring series are never silently represented as single-event schedule', t => {
  const f=fixture(t)
  f.a.prepare('INSERT INTO events(id,title,date,repeat_unit) VALUES (?,?,?,?)')
    .run(2,'Weekly repeating event','2026-12-18','week')
  const result=query(f,'family-a')
  assert.equal(result.recurringSeriesNotExpanded,true)
  assert.deepEqual(result.events.map(e=>e.title),['Family A event'])
})

test('oversized results and revoked memberships fail closed', t => {
  const f=fixture(t)
  const insert=f.a.prepare('INSERT INTO events(id,title,date) VALUES (?,?,?)')
  for (let i=2;i<=51;i++) insert.run(i,'Extra event '+i,'2026-12-23')
  assert.throws(()=>query(f,'family-a'),/result limit/)
  f.central.prepare([
    'UPDATE household_memberships SET disabled=1 WHERE user_id=?',
    "AND household_id=(SELECT id FROM household_registry WHERE storage_id='family-b')",
  ].join(' ')).run(f.bUser)
  assert.throws(()=>query(f,'family-b'),/membership/)
})
