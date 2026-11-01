// PRIVATE HOUSEHOLD TEST MODE ONLY: durable source-local event-change outbox.
//
// Unlike a gateway HTTP completion hook, these triggers fire in the SAME
// SQLite transaction as ALL event INSERT/UPDATE/DELETE operations (including
// AI-confirmed, batch deletes and out-of-band SQL). Failed transactions roll
// back both the event and its outbox entry. No event title/notes/PII is stored
// here: only source integer IDs, durable revisions and timestamps.
//
// Cross-DB delivery into the CENTRAL sharing database is at-least-once and
// idempotent. The source row is removed only AFTER central sync commits and
// only if its revision has not changed meanwhile. If an ack fails, replaying
// the same source ID is safe. A central sync failure leaves the outbox intact.
//
// Never install or read this schema from the legacy single-family database.

function trustedId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Invalid source event outbox ID.')
  }
  return value
}

export function installPrivateEventSourceOutbox(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('Trusted writable source SQLite required.')
  }
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'"
  ).all()
  if (tables.length !== 1) throw new Error('Source events table not installed.')
  db.exec([
    'CREATE TABLE IF NOT EXISTS event_source_share_outbox (',
    'source_event_id INTEGER PRIMARY KEY CHECK(source_event_id > 0),',
    'revision INTEGER NOT NULL CHECK(revision > 0),',
    'queued_at INTEGER NOT NULL',
    ') STRICT;',
    'CREATE TRIGGER IF NOT EXISTS private_source_event_insert',
    'AFTER INSERT ON events BEGIN',
    'INSERT INTO event_source_share_outbox',
    '(source_event_id,revision,queued_at)',
    "VALUES (NEW.id,1,CAST(strftime('%s','now') AS INTEGER)*1000)",
    'ON CONFLICT(source_event_id) DO UPDATE SET',
    'revision = revision + 1,queued_at=excluded.queued_at;',
    'END;',
    'CREATE TRIGGER IF NOT EXISTS private_source_event_update',
    'AFTER UPDATE ON events BEGIN',
    'INSERT INTO event_source_share_outbox',
    '(source_event_id,revision,queued_at)',
    "VALUES (NEW.id,1,CAST(strftime('%s','now') AS INTEGER)*1000)",
    'ON CONFLICT(source_event_id) DO UPDATE SET',
    'revision = revision + 1,queued_at=excluded.queued_at;',
    'END;',
    'CREATE TRIGGER IF NOT EXISTS private_source_event_delete',
    'AFTER DELETE ON events BEGIN',
    'INSERT INTO event_source_share_outbox',
    '(source_event_id,revision,queued_at)',
    "VALUES (OLD.id,1,CAST(strftime('%s','now') AS INTEGER)*1000)",
    'ON CONFLICT(source_event_id) DO UPDATE SET',
    'revision = revision + 1,queued_at=excluded.queued_at;',
    'END;',
  ].join('\n'))
}

export function pendingPrivateSourceEvents(db, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Invalid private source outbox batch size.')
  }
  return db.prepare([
    'SELECT source_event_id AS sourceEventId, revision',
    'FROM event_source_share_outbox',
    'ORDER BY queued_at, source_event_id LIMIT ?',
  ].join(' ')).all(limit)
}

export function countPrivateSourcePending(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM event_source_share_outbox').get().n
}

export function acknowledgePrivateSourceEvent(db, { sourceEventId, revision }) {
  trustedId(sourceEventId)
  trustedId(revision)
  return db.prepare([
    'DELETE FROM event_source_share_outbox',
    'WHERE source_event_id = ? AND revision = ?',
  ].join(' ')).run(sourceEventId, revision).changes === 1
}

// A trusted callback runs central share reconciliation, preferably in its
// own central transaction. Source ack is AFTER that callback returns;
// concurrent new source edits are preserved by the revision compare.
export function drainPrivateSourceOutbox(db, { apply, limit = 100 } = {}) {
  if (typeof apply !== 'function') throw new Error('Trusted outbox apply callback required.')
  const batch = pendingPrivateSourceEvents(db, limit)
  let acknowledged = 0
  for (const row of batch) {
    const result = apply({ sourceEventId: row.sourceEventId })
    if (result && typeof result.then === 'function') {
      throw new Error('Source reconciliation callback must be synchronous.')
    }
    if (acknowledgePrivateSourceEvent(db, row)) acknowledged += 1
  }
  return { applied: batch.length, acknowledged, remaining: countPrivateSourcePending(db) }
}
