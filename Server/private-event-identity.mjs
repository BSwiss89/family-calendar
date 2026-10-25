// PRIVATE HOUSEHOLD TEST MODE ONLY — NOT A LIVE CALENDAR MIGRATION.
//
// A SQLite rowid / INTEGER PRIMARY KEY is a location, NOT an event identity.
// It may be reused after an event is deleted or a database is restored.
// Store a permanent random 128-bit identity in the source event's own SQLite
// database so copied invitations cannot accidentally bind to another event.
//
// Installation is intentionally called only for disposable household backends
// in PR #46. It does NOT run in the existing single-family production mode.
//
// SQL triggers cover ordinary API writes AND other SQLite insertion routes.
// A null-only initial transition permits backfilling old source events.
// Once assigned, an event identity cannot be changed by ordinary SQL UPDATE.

export const EVENT_UID_PATTERN = /^[0-9a-f]{32}$/

export function installPrivateEventIdentity(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('Trusted writable source SQLite required.')
  }
  const columns = db.prepare('PRAGMA table_info(events)').all()
  if (!columns.some(column => column.name === 'id')) {
    throw new Error('Events table must exist before identity installation.')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    if (!columns.some(column => column.name === 'event_uid')) {
      db.exec('ALTER TABLE events ADD COLUMN event_uid TEXT')
    }
    // Fail closed if a damaged or hand-crafted source record has an invalid
    // identity; never silently regenerate one and retarget an old share.
    const invalid = db.prepare([
      'SELECT id FROM events WHERE event_uid IS NOT NULL',
      "AND (length(event_uid) != 32 OR event_uid GLOB '*[^0-9a-f]*')",
      'LIMIT 1',
    ].join(' ')).get()
    if (invalid) throw new Error('Existing source event identity is invalid.')

    db.exec([
      'CREATE UNIQUE INDEX IF NOT EXISTS events_private_uid_unique',
      'ON events(event_uid) WHERE event_uid IS NOT NULL;',
      'UPDATE events SET event_uid = lower(hex(randomblob(16)))',
      'WHERE event_uid IS NULL;',
      'CREATE TRIGGER IF NOT EXISTS events_private_uid_immutable',
      'BEFORE UPDATE OF event_uid ON events',
      'WHEN OLD.event_uid IS NOT NULL AND NEW.event_uid IS NOT OLD.event_uid',
      "BEGIN SELECT RAISE(ABORT, 'Source event identity is immutable'); END;",
      'CREATE TRIGGER IF NOT EXISTS events_private_uid_insert',
      'AFTER INSERT ON events',
      'BEGIN',
      'UPDATE events SET event_uid = lower(hex(randomblob(16)))',
      'WHERE id = NEW.id AND event_uid IS NULL;',
      'END;',
    ].join('\n'))
    // The database, not any caller, owns identity generation. Inserting a
    // supplied old UID after deleting an event could resurrect a stale share.
    db.exec([
      'CREATE TRIGGER IF NOT EXISTS events_private_uid_validate_insert',
      'BEFORE INSERT ON events',
      'WHEN NEW.event_uid IS NOT NULL',
      "BEGIN SELECT RAISE(ABORT, 'Source event identity is server-assigned'); END;",
    ].join(' '))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function trustedEventUid(sourceDb, eventId) {
  if (!Number.isSafeInteger(eventId) || eventId <= 0 ||
    !sourceDb || typeof sourceDb.prepare !== 'function') {
    throw new Error('Invalid trusted source event.')
  }
  const row = sourceDb.prepare('SELECT event_uid AS uid FROM events WHERE id = ?')
    .get(eventId)
  if (!row) throw new Error('Selected source event does not exist.')
  if (typeof row.uid !== 'string' || !EVENT_UID_PATTERN.test(row.uid)) {
    throw new Error('Selected source event has no permanent identity.')
  }
  return row.uid
}
