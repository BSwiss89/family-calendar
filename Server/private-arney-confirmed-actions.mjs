// PRIVATE MULTI-HOUSEHOLD TEST ONLY — gateway-owned Arney event actions.
// Never proxy the legacy AI-confirmed routes; they do not carry trusted
// household, immutable event identity, snapshot approval, or retry fencing.
// A preview is signed for one user, device session, household and exact source
// snapshot. Confirm requires a separate, explicit client action. NO LLM call.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { EVENT_UID_PATTERN } from './private-event-identity.mjs'

const WINDOW_MS = 5 * 60 * 1000
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const ACTIONS = new Set(['cancel', 'reschedule'])

function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) {
    throw new ArneyActionError(400, 'Invalid Arney action request.')
  }
}
function day(s) {
  return typeof s === 'string' && DATE.test(s) &&
    !Number.isNaN(Date.parse(s + 'T00:00:00Z')) &&
    new Date(Date.parse(s + 'T00:00:00Z')).toISOString().slice(0, 10) === s
}
function trustedContext({ sourceDb, tokenKey, verifiedUserId, verifiedSessionId, householdId }) {
  if (!sourceDb?.prepare || !Buffer.isBuffer(tokenKey) || tokenKey.length !== 32 ||
      !Number.isSafeInteger(verifiedUserId) || verifiedUserId < 1 ||
      !Number.isSafeInteger(verifiedSessionId) || verifiedSessionId < 1 ||
      typeof householdId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(householdId)) {
    throw new Error('Untrusted private Arney action context.')
  }
}
function current(db, eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(eventId)
  if (!event) throw new ArneyActionError(409, 'Event changed or is no longer available.')
  if (!EVENT_UID_PATTERN.test(event.event_uid ?? '')) {
    throw new ArneyActionError(409, 'Event has no permanent identity.')
  }
  // Only simple, single-day event rows in the first private test slice.
  if (event.end_date != null ||
      (event.repeat_unit != null && event.repeat_unit !== '' && event.repeat_unit !== 'none')) {
    throw new ArneyActionError(409, 'Recurring or multi-day events are not supported here.')
  }
  return event
}
function fingerprint(db, row) {
  // Hash the WHOLE event row, including private notes and persistent identity,
  // without returning those fields. Person link changes also invalidate it.
  const linked = db.prepare([
    'SELECT person_id FROM event_people WHERE event_id=? ORDER BY person_id',
  ].join(' ')).all(row.id).map(r => r.person_id)
  return createHash('sha256').update(JSON.stringify([row, linked])).digest('hex')
}
function mac(key, raw) {
  return createHmac('sha256', key).update(raw).digest()
}
function verifyToken(token, key, now) {
  if (typeof token !== 'string' || token.length > 2048 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new ArneyActionError(400, 'Invalid action preview token.')
  }
  const [encoded, signature] = token.split('.')
  const given = Buffer.from(signature, 'base64url')
  const expected = mac(key, encoded)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new ArneyActionError(409, 'Action preview is not valid for this session.')
  }
  let approval
  try { approval = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) }
  catch { throw new ArneyActionError(400, 'Invalid action preview token.') }
  if (!Number.isSafeInteger(approval.iat) || now < approval.iat ||
      now - approval.iat > WINDOW_MS) {
    throw new ArneyActionError(409, 'Action preview expired. Review the event again.')
  }
  return approval
}
export class ArneyActionError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export function previewPrivateArneyAction({
  sourceDb, tokenKey, verifiedUserId, verifiedSessionId, householdId,
  request, now = Date.now(),
}) {
  trustedContext({ sourceDb, tokenKey, verifiedUserId, verifiedSessionId, householdId })
  keys(request, ['action','eventId','newDate','newTime'])
  if (!ACTIONS.has(request.action) || !Number.isSafeInteger(request.eventId) ||
      request.eventId < 1 || !Number.isSafeInteger(now) || now <= 0) {
    throw new ArneyActionError(400, 'Invalid event action.')
  }
  const suppliedDate = Object.hasOwn(request, 'newDate')
  const suppliedTime = Object.hasOwn(request, 'newTime')
  if (request.action === 'cancel' && (suppliedDate || suppliedTime)) {
    throw new ArneyActionError(400, 'Cancellation cannot include rescheduling details.')
  }
  if (request.action === 'reschedule' &&
      ((!suppliedDate && !suppliedTime) ||
       (suppliedDate && !day(request.newDate)) ||
       (suppliedTime && request.newTime !== null && !TIME.test(request.newTime)))) {
    throw new ArneyActionError(400, 'Invalid new event date or time.')
  }
  const row = current(sourceDb, request.eventId)
  if (request.action === 'reschedule' && suppliedTime && row.end_time != null) {
    throw new ArneyActionError(409, 'Events with end times need manual editing.')
  }
  const targetDate = suppliedDate ? request.newDate : row.date
  const targetTime = suppliedTime ? request.newTime : row.time
  if (request.action === 'reschedule' &&
      targetDate === row.date && targetTime === row.time) {
    throw new ArneyActionError(409, 'Event would not change.')
  }
  const signed = {
    v: 1, action: request.action, id: row.id, uid: row.event_uid,
    fp: fingerprint(sourceDb, row), householdId, verifiedUserId,
    verifiedSessionId, targetDate, targetTime, iat: now,
  }
  const payload = Buffer.from(JSON.stringify(signed)).toString('base64url')
  const previewToken = payload + '.' + mac(tokenKey, payload).toString('base64url')
  return {
    action: request.action, eventId: row.id,
    current: { title: row.title, date: row.date, time: row.time },
    proposed: request.action === 'reschedule'
      ? { date: targetDate, time: targetTime } : null,
    expiresAt: new Date(now + WINDOW_MS).toISOString(),
    previewToken, requiresConfirmation: true,
  }
}

