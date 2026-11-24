// Single-household event-assignment notification foundation.
// Do NOT connect to push transport until device ownership and consent are verified.
// The outbox stores IDs and change flags; cancelled notices also retain a limited
// event identity snapshot for the assigned recipient after an event is deleted.
// Never forward that private snapshot to unauthenticated/push transports.
const MATERIAL_FIELDS = Object.freeze([
  'title', 'date', 'endDate', 'time', 'endTime', 'location', 'notes',
  'repeatUnit', 'repeatInterval', 'repeatEndType', 'repeatEndDate', 'repeatCount',
])

function validId(value) {
  return Number.isSafeInteger(value) && value > 0
}

function eventRecipients(event) {
  if (event === null) return []
  if (!event || typeof event !== 'object' || !validId(event.id)
    || !Array.isArray(event.personIds)) {
    throw new Error('Event identity and assigned person IDs are required.')
  }
  const recipients = new Set()
  for (const id of event.personIds) {
    if (!validId(id)) throw new Error('Invalid assigned person ID.')
    recipients.add(id)
  }
  return [...recipients].sort((a, b) => a - b)
}

// In a create/edit/delete transaction, compare the OLD and NEW assignment sets.
// Removing one person is not a cancellation for everybody else. A metadata-only
// change notifies current assignees, but a no-op/reordered assignment does not.
// Recurring instance exceptions are deliberately NOT handled here.
export function planEventAssignmentNotifications(before, after, { excludePersonId = null } = {}) {
  if (excludePersonId !== null && !validId(excludePersonId)) {
    throw new Error('Invalid notification exclusion person ID.')
  }
  if (before === null && after === null) throw new Error('Event transition required.')
  const prior = eventRecipients(before)
  const current = eventRecipients(after)
  if (before && after && before.id !== after.id) {
    throw new Error('Cannot compare unrelated events.')
  }
  const eventId = (after ?? before).id
  const priorSet = new Set(prior)
  const currentSet = new Set(current)
  const changed = Boolean(before && after && MATERIAL_FIELDS.some(
    field => (before[field] ?? null) !== (after[field] ?? null)
  ))
  const intents = []
  for (const personId of prior) {
    if (!after) intents.push({ eventId, personId, kind: 'cancelled' })
    else if (!currentSet.has(personId)) intents.push({ eventId, personId, kind: 'unassigned' })
    else if (changed) intents.push({ eventId, personId, kind: 'changed' })
  }
  for (const personId of current) {
    if (!priorSet.has(personId)) intents.push({ eventId, personId, kind: 'assigned' })
  }
  return intents.filter(intent => intent.personId !== excludePersonId)
    .sort((a, b) => a.personId - b.personId)
}

export function installAssignmentNotificationOutbox(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS assignment_notification_outbox (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL CHECK(event_id > 0),
      person_id INTEGER NOT NULL CHECK(person_id > 0),
      kind TEXT NOT NULL CHECK(kind IN ('assigned','changed','unassigned','cancelled')),
      created_at INTEGER NOT NULL CHECK(created_at > 0),
      delivered_at INTEGER,
      delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(delivery_attempts >= 0),
      change_mask INTEGER NOT NULL DEFAULT 0 CHECK(change_mask BETWEEN 0 AND 8191),
      cancelled_details_json TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS assignment_notifications_pending_idx
      ON assignment_notification_outbox(created_at, id)
      WHERE delivered_at IS NULL;
  `)
  // The TEST pilot already has durable outbox rows. Upgrade in place without
  // clearing prior notices, delivery history, or acknowledgements.
  if (!database.prepare('PRAGMA table_info(assignment_notification_outbox)')
    .all().some(row => row.name === 'change_mask')) {
    database.exec('ALTER TABLE assignment_notification_outbox ADD COLUMN ' +
      'change_mask INTEGER NOT NULL DEFAULT 0 CHECK(change_mask BETWEEN 0 AND 8191)')
  }
  if (!database.prepare('PRAGMA table_info(assignment_notification_outbox)')
    .all().some(row => row.name === 'cancelled_details_json')) {
    database.exec('ALTER TABLE assignment_notification_outbox ADD COLUMN ' +
      'cancelled_details_json TEXT')
  }
}

// The caller must invoke this inside the SAME SQLite transaction as the
// corresponding event mutation. Rollback then removes both event and intent.
// It does not transmit anything, disclose event details or grant device access.
export function queueEventAssignmentNotifications(database, before, after, at = Date.now(), options = {}) {
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error('Invalid notification timestamp.')
  const intents = planEventAssignmentNotifications(before, after, options)
  const changeMask = options.changeMask ?? 0
  if (!Number.isSafeInteger(changeMask) || changeMask < 0 || changeMask > 8191) {
    throw new Error('Invalid event change field mask.')
  }
  // This data is server-side and is only returned to the original assigned
  // recipient through the authenticated person-scoped inbox, never Web Push.
  const deleted = options.cancelledEvent
  const cancelledDetailsJson = deleted && typeof deleted.title === 'string' &&
    typeof deleted.date === 'string' ? JSON.stringify({
      title: deleted.title,
      date: deleted.date,
      endDate: typeof deleted.endDate === 'string' ? deleted.endDate : null,
      time: typeof deleted.time === 'string' ? deleted.time : null,
      endTime: typeof deleted.endTime === 'string' ? deleted.endTime : null,
      location: typeof deleted.location === 'string' ? deleted.location : null,
    }) : null
  const insert = database.prepare(`
    INSERT INTO assignment_notification_outbox(
      event_id, person_id, kind, created_at, change_mask, cancelled_details_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (const intent of intents) {
    insert.run(intent.eventId, intent.personId, intent.kind, at,
      intent.kind === 'changed' ? changeMask : 0,
      intent.kind === 'cancelled' ? cancelledDetailsJson : null)
  }
  return intents.length
}

export function pendingAssignmentNotifications(database, limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Invalid notification batch size.')
  }
  return database.prepare(`
    SELECT id, event_id AS eventId, person_id AS personId,
           kind, created_at AS createdAt, delivery_attempts AS deliveryAttempts,
           change_mask AS changeMask
    FROM assignment_notification_outbox
    WHERE delivered_at IS NULL
    ORDER BY created_at, id
    LIMIT ?
  `).all(limit)
}

export function acknowledgeAssignmentNotification(database, id, at = Date.now()) {
  if (!validId(id) || !Number.isSafeInteger(at) || at <= 0) {
    throw new Error('Invalid notification acknowledgement.')
  }
  return database.prepare(`
    UPDATE assignment_notification_outbox SET delivered_at = ?
    WHERE id = ? AND delivered_at IS NULL
  `).run(at, id).changes === 1
}
