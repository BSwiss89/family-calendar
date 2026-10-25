// Private, test-only multi-family paid API budget. No paid request route is enabled.
// A future server-trusted adapter must GUARANTEE max billable cost before dispatch.
// Ambiguous/failed/disconnected external requests retain their entire reservation.
// All charges are integer USD micro-dollars (one-millionth of $1).
import { randomUUID } from 'node:crypto'

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const MAX = 100_000_000_000
const KINDS = new Set(['cloud_ai', 'web_search'])

function household(db, slug) {
  if (typeof slug !== 'string' || !SLUG.test(slug))
    throw new Error('Untrusted paid API household.')
  const row = db.prepare(
    'SELECT id FROM household_registry WHERE storage_id=? AND disabled=0'
  ).get(slug)
  if (!row) throw new Error('Private paid API household not active.')
  return row.id
}
function period(at) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime()))
    throw new Error('Invalid paid API usage period.')
  return at.toISOString().slice(0, 7)
}
function amount(value, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > MAX)
    throw new Error('Invalid USD micro-dollar amount.')
  return value
}

export function createPrivatePaidApiBudgetTables(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS private_paid_api_limits (',
    'household_id INTEGER PRIMARY KEY REFERENCES household_registry(id),',
    'monthly_limit_micros INTEGER NOT NULL DEFAULT 0',
    'CHECK(monthly_limit_micros BETWEEN 0 AND 100000000000)',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS private_paid_api_reservations (',
    'reservation_id TEXT PRIMARY KEY,',
    'household_id INTEGER NOT NULL REFERENCES household_registry(id),',
    'period_utc TEXT NOT NULL,',
    "kind TEXT NOT NULL CHECK(kind IN ('cloud_ai','web_search')),",
    'reserved_micros INTEGER NOT NULL CHECK(reserved_micros BETWEEN 1 AND 100000000000),',
    "state TEXT NOT NULL DEFAULT 'held' CHECK(state IN ('held','settled')),",
    'settled_micros INTEGER,',
    "CHECK((state='held' AND settled_micros IS NULL) OR",
    "(state='settled' AND settled_micros BETWEEN 0 AND reserved_micros))",
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS private_paid_api_period_idx',
    'ON private_paid_api_reservations(household_id, period_utc);',
  ].join('\n'))
}

// Trusted offline administration only. This NEVER enables a paid provider.
export function setPrivatePaidApiMonthlyLimit(db, { householdId, monthlyLimitMicros }) {
  const id = household(db, householdId)
  amount(monthlyLimitMicros, true)
  db.prepare([
    'INSERT INTO private_paid_api_limits(household_id,monthly_limit_micros)',
    'VALUES (?,?) ON CONFLICT(household_id) DO UPDATE SET',
    'monthly_limit_micros=excluded.monthly_limit_micros',
  ].join(' ')).run(id, monthlyLimitMicros)
}

export function privatePaidApiBudgetStatus(db, { householdId, at = new Date() }) {
  const id = household(db, householdId)
  const periodUtc = period(at)
  const monthlyLimitMicros = db.prepare(
    'SELECT monthly_limit_micros AS n FROM private_paid_api_limits WHERE household_id=?'
  ).get(id)?.n ?? 0
  const totals = db.prepare([
    'SELECT',
    "COALESCE(SUM(CASE WHEN state='held' THEN reserved_micros ELSE 0 END),0) held,",
    "COALESCE(SUM(CASE WHEN state='settled' THEN settled_micros ELSE 0 END),0) billed,",
    "COALESCE(SUM(CASE WHEN state='held' THEN 1 ELSE 0 END),0) pending",
    'FROM private_paid_api_reservations WHERE household_id=? AND period_utc=?',
  ].join(' ')).get(id, periodUtc)
  const total = totals.held + totals.billed
  if (!Number.isSafeInteger(total)) throw new Error('Unsafe paid API ledger total.')
  return {
    periodUtc, currency: 'USD', monthlyLimitMicros,
    billedMicros: totals.billed, heldMicros: totals.held,
    pendingReservations: totals.pending,
    remainingMicros: Math.max(0, monthlyLimitMicros - total),
  }
}

// Reserve BEFORE any external request; caller must verify a provider-enforced
// worst-case price including output tokens, retries, tools and billing overhead.
// Never use a price estimate supplied by a browser.
export function reservePrivatePaidApiMaximum(db, {
  householdId, kind, maxChargeMicros, at = new Date(),
}) {
  if (!KINDS.has(kind)) throw new Error('Invalid paid API service category.')
  amount(maxChargeMicros)
  period(at)
  db.exec('BEGIN IMMEDIATE')
  try {
    const status = privatePaidApiBudgetStatus(db, { householdId, at })
    if (maxChargeMicros > status.remainingMicros) {
      db.exec('COMMIT')
      return { allowed: false, ...status }
    }
    const id = household(db, householdId), reservationId = randomUUID()
    db.prepare([
      'INSERT INTO private_paid_api_reservations',
      '(reservation_id,household_id,period_utc,kind,reserved_micros)',
      'VALUES (?,?,?,?,?)',
    ].join(' ')).run(reservationId, id, status.periodUtc, kind, maxChargeMicros)
    const updated = privatePaidApiBudgetStatus(db, { householdId, at })
    db.exec('COMMIT')
    return { allowed: true, reservationId, ...updated }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// ONLY verified provider billing may release unused reserved capacity.
// A timeout, missing receipt, callback failure or unknown outcome must keep
// the FULL hold. Conflict or billed amount above max stays quarantined.
export function settleVerifiedPrivatePaidApiCharge(db, {
  householdId, reservationId, actualChargeMicros, verifiedProviderCharge,
}) {
  if (verifiedProviderCharge !== true)
    throw new Error('Settlement requires verified provider billing.')
  amount(actualChargeMicros, true)
  if (typeof reservationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reservationId))
    throw new Error('Invalid private paid API reservation.')
  db.exec('BEGIN IMMEDIATE')
  try {
    const id = household(db, householdId)
    const old = db.prepare([
      'SELECT reserved_micros, settled_micros, state',
      'FROM private_paid_api_reservations',
      'WHERE reservation_id=? AND household_id=?',
    ].join(' ')).get(reservationId, id)
    if (!old) throw new Error('Paid API reservation unavailable.')
    if (actualChargeMicros > old.reserved_micros)
      throw new Error('Provider billing exceeds reserved maximum; quarantine required.')
    if (old.state === 'settled' && old.settled_micros !== actualChargeMicros)
      throw new Error('Conflicting paid API settlement.')
    if (old.state === 'held') db.prepare([
      "UPDATE private_paid_api_reservations SET state='settled',settled_micros=?",
      "WHERE reservation_id=? AND household_id=? AND state='held'",
    ].join(' ')).run(actualChargeMicros, reservationId, id)
    db.exec('COMMIT')
    return { settled: true, billedMicros: actualChargeMicros }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
