// PRIVATE TEST-GATEWAY FOUNDATION ONLY. Not a production event router.
//
// Durable "dirty source event" ledger in the CENTRAL identity/sharing SQLite.
// The gateway must record an event ID here BEFORE forwarding a PUT/DELETE to
// a household backend. A successful backend commit followed by a crash cannot
// then silently lose the intent to refresh or cancel that event's shared copy.
//
// Replaying applies the share mutation AND clears this ledger in ONE central
// transaction. The callback is trusted server-side code; no browser request
// can provide a callback, source database path, or household selector.

const HOUSEHOLD_ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

function verifiedSource(db, sourceHouseholdId) {
  if (typeof sourceHouseholdId !== 'string' ||
    !HOUSEHOLD_ID.test(sourceHouseholdId)) {
    throw new Error('Invalid trusted source household.')
  }
  const household = db.prepare([
    'SELECT id FROM household_registry',
    'WHERE storage_id = ? AND disabled = 0',
  ].join(' ')).get(sourceHouseholdId)
  if (!household) throw new Error('Trusted source household not available.')
  return household.id
}

function verifiedEventId(sourceEventId) {
  if (!Number.isSafeInteger(sourceEventId) || sourceEventId <= 0) {
    throw new Error('Invalid source event ID.')
  }
  return sourceEventId
}

export function createEventShareSyncJournal(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS event_share_sync_pending (',
    'source_household_id INTEGER NOT NULL REFERENCES household_registry(id),',
    'source_event_id INTEGER NOT NULL CHECK(source_event_id > 0),',
    'revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),',
    'queued_at INTEGER NOT NULL,',
    'PRIMARY KEY(source_household_id, source_event_id)',
    ') STRICT;',
  ].join(' '))
}

// Only called after the gateway authenticates the actor and resolves a
// membership-authorized household. A 404/validation failure at the backend may
// leave an unnecessary journal row; replaying it is harmless and preferable to
// missing a successful mutation after an interrupted response.
export function markEventShareSyncPending(db, {
  sourceHouseholdId, sourceEventId,
}) {
  const from = verifiedSource(db, sourceHouseholdId)
  verifiedEventId(sourceEventId)
  const now = Date.now()
  db.prepare([
    'INSERT INTO event_share_sync_pending',
    '(source_household_id, source_event_id, revision, queued_at)',
    'VALUES (?, ?, 1, ?)',
    'ON CONFLICT(source_household_id, source_event_id)',
    'DO UPDATE SET revision = revision + 1, queued_at = excluded.queued_at',
  ].join(' ')).run(from, sourceEventId, now)
  return db.prepare([
    'SELECT revision FROM event_share_sync_pending',
    'WHERE source_household_id = ? AND source_event_id = ?',
  ].join(' ')).get(from, sourceEventId).revision
}

export function countPendingEventShareSync(db, { sourceHouseholdId } = {}) {
  if (sourceHouseholdId == null) {
    return db.prepare('SELECT COUNT(*) AS n FROM event_share_sync_pending').get().n
  }
  const from = verifiedSource(db, sourceHouseholdId)
  return db.prepare([
    'SELECT COUNT(*) AS n FROM event_share_sync_pending',
    'WHERE source_household_id = ?',
  ].join(' ')).get(from).n
}

// The trusted apply callback MUST be synchronous; it may update only central
// share rows for the verified source event, using a separately resolved,
// trusted, read-only household DB. Replay never trusts a client-provided path.
// An exception rolls back BOTH the snapshot and journal deletion for retry.
export function replayEventShareSyncPending(db, {
  sourceHouseholdId, apply, limit = 100,
}) {
  const from = verifiedSource(db, sourceHouseholdId)
  if (typeof apply !== 'function') throw new Error('Trusted replay callback required.')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Invalid sync replay batch size.')
  }
  const pending = db.prepare([
    'SELECT source_event_id AS sourceEventId, revision',
    'FROM event_share_sync_pending',
    'WHERE source_household_id = ?',
    'ORDER BY queued_at, source_event_id LIMIT ?',
  ].join(' ')).all(from, limit)

  let replayed = 0
  for (const row of pending) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const current = db.prepare([
        'SELECT revision FROM event_share_sync_pending',
        'WHERE source_household_id = ? AND source_event_id = ?',
      ].join(' ')).get(from, row.sourceEventId)
      if (current) {
        const result = apply({ sourceHouseholdId, sourceEventId: row.sourceEventId })
        if (result && typeof result.then === 'function') {
          throw new Error('Event share reconciliation must be synchronous.')
        }
        const deleted = db.prepare([
          'DELETE FROM event_share_sync_pending',
          'WHERE source_household_id = ? AND source_event_id = ? AND revision = ?',
        ].join(' ')).run(from, row.sourceEventId, current.revision)
        if (deleted.changes !== 1) throw new Error('Concurrent sync revision change.')
        replayed += 1
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return { replayed, remaining: countPendingEventShareSync(db, { sourceHouseholdId }) }
}
