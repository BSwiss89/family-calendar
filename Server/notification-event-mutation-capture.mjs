// PRODUCTION-RELEASE SUPPORT. Install only with reviewed, backed-up LIVE
// backend/database migration and explicit approval.
//
// This captures SQL changes made by normal event APIs, AI reschedules,
// batch deletes, event_people changes, and recurring exceptions in the SAME
// SQLite transaction as the mutation. A separate trusted reconciliation call
// compares the current committed state against a baseline to create the
// existing assignment notification intents atomically and idempotently.
//
// This component is not a delivery worker, never sends push, and never opens
// an HTTP endpoint. Device authorization remains at trusted dispatch time.
import { createHash } from 'node:crypto'
import { queueEventAssignmentNotifications } from './event-assignment-notifications.mjs'

const isId = value => Number.isSafeInteger(value) && value > 0

function requireDb(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new Error('Trusted household SQLite connection required.')
  }
}

const eventQuery = [
  'SELECT id,date,end_date AS endDate,title,time,end_time AS endTime,',
  'notes,location,repeat_unit AS repeatUnit,repeat_interval AS repeatInterval,',
  'repeat_end_type AS repeatEndType,repeat_end_date AS repeatEndDate,',
  'repeat_count AS repeatCount FROM events WHERE id = ?',
].join(' ')

// A stable material-change fingerprint avoids storing private titles/notes
// in the shadow/outbox. Assigned people live as sorted integer IDs.
// Occurrence exceptions are part of the SERIES fingerprint, not separate
// per-occurrence cancellation intents.
function currentSnapshot(db, eventId) {
  const event = db.prepare(eventQuery).get(eventId)
  if (!event) return null
  const personIds = db.prepare([
    'SELECT person_id AS personId FROM event_people',
    'WHERE event_id = ? ORDER BY person_id',
  ].join(' ')).all(eventId).map(row => row.personId)
  if (personIds.some(id => !isId(id))) throw new Error('Invalid stored assigned person.')
  const exceptionDates = db.prepare([
    'SELECT occurrence_date AS date FROM event_exceptions',
    'WHERE event_id = ? ORDER BY occurrence_date',
  ].join(' ')).all(eventId).map(row => row.date)
  const metadata = [
    event.date, event.endDate, event.title, event.time,
    event.endTime, event.notes, event.location,
    event.repeatUnit, event.repeatInterval, event.repeatEndType,
    event.repeatEndDate, event.repeatCount, exceptionDates,
  ]
  const materialHash = createHash('sha256')
    .update(JSON.stringify(metadata)).digest('hex')
  return { id: eventId, personIds: [...new Set(personIds)], materialHash }
}

function baselineSnapshot(db,eventId) {
  const row = db.prepare([
    'SELECT material_hash AS materialHash,person_ids_json AS personIdsJson',
    'FROM notification_event_baselines WHERE event_id = ?',
  ].join(' ')).get(eventId)
  if (!row) return null
  const personIds = JSON.parse(row.personIdsJson)
  if (!Array.isArray(personIds) || personIds.some(x => !isId(x))
    || typeof row.materialHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(row.materialHash)) {
    throw new Error('Corrupted notification event baseline.')
  }
  return {id:eventId,personIds,materialHash:row.materialHash}
}

function storeBaseline(db, snapshot) {
  if (!snapshot) throw new Error('Event baseline snapshot required.')
  db.prepare([
    'INSERT INTO notification_event_baselines(event_id,material_hash,person_ids_json)',
    'VALUES (?,?,?) ON CONFLICT(event_id) DO UPDATE SET',
    'material_hash=excluded.material_hash,person_ids_json=excluded.person_ids_json',
  ].join(' ')).run(snapshot.id,snapshot.materialHash,JSON.stringify(snapshot.personIds))
}

function plannerInput(snapshot) {
  return snapshot
    ? { id:snapshot.id, personIds:snapshot.personIds, title:snapshot.materialHash }
    : null
}

function markDirty(sqlId) {
  return [
    'INSERT INTO notification_dirty_events(event_id,revision,queued_at)',
    "VALUES (" + sqlId + ",1,CAST(strftime('%s','now') AS INTEGER)*1000)",
    'ON CONFLICT(event_id) DO UPDATE SET',
    'revision=revision+1,queued_at=excluded.queued_at;',
  ].join(' ')
}

const triggerDefinitions = [
  ['notify_event_insert','AFTER INSERT ON events', markDirty('NEW.id')],
  ['notify_event_update','AFTER UPDATE ON events',
    markDirty('OLD.id') + '\n' + markDirty('NEW.id')],
  ['notify_event_delete','AFTER DELETE ON events', markDirty('OLD.id')],
  ['notify_people_insert','AFTER INSERT ON event_people',markDirty('NEW.event_id')],
  ['notify_people_delete','AFTER DELETE ON event_people',markDirty('OLD.event_id')],
  ['notify_people_update','AFTER UPDATE ON event_people',
    markDirty('OLD.event_id') + '\n' + markDirty('NEW.event_id')],
  ['notify_exception_insert','AFTER INSERT ON event_exceptions',markDirty('NEW.event_id')],
  ['notify_exception_update','AFTER UPDATE ON event_exceptions',
    markDirty('OLD.event_id') + '\n' + markDirty('NEW.event_id')],
  ['notify_exception_delete','AFTER DELETE ON event_exceptions',markDirty('OLD.event_id')],
]

