import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  planEventAssignmentNotifications, installAssignmentNotificationOutbox,
  queueEventAssignmentNotifications, pendingAssignmentNotifications,
  acknowledgeAssignmentNotification,
} from '../Server/event-assignment-notifications.mjs'

const make = (personIds, extras = {}) => ({
  id: 21, title: 'Checkup', date: '2027-02-01', time: '08:00',
  personIds, ...extras,
})
const intents = (changes) => changes.map(({ personId, kind, eventId }) =>
  ({ personId, kind, eventId }))

test('new event addresses only assigned people; duplicates are removed', () => {
  assert.deepEqual(planEventAssignmentNotifications(null, make([3, 1, 3])), [
    { eventId: 21, personId: 1, kind: 'assigned' },
    { eventId: 21, personId: 3, kind: 'assigned' },
  ])
  assert.deepEqual(planEventAssignmentNotifications(null, make([])), [])
})

test('editing assignments notifies new, removed, and unaffected recipients correctly', () => {
  const before = make([1, 2])
  const after = make([2, 3])
  assert.deepEqual(planEventAssignmentNotifications(before, after), [
    { eventId: 21, personId: 1, kind: 'unassigned' },
    { eventId: 21, personId: 3, kind: 'assigned' },
  ])
})

test('event rescheduling notifies only current assignees', () => {
  assert.deepEqual(planEventAssignmentNotifications(
    make([2, 4]), make([2, 4], { date: '2027-02-02' })
  ), [
    { eventId: 21, personId: 2, kind: 'changed' },
    { eventId: 21, personId: 4, kind: 'changed' },
  ])
})

test('simultaneously changing time and members uses correct precedence', () => {
  const changed = planEventAssignmentNotifications(
    make([5, 2]), make([5, 9], { time: '10:00' })
  )
  assert.deepEqual(changed, [
    { eventId: 21, personId: 2, kind: 'unassigned' },
    { eventId: 21, personId: 5, kind: 'changed' },
    { eventId: 21, personId: 9, kind: 'assigned' },
  ])
})

test('deletion cancels only former assignees, not every household device', () => {
  assert.deepEqual(planEventAssignmentNotifications(make([9, 1]), null), [
    { eventId: 21, personId: 1, kind: 'cancelled' },
    { eventId: 21, personId: 9, kind: 'cancelled' },
  ])
})

test('no-op edits and recipient order changes do not generate messages', () => {
  assert.deepEqual(planEventAssignmentNotifications(make([5, 2]), make([2, 5])), [])
  assert.deepEqual(planEventAssignmentNotifications(make([]), make([])), [])
})

test('invalid event identities or wrong recipient types are rejected', () => {
  assert.throws(() => planEventAssignmentNotifications(null, null), /transition/)
  assert.throws(() => planEventAssignmentNotifications(make([1]), { ...make([1]), id: 22 }), /unrelated/)
  assert.throws(() => planEventAssignmentNotifications(null, make(['1'])), /person ID/)
  assert.throws(() => planEventAssignmentNotifications(null, make([0])), /person ID/)
  assert.throws(() => planEventAssignmentNotifications(null, { title: 'No ID', personIds: [1] }), /identity/)
})

test('outbox saves metadata only, records acks once and leaves other recipients pending', t => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  installAssignmentNotificationOutbox(database)
  installAssignmentNotificationOutbox(database)
  assert.equal(queueEventAssignmentNotifications(database, null, make([1, 2]), 10), 2)
  const pending = pendingAssignmentNotifications(database)
  assert.equal(pending.length, 2)
  assert.deepEqual(intents(pending), [
    { eventId: 21, personId: 1, kind: 'assigned' },
    { eventId: 21, personId: 2, kind: 'assigned' },
  ])
  assert.equal(JSON.stringify(pending).includes('Checkup'), false)
  assert.equal(acknowledgeAssignmentNotification(database, pending[0].id, 11), true)
  assert.equal(acknowledgeAssignmentNotification(database, pending[0].id, 11), false)
  assert.equal(pendingAssignmentNotifications(database).length, 1)
  assert.throws(() => pendingAssignmentNotifications(database, 0), /batch size/)
})

test('outbox entries roll back with failed event transaction; no phantom delivery', t => {
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  database.exec('CREATE TABLE events(id INTEGER PRIMARY KEY, title TEXT) STRICT')
  installAssignmentNotificationOutbox(database)
  database.exec('BEGIN')
  database.prepare('INSERT INTO events(id,title) VALUES (?,?)').run(21, 'Checkup')
  queueEventAssignmentNotifications(database, null, make([2]), 12)
  assert.equal(pendingAssignmentNotifications(database).length, 1)
  database.exec('ROLLBACK')
  assert.equal(pendingAssignmentNotifications(database).length, 0)
  assert.equal(database.prepare('SELECT count(*) AS n FROM events').get().n, 0)
})