// Always call this AFTER the gateway rechecks authentication/membership and
// reconciles pending journals. beforeWrite durably journals the affected ID
// before mutating. The outbox trigger records the source change in the SAME
// SQLite transaction. Client disconnects never bypass reconciliation.
export function confirmPrivateArneyAction({
  sourceDb, tokenKey, verifiedUserId, verifiedSessionId, householdId,
  request, beforeWrite, now = Date.now(),
}) {
  trustedContext({ sourceDb, tokenKey, verifiedUserId, verifiedSessionId, householdId })
  keys(request, ['confirm', 'previewToken'])
  if (request.confirm !== true || typeof beforeWrite !== 'function') {
    throw new ArneyActionError(400, 'Explicit event confirmation is required.')
  }
  const proof = verifyToken(request.previewToken, tokenKey, now)
  if (proof.v !== 1 || proof.householdId !== householdId ||
      proof.verifiedUserId !== verifiedUserId ||
      proof.verifiedSessionId !== verifiedSessionId ||
      !ACTIONS.has(proof.action) ||
      !Number.isSafeInteger(proof.id) || proof.id < 1 ||
      !EVENT_UID_PATTERN.test(proof.uid ?? '')) {
    throw new ArneyActionError(409, 'Action preview is not valid for this household.')
  }
  sourceDb.exec('BEGIN IMMEDIATE')
  try {
    const row = current(sourceDb, proof.id)
    if (row.event_uid !== proof.uid || fingerprint(sourceDb, row) !== proof.fp) {
      throw new ArneyActionError(409, 'Event changed since the preview. Review it again.')
    }
    if (proof.action === 'reschedule') {
      if (!day(proof.targetDate) ||
          (proof.targetTime !== null && !TIME.test(proof.targetTime)) ||
          (row.end_time != null && proof.targetTime !== row.time) ||
          (row.date === proof.targetDate && row.time === proof.targetTime)) {
        throw new ArneyActionError(409, 'Action preview no longer matches the event.')
      }
    }
    const journal = beforeWrite({ sourceEventId: row.id })
    if (journal && typeof journal.then === 'function')
      throw new Error('Private action journal must be synchronous.')
    const changed = proof.action === 'cancel'
      ? sourceDb.prepare('DELETE FROM events WHERE id=? AND event_uid=?')
        .run(row.id, row.event_uid).changes
      : sourceDb.prepare([
          'UPDATE events SET date=?,time=? WHERE id=? AND event_uid=?',
        ].join(' ')).run(proof.targetDate, proof.targetTime, row.id, row.event_uid).changes
    if (changed !== 1) throw new Error('Private Arney source write was not atomic.')
    sourceDb.exec('COMMIT')
    return { success: true, action: proof.action, eventId: row.id }
  } catch (error) {
    sourceDb.exec('ROLLBACK')
    throw error
  }
}
