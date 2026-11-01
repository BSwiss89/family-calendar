// PRIVATE MULTI-HOUSEHOLD TEST-ONLY Arney read-only calendar lookup.
// No model call, no natural-language interpretation, no mutation, no private
// event attributes (notes/location/people/photos), no full calendar sharing.
// The gateway MUST resolve the source DB and verify/reconcile invitations;
// no browser may supply a database, household identity or event ID.
import { lookupGrantedHouseholdForSessionUser } from './household-memberships.mjs'

const MAX_DAYS = 31
const MAX_EVENTS = 50
const DAY_MS = 86400000

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false
  const time = Date.parse(value + 'T00:00:00Z')
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

export function validatePrivateArneyLookupRange(fromDate, toDate) {
  if (!validDay(fromDate) || !validDay(toDate))
    throw new Error('Invalid Arney calendar dates.')
  const span = (Date.parse(toDate + 'T00:00:00Z') -
    Date.parse(fromDate + 'T00:00:00Z')) / DAY_MS
  if (span < 0 || span >= MAX_DAYS)
    throw new Error('Arney lookup range must cover 1 to 31 days.')
  return { fromDate, toDate }
}

export function listPrivateArneyCalendar({
  identityDatabase, sourceDatabase, serverVerifiedUserId,
  householdId, fromDate, toDate,
}) {
  const range = validatePrivateArneyLookupRange(fromDate, toDate)
  if (!Number.isSafeInteger(serverVerifiedUserId) || serverVerifiedUserId <= 0 ||
      !identityDatabase?.prepare || !sourceDatabase?.prepare)
    throw new Error('Trusted Arney calendar database and account required.')
  const access = lookupGrantedHouseholdForSessionUser(identityDatabase, {
    serverVerifiedUserId, requestedHouseholdId: householdId,
  })
  if (!access) throw new Error('No active Arney household membership.')

  // Query only the selected family's own SQLite connection. SQL projects
  // exactly the allowlisted fields and clips both overlapping multiday events
  // and result size. Recurrences are NOT expanded by this first safety slice.
  const own = sourceDatabase.prepare([
    'SELECT id AS eventId, title, date, end_date AS endDate,',
    'time, end_time AS endTime FROM events',
    'WHERE date <= ? AND COALESCE(end_date,date) >= ?',
    "AND (repeat_unit IS NULL OR repeat_unit = '' OR repeat_unit = 'none')",
    'ORDER BY date, time, id LIMIT ?',
  ].join(' ')).all(toDate, fromDate, MAX_EVENTS + 1)
  if (own.length > MAX_EVENTS)
    throw new Error('Arney calendar lookup result limit exceeded.')

  // Accepted overlays are centrally recorded per individual invitation;
  // never read the sender's SQLite database or expose source event IDs.
  const shares = identityDatabase.prepare([
    'SELECT share.id AS shareId, sender.display_name AS sharedBy,',
    'share.title, share.date, share.end_date AS endDate,',
    'share.time, share.end_time AS endTime',
    'FROM event_share_grants share',
    'JOIN household_registry recipient ON recipient.id = share.recipient_household_id',
    'JOIN household_registry sender ON sender.id = share.source_household_id',
    "WHERE recipient.storage_id = ? AND share.status = 'accepted'",
    'AND recipient.disabled = 0 AND sender.disabled = 0',
    'AND share.date <= ? AND COALESCE(share.end_date,share.date) >= ?',
    'ORDER BY share.date, share.time, share.id LIMIT ?',
  ].join(' ')).all(householdId, toDate, fromDate, MAX_EVENTS + 1)
  if (own.length + shares.length > MAX_EVENTS)
    throw new Error('Arney calendar lookup result limit exceeded.')

  // Conservative flag: a recurring series starting before the end of the
  // requested window might have occurrences not represented below. Never
  // silently claim a complete schedule until recurrence expansion is audited.
  const recurringSeriesNotExpanded = Boolean(sourceDatabase.prepare([
    'SELECT 1 FROM events WHERE date <= ?',
    "AND repeat_unit IS NOT NULL AND repeat_unit != '' AND repeat_unit != 'none'",
    'LIMIT 1',
  ].join(' ')).get(toDate))

  const events = [
    ...own.map(row => ({ source: 'household', ...row })),
    ...shares.map(row => ({ source: 'accepted_invitation', ...row })),
  ].sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.time ?? '').localeCompare(b.time ?? '') ||
    a.title.localeCompare(b.title)
  )
  return {
    ...range, scope: 'selected_household', readOnly: true,
    recurringSeriesNotExpanded, events,
  }
}
