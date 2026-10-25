// Draft PR #46: server-attested creator identity, separate from display people.
// The browser must NEVER provide or override "createdBy" / account kind.
// This audit data lives in the CENTRAL authenticated gateway's SQLite only,
// not in the household event's editable person tags.
import { lookupGrantedHouseholdForSessionUser } from './household-memberships.mjs'

function authorized(identityDb, userId, householdId) {
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('Invalid actor.')
  const membership = lookupGrantedHouseholdForSessionUser(identityDb, {
    serverVerifiedUserId: userId, requestedHouseholdId: householdId,
  })
  if (!membership) throw new Error('No household membership for actor.')
  const row = identityDb.prepare([
    'SELECT id FROM household_registry',
    'WHERE storage_id = ? AND disabled = 0',
  ].join(' ')).get(householdId)
  if (!row) throw new Error('No active household.')
  return row.id
}

export function createEventCreatorAuditTables(identityDb) {
  // Call after central family_users, household_registry and memberships.
  identityDb.exec([
    'CREATE TABLE IF NOT EXISTS event_creator_audit (',
    'household_id INTEGER NOT NULL REFERENCES household_registry(id),',
    'event_id INTEGER NOT NULL CHECK(event_id > 0),',
    'created_by_user_id INTEGER NOT NULL REFERENCES family_users(id),',
    'created_at INTEGER NOT NULL,',
    'PRIMARY KEY (household_id, event_id)',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS event_creator_user_idx',
    'ON event_creator_audit(created_by_user_id);',
  ].join(' '))
}

/**
 * Called ONLY after an authenticated, proxied POST /api/events returns 201.
 * Never trust creator values supplied in the POST body or HTTP headers.
 */
export function recordAuthenticatedEventCreator(identityDb, {
  verifiedUserId, verifiedHouseholdId, eventId, trustedSourceDb,
}) {
  const householdDbId = authorized(identityDb, verifiedUserId, verifiedHouseholdId)
  if (!Number.isSafeInteger(eventId) || eventId < 1 ||
      !trustedSourceDb || typeof trustedSourceDb.prepare !== 'function') {
    throw new Error('Invalid created source event.')
  }
  if (!trustedSourceDb.prepare('SELECT id FROM events WHERE id = ?').get(eventId)) {
    throw new Error('Created event was not committed in the trusted household.')
  }
  const account = identityDb.prepare([
    'SELECT id FROM family_users WHERE id = ? AND disabled = 0',
  ].join(' ')).get(verifiedUserId)
  if (!account) throw new Error('Creator login unavailable.')

  // UPSERT handles a new source event that happens to reuse a deleted numeric
  // ID. An older device cannot override this via a browser-side field.
  identityDb.prepare([
    'INSERT INTO event_creator_audit',
    '(household_id, event_id, created_by_user_id, created_at)',
    'VALUES (?, ?, ?, ?)',
    'ON CONFLICT(household_id, event_id) DO UPDATE SET',
    'created_by_user_id = excluded.created_by_user_id,',
    'created_at = excluded.created_at',
  ].join(' ')).run(householdDbId, eventId, verifiedUserId, Date.now())
}

/**
 * Return only authorship labels for event IDs that STILL EXIST in this
 * device's authenticated source household. No cross-household lookup or
 * password/session/cookie/user-id details go to browser clients.
 */
export function listAuthenticatedEventCreators(identityDb, {
  verifiedUserId, verifiedHouseholdId, trustedSourceDb,
}) {
  const householdDbId = authorized(identityDb, verifiedUserId, verifiedHouseholdId)
  if (!trustedSourceDb || typeof trustedSourceDb.prepare !== 'function') {
    throw new Error('Trusted household database required.')
  }
  const all = identityDb.prepare([
    'SELECT a.event_id AS eventId, a.created_at AS createdAt,',
    'u.display_name AS displayName, u.username, u.account_kind AS accountKind',
    'FROM event_creator_audit a',
    'JOIN family_users u ON u.id = a.created_by_user_id',
    'WHERE a.household_id = ?',
    'ORDER BY a.event_id',
    'LIMIT 5000',
  ].join(' ')).all(householdDbId)
  const exists = trustedSourceDb.prepare('SELECT 1 FROM events WHERE id = ?')
  return all.filter(row => exists.get(row.eventId)).map(row => ({
    eventId: row.eventId,
    displayName: row.displayName,
    username: row.username,
    accountKind: row.accountKind,
    createdAt: row.createdAt,
  }))
}

/**
 * Clear stale creator attribution after a confirmed delete. Only the exact
 * source event ID in the verified household is affected.
 */
export function cleanupDeletedEventCreator(identityDb, {
  verifiedUserId, verifiedHouseholdId, eventId, trustedSourceDb,
}) {
  const householdDbId = authorized(identityDb, verifiedUserId, verifiedHouseholdId)
  if (!Number.isSafeInteger(eventId) || eventId < 1 ||
      !trustedSourceDb || typeof trustedSourceDb.prepare !== 'function') {
    throw new Error('Invalid deleted source event.')
  }
  if (trustedSourceDb.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId)) return false
  const changed = identityDb.prepare([
    'DELETE FROM event_creator_audit WHERE household_id = ? AND event_id = ?',
  ].join(' ')).run(householdDbId, eventId)
  return changed.changes === 1
}
