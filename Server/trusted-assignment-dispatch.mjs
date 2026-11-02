// INTERNAL-ONLY, unconnected notification dispatch candidate.
// This module joins a TRUSTED single-household event outbox with the separate
// central account/device registry. It sends nothing and registers no routes.
// The gateway must supply the exact source household database from trusted
// session-side selection, never from HTTP request fields.
// Do not expose the returned push endpoints/keys through a public API.
import { listAuthorizedPushTargets } from './verified-push-subscriptions.mjs'

const validHousehold = value =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(value)
const validId = value => Number.isSafeInteger(value) && value > 0

// A preview and revalidation primitive, NOT a push sender.
// The outbox row ID is read from the trusted household database. It is never
// accepted as proof of authority or as an event payload from a browser.
//
// A later worker MUST use this just before delivery, serialize the source
// outbox for dispatch, keep replay receipts, and recheck identity on retries.
// A successful lookup alone must never acknowledge the outbox.
export function planTrustedAssignmentDispatch({
  householdDatabase,
  identityDatabase,
  trustedHouseholdId,
  trustedOutboxId,
  resolveAccountPerson,
  now = Date.now(),
}) {
  if (!householdDatabase || typeof householdDatabase.prepare !== 'function'
    || !identityDatabase || typeof identityDatabase.prepare !== 'function'
    || householdDatabase === identityDatabase) {
    throw new Error('Distinct trusted household and central identity databases required.')
  }
  if (!validHousehold(trustedHouseholdId) || !validId(trustedOutboxId)) {
    throw new Error('Trusted household and outbox IDs required.')
  }
  if (typeof resolveAccountPerson !== 'function'
    || !Number.isSafeInteger(now) || now <= 0) {
    throw new Error('Trusted synchronous person resolver and time required.')
  }
  const row = householdDatabase.prepare([
    'SELECT id,event_id AS eventId,person_id AS personId,kind,created_at AS createdAt',
    'FROM assignment_notification_outbox',
    'WHERE id = ? AND delivered_at IS NULL',
  ].join(' ')).get(trustedOutboxId)

  if (!row) return { decision: 'not_pending' }
  if (!validId(row.eventId) || !validId(row.personId)
    || !['assigned','changed','unassigned','cancelled'].includes(row.kind)) {
    throw new Error('Corrupted notification outbox entry.')
  }
  const summary = {
    id: row.id, eventId: row.eventId, personId: row.personId, kind: row.kind,
    householdId: trustedHouseholdId,
  }
  const newest = householdDatabase.prepare([
    'SELECT MAX(id) AS id FROM assignment_notification_outbox',
    'WHERE event_id = ? AND person_id = ? AND delivered_at IS NULL',
  ].join(' ')).get(row.eventId,row.personId)
  if (newest.id !== row.id) return { decision: 'superseded', ...summary }

  // The source database is preselected by the verified session. The
  // event_people relationship comes from the source DB, not events.person,
  // not the browser's profile picker, and not a device-provided person ID.
  const exists = Boolean(householdDatabase.prepare(
    'SELECT id FROM events WHERE id = ?'
  ).get(row.eventId))
  const assigned = exists && Boolean(householdDatabase.prepare([
    'SELECT 1 FROM event_people WHERE event_id = ? AND person_id = ?',
  ].join(' ')).get(row.eventId,row.personId))
  const fresh = row.kind === 'assigned' || row.kind === 'changed'
    ? assigned
    : row.kind === 'unassigned'
      ? exists && !assigned
      : !exists
  if (!fresh) return { decision: 'stale', ...summary }

  const targets = listAuthorizedPushTargets(identityDatabase, {
    trustedHouseholdId,
    trustedPersonId: row.personId,
    resolveAccountPerson,
    now,
  })
  if (targets.length === 0) return { decision: 'no_authorized_device', ...summary }
  return {
    decision: 'ready', ...summary,
    // Only server-side trusted dispatch code may use these secret entries.
    // Never log them, embed them in JSON responses or send event text with push.
    targets,
  }
}

// Cross-household source IDs may collide. The dispatcher MUST obtain both
// householdDatabase and trustedHouseholdId from the same verified gateway
// selection, not from independent user-provided input. This pure helper
// intentionally cannot prove that binding on its own.
