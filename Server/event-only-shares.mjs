// Draft PR #46: individual-event sharing model for a private test gateway.
// Never publicly expose until full tenancy, backup and invitation review.
// Authenticated identities come from trusted server sessions. sourceDatabase
// MUST be the resolved SQLite DB belonging to sourceHouseholdId, not user input.
import { lookupGrantedHouseholdForSessionUser } from './household-memberships.mjs'

function id(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid ' + label + '.')
  return value
}
function membership(db, actor, household) {
  const m = lookupGrantedHouseholdForSessionUser(db, {
    serverVerifiedUserId: id(actor, 'user'), requestedHouseholdId: household,
  })
  if (!m) throw new Error('Not authorized for household.')
  return m
}
function distinct(values, label, limit, check) {
  if (!Array.isArray(values) || values.length === 0 || values.length > limit) {
    throw new Error('Select individual ' + label + ' (maximum ' + limit + ').')
  }
  const chosen = values.map(value => check(value, label))
  if (new Set(chosen).size !== chosen.length) throw new Error('Duplicate ' + label + ' selected.')
  return chosen
}
function recipient(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(value)) {
    throw new Error('Invalid recipient household.')
  }
  return value
}
function activeHousehold(db, slug) {
  return db.prepare('SELECT id FROM household_registry WHERE storage_id = ? AND disabled = 0')
    .get(slug)?.id ?? null
}
function eventSummary(source, eventId) {
  const event = source.prepare([
    'SELECT id, title, date, end_date AS endDate, time,',
    'end_time AS endTime, repeat_unit AS repeatUnit FROM events WHERE id = ?',
  ].join(' ')).get(eventId)
  if (!event) throw new Error('Selected source event does not exist.')
  if (event.repeatUnit != null && event.repeatUnit !== '' && event.repeatUnit !== 'none') {
    throw new Error('Recurring events require explicit occurrence/series sharing, not yet supported.')
  }
  // Explicit minimal allowlist; DO NOT copy notes, location, names, files,
  // other participants, event IDs from unrelated events, or calendar context.
  return {
    title: event.title, date: event.date,
    endDate: event.endDate ?? null,
    time: event.time ?? null, endTime: event.endTime ?? null,
  }
}

function shareGrantTableSql(name) {
  if (!['event_share_grants', 'event_share_grants_migrating'].includes(name)) {
    throw new Error('Invalid internal grants table name.')
  }
  return [
    `CREATE TABLE ${name} (`,
    'id INTEGER PRIMARY KEY AUTOINCREMENT,',
    'source_household_id INTEGER NOT NULL REFERENCES household_registry(id),',
    'recipient_household_id INTEGER NOT NULL REFERENCES household_registry(id),',
    'source_event_id INTEGER NOT NULL CHECK(source_event_id > 0),',
    'created_by_user_id INTEGER NOT NULL REFERENCES family_users(id),',
    "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','revoked','cancelled','removed')),",
    'title TEXT NOT NULL, date TEXT NOT NULL, end_date TEXT, time TEXT, end_time TEXT,',
    'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, responded_at INTEGER,',
    'CHECK(source_household_id != recipient_household_id)',
    ') STRICT;',
  ].join(' ')
}

