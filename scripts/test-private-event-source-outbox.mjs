import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  installPrivateEventSourceOutbox, pendingPrivateSourceEvents,
  countPrivateSourcePending, drainPrivateSourceOutbox,
} from '../Server/private-event-source-outbox.mjs'
import { installPrivateEventIdentity } from '../Server/private-event-identity.mjs'

function source(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec([
    'CREATE TABLE events(',
    'id INTEGER PRIMARY KEY, title TEXT, date TEXT,',
    'end_date TEXT, time TEXT, end_time TEXT, repeat_unit TEXT) STRICT;',
  ].join(' '))
  installPrivateEventIdentity(db)
  installPrivateEventSourceOutbox(db)
  return db
}

test('source triggers persist insert, AI-style update and batch delete in same SQLite transaction', t => {
  const db = source(t)
  db.prepare('INSERT INTO events(title,date) VALUES(?,?)')
    .run('Original event', '2027-01-01')
  db.prepare('INSERT INTO events(title,date) VALUES(?,?)')
    .run('Other private event', '2027-01-01')
  assert.equal(countPrivateSourcePending(db), 2)
  const first = pendingPrivateSourceEvents(db).find(x => x.sourceEventId === 1)
  db.prepare('UPDATE events SET title=?,date=? WHERE id=?')
    .run('AI rescheduled', '2027-01-02', 1)
  assert.ok(pendingPrivateSourceEvents(db)
    .find(x => x.sourceEventId === 1).revision > first.revision)
  db.prepare('DELETE FROM events WHERE id IN (?,?)').run(1, 2)
  assert.deepEqual(pendingPrivateSourceEvents(db).map(x => x.sourceEventId), [1,2])
  const delivered = []
  const result = drainPrivateSourceOutbox(db, {
    apply: ({ sourceEventId }) => delivered.push(sourceEventId),
  })
  assert.deepEqual(delivered, [1,2])
  assert.deepEqual(result, { applied: 2, acknowledged: 2, remaining: 0 })
})

test('rolled-back backend event mutation cannot leave a phantom source sync intent', t => {
  const db = source(t)
  db.exec('BEGIN IMMEDIATE')
  db.prepare('INSERT INTO events(title,date) VALUES(?,?)').run('Aborted', '2027-01-01')
  assert.equal(countPrivateSourcePending(db), 1)
  db.exec('ROLLBACK')
  assert.equal(countPrivateSourcePending(db), 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0)
  db.prepare('INSERT INTO events(title,date) VALUES(?,?)').run('Saved', '2027-01-02')
  drainPrivateSourceOutbox(db, { apply: () => {} })
  assert.equal(countPrivateSourcePending(db), 0)
  db.exec('BEGIN IMMEDIATE')
  db.prepare('DELETE FROM events WHERE id=1').run()
  assert.equal(countPrivateSourcePending(db), 1)
  db.exec('ROLLBACK')
  assert.equal(countPrivateSourcePending(db), 0)
})

test('failed central delivery preserves source row and replay is idempotent', t => {
  const db = source(t)
  db.prepare('INSERT INTO events(title,date) VALUES(?,?)')
    .run('Shared event', '2027-01-01')
  assert.throws(() => drainPrivateSourceOutbox(db, {
    apply: () => { throw new Error('Central SQLite failure') },
  }), /Central SQLite failure/)
  assert.equal(countPrivateSourcePending(db), 1)
  const processed = []
  assert.deepEqual(drainPrivateSourceOutbox(db, {
    apply: ({ sourceEventId }) => processed.push(sourceEventId),
  }), { applied: 1, acknowledged: 1, remaining: 0 })
  assert.deepEqual(processed, [1])
  assert.deepEqual(drainPrivateSourceOutbox(db, { apply: () => {} }),
    { applied: 0, acknowledged: 0, remaining: 0 })
})

test('a concurrent source edit during delivery cannot be acknowledged under old revision', t => {
  const db = source(t)
  db.prepare('INSERT INTO events(title,date) VALUES(?,?)').run('Old', '2027-01-01')
  const before = pendingPrivateSourceEvents(db)[0].revision
  const result = drainPrivateSourceOutbox(db, {
    apply: () => {
      db.prepare('UPDATE events SET title=? WHERE id=1').run('New')
    },
  })
  assert.deepEqual(result, { applied: 1, acknowledged: 0, remaining: 1 })
  assert.ok(pendingPrivateSourceEvents(db)[0].revision > before)
  assert.deepEqual(drainPrivateSourceOutbox(db, { apply: () => {} }),
    { applied: 1, acknowledged: 1, remaining: 0 })
})

test('source outbox validates batches and refuses async delivery callbacks', t => {
  const db = source(t)
  assert.throws(() => pendingPrivateSourceEvents(db, 0), /batch size/)
  assert.deepEqual(drainPrivateSourceOutbox(db, { apply: () => Promise.resolve() }),
    { applied: 0, acknowledged: 0, remaining: 0 })
  db.prepare('INSERT INTO events(title,date) VALUES(?,?)').run('One', '2027-01-01')
  assert.throws(() => drainPrivateSourceOutbox(db, { apply: () => Promise.resolve() }),
    /synchronous/)
  assert.equal(countPrivateSourcePending(db), 1)
})