export function installNotificationMutationCapture(db) {
  requireDb(db)
  // A boot-time migration must be separately approved. In an isolated test
  // database, baseline all existing events BEFORE creating SQL triggers so
  // old calendar data does not generate unsolicited initial notifications.
  const tables = new Set(db.prepare([
    "SELECT name FROM sqlite_master WHERE type='table'",
    "AND name IN ('events','event_people','event_exceptions')",
  ].join(' ')).all().map(row => row.name))
  if (tables.size !== 3) {
    throw new Error('Events, event_people and event_exceptions are required.')
  }
  const previous = new Set(db.prepare([
    "SELECT name FROM sqlite_master WHERE type='table'",
    "AND name IN ('notification_event_baselines','notification_dirty_events')",
  ].join(' ')).all().map(row => row.name))
  if (previous.size === 1) throw new Error('Partial notification capture schema.')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec([
      'CREATE TABLE IF NOT EXISTS notification_event_baselines(',
      'event_id INTEGER PRIMARY KEY CHECK(event_id > 0),',
      'material_hash TEXT NOT NULL, person_ids_json TEXT NOT NULL',
      ') STRICT;',
      'CREATE TABLE IF NOT EXISTS notification_dirty_events(',
      'event_id INTEGER PRIMARY KEY CHECK(event_id > 0),',
      'revision INTEGER NOT NULL CHECK(revision > 0),',
      'queued_at INTEGER NOT NULL',
      ') STRICT;',
      'CREATE INDEX IF NOT EXISTS notification_dirty_events_order',
      'ON notification_dirty_events(queued_at,event_id);',
      // The table is additive for an already-migrated LIVE pilot. Missing or
      // mixed actor attribution never suppresses a notification.
      'CREATE TABLE IF NOT EXISTS notification_dirty_event_attribution(',
      'event_id INTEGER PRIMARY KEY CHECK(event_id > 0),',
      'person_id INTEGER,revision INTEGER NOT NULL CHECK(revision > 0)',
      ') STRICT;',
    ].join('\n'))
    if (!previous.size) {
      for (const {id} of db.prepare('SELECT id FROM events ORDER BY id').all()) {
        storeBaseline(db,currentSnapshot(db,id))
      }
    }
    db.exec(triggerDefinitions.map(([name,when,body]) =>
      'CREATE TRIGGER IF NOT EXISTS ' + name + ' ' + when + ' BEGIN\n' +
      body + '\nEND;'
    ).join('\n'))
    db.exec('COMMIT')
  } catch(error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// This is called by a future internal trusted worker only, after prior
// writes have committed, never from untrusted HTTP parameters. Lock the
// SQLite writer so rows, snapshots, notification intents and dirty-row
// acknowledgements are one atomic unit. Mid-process failure rolls back all.
//
// The resulting intent queue is durable, but Web Push at-most-once or
// exactly-once delivery is NOT guaranteed without device delivery receipts.
export function reconcileNotificationMutations(db, { limit = 100, at = Date.now() } = {}) {
  requireDb(db)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000
    || !Number.isSafeInteger(at) || at <= 0) {
    throw new Error('Invalid notification reconciliation options.')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const batch = db.prepare([
      'SELECT event_id AS eventId,revision FROM notification_dirty_events',
      'ORDER BY queued_at,event_id LIMIT ?',
    ].join(' ')).all(limit)
    let queued = 0
    for (const {eventId,revision} of batch) {
      if (!isId(eventId) || !isId(revision)) {
        throw new Error('Corrupted dirty event intent.')
      }
      const before = baselineSnapshot(db,eventId)
      const after = currentSnapshot(db,eventId)
      const origin = db.prepare([
        'SELECT person_id AS personId,revision',
        'FROM notification_dirty_event_attribution WHERE event_id=?',
      ].join(' ')).get(eventId)
      // An exact revision match proves that no unrecorded change happened
      // between the attributed mutation and this reconciliation.
      const excludePersonId = origin?.revision === revision &&
        isId(origin.personId) ? origin.personId : null
      if (before || after) {
        queued += queueEventAssignmentNotifications(
          db,plannerInput(before),plannerInput(after),at,{excludePersonId}
        )
      }
      if (after) storeBaseline(db,after)
      else db.prepare('DELETE FROM notification_event_baselines WHERE event_id = ?')
        .run(eventId)
      db.prepare('DELETE FROM notification_dirty_event_attribution WHERE event_id=?')
        .run(eventId)
      // Compare revision even though BEGIN IMMEDIATE serializes SQLite writers:
      // a future caller may reuse these semantics with cross-process workers.
      const acknowledged = db.prepare([
        'DELETE FROM notification_dirty_events',
        'WHERE event_id = ? AND revision = ?',
      ].join(' ')).run(eventId,revision)
      if (acknowledged.changes !== 1) {
        throw new Error('Dirty event changed during reconciliation.')
      }
    }
    const remaining = db.prepare(
      'SELECT COUNT(*) AS n FROM notification_dirty_events'
    ).get().n
    db.exec('COMMIT')
    return {processed:batch.length,queued,remaining}
  } catch(error) {
    db.exec('ROLLBACK')
    throw error
  }
}