export function createEventShareTables(db) {
  // Only active pending/accepted grants must be unique. Inactive invitations
  // remain immutable history and must not block later explicit re-invitations,
  // including when the source SQLite database recycles a deleted event ID.
  db.exec([
    'PRAGMA foreign_keys = ON;',
    shareGrantTableSql('event_share_grants').replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '),
    'CREATE TABLE IF NOT EXISTS event_share_connections (',
    'source_household_id INTEGER NOT NULL REFERENCES household_registry(id),',
    'recipient_household_id INTEGER NOT NULL REFERENCES household_registry(id),',
    'PRIMARY KEY (source_household_id, recipient_household_id),',
    'CHECK(source_household_id != recipient_household_id)',
    ') STRICT;',
  ].join('\n'))

  const oldDefinition = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'event_share_grants'"
  ).get()?.sql ?? ''
  if (/UNIQUE\s*\(\s*source_household_id\s*,\s*recipient_household_id\s*,\s*source_event_id\s*\)/i.test(oldDefinition) ||
    !oldDefinition.includes("'removed'")) {
    // Transactional, data-preserving migration from the original table's
    // lifetime uniqueness rule. No invitation changes status or recipient.
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(shareGrantTableSql('event_share_grants_migrating'))
      db.exec([
        'INSERT INTO event_share_grants_migrating',
        '(id, source_household_id, recipient_household_id, source_event_id,',
        'created_by_user_id, status, title, date, end_date, time, end_time,',
        'created_at, updated_at, responded_at)',
        'SELECT id, source_household_id, recipient_household_id, source_event_id,',
        'created_by_user_id, status, title, date, end_date, time, end_time,',
        'created_at, updated_at, responded_at FROM event_share_grants;',
      ].join(' '))
      db.exec('DROP TABLE event_share_grants;')
      db.exec('ALTER TABLE event_share_grants_migrating RENAME TO event_share_grants;')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  db.exec([
    'CREATE INDEX IF NOT EXISTS event_share_recipient_idx',
    'ON event_share_grants(recipient_household_id, status);',
    'DROP INDEX IF EXISTS event_share_pending_pair_idx;',
    'DROP INDEX IF EXISTS event_share_accepted_pair_idx;',
    'CREATE UNIQUE INDEX IF NOT EXISTS event_share_live_pair_idx',
    'ON event_share_grants(source_household_id, recipient_household_id, source_event_id)',
    "WHERE status IN ('pending','accepted');",
  ].join('\n'))
}

/**
 * Only trusted, offline administration can connect two households for event
 * invitations. The browser may NEVER create household connections by itself.
 * This is a contact/recipient allowlist, NOT permission to see any events.
 */
export function registerTrustedShareConnection(db, { sourceHouseholdId, recipientHouseholdId }) {
  const from = activeHousehold(db, recipient(sourceHouseholdId))
  const to = activeHousehold(db, recipient(recipientHouseholdId))
  if (!from || !to || from === to) throw new Error('Two distinct active households required.')
  db.prepare([
    'INSERT INTO event_share_connections (source_household_id, recipient_household_id)',
    'VALUES (?, ?)',
  ].join(' ')).run(from, to)
}

export function listTrustedEventShareRecipients(db, { serverVerifiedUserId, sourceHouseholdId }) {
  membership(db, serverVerifiedUserId, sourceHouseholdId)
  return db.prepare([
    'SELECT target.storage_id AS householdId, target.display_name AS displayName',
    'FROM event_share_connections connected',
    'JOIN household_registry source ON source.id = connected.source_household_id',
    'JOIN household_registry target ON target.id = connected.recipient_household_id',
    'WHERE source.storage_id = ? AND source.disabled = 0 AND target.disabled = 0',
    'ORDER BY target.display_name, target.storage_id',
  ].join(' ')).all(sourceHouseholdId).map(r => ({
    householdId: r.householdId, displayName: r.displayName,
  }))
}

/**
 * Each pair (selected event ID, named recipient) receives an independent
 * pending grant. Never allow "*" or an omitted event selection, never
 * share the whole calendar. One transaction prevents partial batch sharing.
 */
