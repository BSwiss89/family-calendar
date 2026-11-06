// Attribution for the optional single-family assignment-notification pilot.
// Only a selected person recorded in the authenticated, unrevoked server session
// is eligible. Browser-supplied actor IDs and Home cannot suppress notices.
// Profiles are shared-device preferences, NOT verified individual identities.

const validId = id => Number.isSafeInteger(id) && id > 0

function enabled(db) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='notification_dirty_event_attribution'"
  ).get())
}

function sessionPerson(db, request) {
  const account = request?.familyAccount
  if (!account || !validId(account.id) || !validId(account.user_id)) return null
  const row = db.prepare([
    'SELECT s.selected_person_id AS personId',
    'FROM family_sessions s JOIN family_users u ON u.id=s.user_id',
    "WHERE s.id=? AND s.user_id=? AND s.selected_profile_kind='person'",
    'AND s.revoked_at IS NULL AND s.expires_at>? AND u.disabled=0',
  ].join(' ')).get(account.id, account.user_id, Date.now())
  if (!validId(row?.personId)) return null
  return db.prepare('SELECT 1 FROM people WHERE id=?').get(row.personId)
    ? row.personId : null
}

const revisionFor = (db, id) => db.prepare(
  'SELECT revision FROM notification_dirty_events WHERE event_id=?'
).get(id)?.revision ?? 0

const recordedFor = (db, id) => db.prepare([
  'SELECT person_id AS personId, revision',
  'FROM notification_dirty_event_attribution WHERE event_id=?',
].join(' ')).get(id) ?? null

function record(db, eventId, personId, revision) {
  db.prepare([
    'INSERT INTO notification_dirty_event_attribution(event_id,person_id,revision)',
    'VALUES (?,?,?) ON CONFLICT(event_id) DO UPDATE SET',
    'person_id=excluded.person_id,revision=excluded.revision',
  ].join(' ')).run(eventId, personId, revision)
}

// Capture BEFORE any mutations for these event IDs. Stamp BEFORE committing
// the same transaction, so a failed save never leaves mismatched attribution.
// Multiple edits only suppress an actor if EVERY pending mutation since the
// last reconciliation is attributable to that SAME actor. Unknown/mixed
// changes are deliberately not suppressed.
export function captureEventMutationAttribution(db, request, eventIds) {
  if (!enabled(db)) return {finish() {}}
  const ids = [...new Set(eventIds)]
  if (ids.some(id => !validId(id))) throw new Error('Invalid mutation event ID.')
  const actor = sessionPerson(db, request)
  const before = ids.map(id => ({
    id, revision: revisionFor(db, id), attribution: recordedFor(db, id),
  }))
  let finished = false
  return { finish() {
    if (finished) throw new Error('Event attribution already finalized.')
    finished = true
    for (const item of before) {
      const revision = revisionFor(db, item.id)
      if (revision <= item.revision) continue // No persisted change.
      const sameActor = item.revision === 0 ||
        (item.attribution?.revision === item.revision &&
          item.attribution.personId === actor && actor !== null)
      record(db, item.id, actor !== null && sameActor ? actor : null, revision)
    }
  }}
}

// A newly inserted event has no prior revision or prior actor. Call in the
// create-event transaction AFTER all event and assignment rows are written.
export function attributeNewEvent(db, request, eventId) {
  if (!enabled(db)) return
  if (!validId(eventId)) throw new Error('Invalid created event ID.')
  const revision = revisionFor(db, eventId)
  if (revision === 0) throw new Error('Created event has no notification revision.')
  if (recordedFor(db, eventId)) throw new Error('Created event already attributed.')
  record(db, eventId, sessionPerson(db, request), revision)
}

// For routes with a single autocommit SQL write, include both the write and
// its attribution in one transaction. A dynamic IDs function supports batch
// deletes whose affected IDs must be discovered before the SQL mutation.
export function applyAttributedEventMutation(db, request, idsOrGetIds, action) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const ids = typeof idsOrGetIds === 'function' ? idsOrGetIds() : idsOrGetIds
    const capture = captureEventMutationAttribution(db, request, ids)
    const result = action()
    capture.finish()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