export function inviteSelectedEvents(db, {
  serverVerifiedUserId, sourceHouseholdId, recipientHouseholdIds,
  eventIds, sourceDatabase, allowResend = false,
}) {
  membership(db, serverVerifiedUserId, sourceHouseholdId)
  const events = distinct(eventIds, 'event IDs', 20, id)
  const recipients = distinct(recipientHouseholdIds, 'recipient households', 8, recipient)
  if (events.length * recipients.length > 80) {
    throw new Error('Too many selected event/recipient combinations.')
  }
  if (!sourceDatabase || typeof sourceDatabase.prepare !== 'function') {
    throw new Error('Trusted source database required.')
  }
  const from = activeHousehold(db, sourceHouseholdId)
  if (!from) throw new Error('Source household is not active.')
  const targets = recipients.map(slug => {
    if (slug === sourceHouseholdId) throw new Error('Cannot share an event with its own household.')
    const target = activeHousehold(db, slug)
    if (!target) throw new Error('Recipient household is not available.')
    const connected = db.prepare([
      'SELECT 1 AS allowed FROM event_share_connections',
      'WHERE source_household_id = ? AND recipient_household_id = ?',
    ].join(' ')).get(from, target)
    if (!connected) throw new Error('Recipient household is not connected for event sharing.')
    return { slug, target }
  })
  const summaries = events.map(eventId => ({
    eventId, summary: eventSummary(sourceDatabase, eventId),
  }))
  const insert = db.prepare([
    'INSERT INTO event_share_grants',
    '(source_household_id, recipient_household_id, source_event_id,',
    'created_by_user_id, title, date, end_date, time, end_time, created_at, updated_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ].join(' '))
  const findPrior = db.prepare([
    'SELECT id, status FROM event_share_grants',
    'WHERE source_household_id = ? AND recipient_household_id = ? AND source_event_id = ?',
    'ORDER BY id DESC',
  ].join(' '))
  const made = []
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const event of summaries) for (const to of targets) {
      const now = Date.now()
      const prior = findPrior.all(from, to.target, event.eventId)
      // A pending invitation or accepted copy is already present for this
      // household. Never generate a duplicate notification, even on request.
      if (prior.some(share => share.status === 'pending')) {
        throw new Error('An invitation is already waiting for this family.')
      }
      if (prior.some(share => share.status === 'accepted')) {
        throw new Error('This event is already on the receiving calendar.')
      }
      if (prior.length > 0 && allowResend !== true) {
        throw new Error('An invitation was previously sent to this family. Confirm to resend.')
      }
      const saved = insert.run(from, to.target, event.eventId, serverVerifiedUserId,
        event.summary.title, event.summary.date, event.summary.endDate,
        event.summary.time, event.summary.endTime, now, now)
      made.push({ shareId: Number(saved.lastInsertRowid), recipientHouseholdId: to.slug })
    }
    db.exec('COMMIT')
    return made
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function grantForActor(db, shareId, actor, direction, actorHouseholdId) {
  id(shareId, 'share ID')
  const row = db.prepare([
    'SELECT s.*, source.storage_id AS sourceHouseholdId,',
    'target.storage_id AS recipientHouseholdId',
    'FROM event_share_grants s',
    'JOIN household_registry source ON source.id = s.source_household_id',
    'JOIN household_registry target ON target.id = s.recipient_household_id',
    'WHERE s.id = ? AND source.disabled = 0 AND target.disabled = 0',
  ].join(' ')).get(shareId)
  if (!row) throw new Error('Share not available.')
  const targetHouseholdId = direction === 'recipient'
    ? row.recipientHouseholdId : row.sourceHouseholdId
  // Check actual membership first. An otherwise authorized multi-family
  // member must ALSO be acting in the selected verified device context.
  membership(db, actor, targetHouseholdId)
  if (actorHouseholdId !== targetHouseholdId) {
    throw new Error('Share is not available to the selected household.')
  }
  return row
}

/** Accept or decline only a pending invitation addressed to this household. */
export function respondToEventInvitation(db, { serverVerifiedUserId, recipientHouseholdId, shareId, decision }) {
  if (!['accepted', 'declined'].includes(decision)) throw new Error('Invalid invitation response.')
  const row = grantForActor(db, shareId, serverVerifiedUserId, 'recipient', recipientHouseholdId)
  if (row.status !== 'pending') throw new Error('Invitation is no longer pending.')
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    if (decision === 'accepted') {
      // Replace (not duplicate) the previous accepted event in this household.
      // A declined reminder leaves the original accepted event untouched.
      db.prepare([
        "UPDATE event_share_grants SET status = 'revoked', updated_at = ?",
        'WHERE source_household_id = ? AND recipient_household_id = ?',
        "AND source_event_id = ? AND status = 'accepted' AND id != ?",
      ].join(' ')).run(now, row.source_household_id, row.recipient_household_id,
        row.source_event_id, shareId)
    }
    const changed = db.prepare([
      'UPDATE event_share_grants SET status = ?, responded_at = ?, updated_at = ?',
      "WHERE id = ? AND status = 'pending'",
    ].join(' ')).run(decision, now, now, shareId)
    if (changed.changes !== 1) throw new Error('Invitation changed, please reload.')
    db.exec('COMMIT')
    return { shareId, status: decision }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * The recipient can remove an accepted snapshot from THEIR OWN calendar.
 * This never touches the sender's household database or other recipients.
 * Mark it as inactive history so an explicit re-invite is possible.
 */
export function removeReceivedEventShare(db, {
  serverVerifiedUserId, recipientHouseholdId, shareId,
}) {
  const share = grantForActor(db, shareId, serverVerifiedUserId, 'recipient', recipientHouseholdId)
  if (share.status !== 'accepted') throw new Error('Accepted shared event is unavailable.')
  const result = db.prepare([
    "UPDATE event_share_grants SET status = 'removed', updated_at = ?",
    "WHERE id = ? AND recipient_household_id = ? AND status = 'accepted'",
  ].join(' ')).run(Date.now(), shareId, share.recipient_household_id)
  if (result.changes !== 1) throw new Error('Accepted shared event changed, please reload.')
  return { shareId, status: 'removed' }
}

/** Revoke this specific event-to-recipient grant only. */
export function revokeSelectedEventShare(db, { serverVerifiedUserId, sourceHouseholdId, shareId }) {
  const row = grantForActor(db, shareId, serverVerifiedUserId, 'source', sourceHouseholdId)
  if (!['pending', 'accepted', 'declined'].includes(row.status)) {
    throw new Error('Share is already revoked or cancelled.')
  }
  const now = Date.now()
  // Stopping sharing means stopping BOTH an accepted share and any pending
  // resend for the same event/recipient. No latent invite can re-enable it.
  const changed = db.prepare([
    "UPDATE event_share_grants SET status = 'revoked', updated_at = ?",
    'WHERE source_household_id = ? AND recipient_household_id = ?',
    "AND source_event_id = ? AND status IN ('pending','accepted')",
  ].join(' ')).run(now, row.source_household_id, row.recipient_household_id,
    row.source_event_id)
  if (row.status === 'declined') {
    db.prepare([
      "UPDATE event_share_grants SET status = 'revoked', updated_at = ?",
      "WHERE id = ? AND status = 'declined'",
    ].join(' ')).run(now, shareId)
  } else if (changed.changes < 1) {
    throw new Error('Share is already revoked or cancelled.')
  }
  return { shareId, status: 'revoked' }
}

function recipientRows(db, { serverVerifiedUserId, recipientHouseholdId }, status) {
  membership(db, serverVerifiedUserId, recipientHouseholdId)
  // Never return source_event_id, notes, location, attachments or any
  // unrelated household data. This is only an approved event snapshot.
  return db.prepare([
    'SELECT s.id AS shareId, source.display_name AS sharedBy,',
    's.title, s.date, s.end_date AS endDate, s.time, s.end_time AS endTime',
    'FROM event_share_grants s',
    'JOIN household_registry target ON target.id = s.recipient_household_id',
    'JOIN household_registry source ON source.id = s.source_household_id',
    'WHERE target.storage_id = ? AND s.status = ?',
    'AND source.disabled = 0 AND target.disabled = 0',
    'ORDER BY s.date, s.time, s.id',
  ].join(' ')).all(recipientHouseholdId, status).map(row => ({ ...row }))
}
/**
 * Show only this signed-in household's own outgoing, individually selected
 * event invitations. Returning one recipient's share ID does not grant the
 * source account access to any recipient calendar.
 */
export function listOutgoingEventShares(db, { serverVerifiedUserId, sourceHouseholdId }) {
  membership(db, serverVerifiedUserId, sourceHouseholdId)
  return db.prepare([
    'SELECT share.id AS shareId, share.source_event_id AS sourceEventId,',
    'recipient.storage_id AS recipientHouseholdId,',
    'recipient.display_name AS recipientDisplayName, share.status,',
    'share.title, share.date, share.time',
    'FROM event_share_grants share',
    'JOIN household_registry source ON source.id = share.source_household_id',
    'JOIN household_registry recipient ON recipient.id = share.recipient_household_id',
    'WHERE source.storage_id = ?',
    'AND source.disabled = 0 AND recipient.disabled = 0',
    'ORDER BY share.date, share.id',
  ].join(' ')).all(sourceHouseholdId).map(row => ({
    shareId: row.shareId,
    sourceEventId: row.sourceEventId,
    recipientHouseholdId: row.recipientHouseholdId,
    recipientDisplayName: row.recipientDisplayName,
    status: row.status,
    title: row.title,
    date: row.date,
    time: row.time,
  }))
}

export function listEventShareInvitations(db, args) {
  return recipientRows(db, args, 'pending')
}
export function listAcceptedSharedEvents(db, args) {
  return recipientRows(db, args, 'accepted')
}

/**
 * The only direct call site is the PRIVATE gateway's server-trusted replay
 * loop, using its fixed, validated household storage mapping. This is not an
 * HTTP endpoint and does not accept a browser-supplied household/database.
 * Reconciliation must also work after the original editor has signed out or
 * lost membership; their successful backend write still needs propagation.
 */
export function synchronizeTrustedSelectedEventShare(db, {
  sourceHouseholdId, sourceEventId, sourceDatabase,
}) {
  id(sourceEventId, 'source event ID')
  const from = activeHousehold(db, sourceHouseholdId)
  if (!from) throw new Error('Source household is not active.')
  if (!sourceDatabase || typeof sourceDatabase.prepare !== 'function') {
    throw new Error('Trusted source database required.')
  }
  let summary
  try {
    summary = eventSummary(sourceDatabase, sourceEventId)
  } catch (error) {
    // A formerly single event becoming recurring MUST NOT silently extend
    // the recipient's grant to the whole series. Cancel its old snapshot.
    if (error.message !== 'Selected source event does not exist.'
      && !error.message.startsWith('Recurring events require explicit')) {
      throw error
    }
    summary = null
  }
  if (summary) {
    const changed = db.prepare([
      'UPDATE event_share_grants SET',
      'title = ?, date = ?, end_date = ?, time = ?, end_time = ?, updated_at = ?',
      "WHERE source_household_id = ? AND source_event_id = ? AND status IN ('pending','accepted')",
    ].join(' ')).run(summary.title, summary.date, summary.endDate,
      summary.time, summary.endTime, Date.now(), from, sourceEventId)
    return { updated: changed.changes, cancelled: 0 }
  }
  const cancelled = db.prepare([
    "UPDATE event_share_grants SET status = 'cancelled', updated_at = ?",
    "WHERE source_household_id = ? AND source_event_id = ? AND status IN ('pending','accepted')",
  ].join(' ')).run(Date.now(), from, sourceEventId)
  return { updated: 0, cancelled: cancelled.changes }
}

/** Authenticated legacy test helper; authorization is NOT optional here. */
export function synchronizeSelectedEventShare(db, {
  serverVerifiedUserId, sourceHouseholdId, sourceEventId, sourceDatabase,
}) {
  membership(db, serverVerifiedUserId, sourceHouseholdId)
  return synchronizeTrustedSelectedEventShare(db, {
    sourceHouseholdId, sourceEventId, sourceDatabase,
  })
}
