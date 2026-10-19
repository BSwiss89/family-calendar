import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHouseholdMembershipTables, registerHousehold } from '../Server/household-memberships.mjs'
import {
  createPrivatePaidApiBudgetTables, setPrivatePaidApiMonthlyLimit,
  privatePaidApiBudgetStatus, reservePrivatePaidApiMaximum,
  settleVerifiedPrivatePaidApiCharge,
} from '../Server/private-paid-api-budget.mjs'

const at = new Date('2026-10-19T12:00:00Z')
function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  createHouseholdMembershipTables(db)
  registerHousehold(db, { householdId: 'family-a', displayName: 'Family A' })
  registerHousehold(db, { householdId: 'family-b', displayName: 'Family B' })
  createPrivatePaidApiBudgetTables(db)
  createPrivatePaidApiBudgetTables(db)
  return db
}
const status = (db, id = 'family-a', time = at) =>
  privatePaidApiBudgetStatus(db, { householdId: id, at: time })
const reserve = (db, max, id = 'family-a', kind = 'cloud_ai', time = at) =>
  reservePrivatePaidApiMaximum(db, { householdId: id, kind, maxChargeMicros: max, at: time })
const limit = (db, id, val) =>
  setPrivatePaidApiMonthlyLimit(db, { householdId: id, monthlyLimitMicros: val })
const settle = (db, id, reservationId, val, verified = true) =>
  settleVerifiedPrivatePaidApiCharge(db, {
    householdId: id, reservationId, actualChargeMicros: val, verifiedProviderCharge: verified,
  })

test('separate paid budget defaults to zero, with no holds', t => {
  const db = fixture(t)
  assert.deepEqual(status(db), {
    periodUtc: '2026-10', currency: 'USD', monthlyLimitMicros: 0,
    billedMicros: 0, heldMicros: 0, pendingReservations: 0, remainingMicros: 0,
  })
  assert.equal(reserve(db, 1).allowed, false)
  assert.equal(status(db).pendingReservations, 0)
})

test('hard cap shared by cloud AI and web; one household cannot use another allowance', t => {
  const db = fixture(t)
  limit(db, 'family-a', 1_000_000)
  limit(db, 'family-b', 500_000)
  assert.equal(reserve(db, 700_000).allowed, true)
  assert.equal(reserve(db, 300_001, 'family-a', 'web_search').allowed, false)
  assert.equal(reserve(db, 300_000, 'family-a', 'web_search').allowed, true)
  assert.equal(reserve(db, 1).allowed, false)
  assert.equal(reserve(db, 500_000, 'family-b', 'web_search').allowed, true)
  assert.deepEqual([status(db).heldMicros, status(db).billedMicros,
    status(db).remainingMicros, status(db).pendingReservations], [1_000_000, 0, 0, 2])
  assert.equal(status(db, 'family-b').heldMicros, 500_000)
})

test('uncertain billing holds full max; cross-family, unverified and excessive settlement refused', t => {
  const db = fixture(t)
  limit(db, 'family-a', 1_000_000)
  const r = reserve(db, 900_000)
  assert.equal(reserve(db, 100_001).allowed, false)
  assert.throws(() => settle(db, 'family-a', r.reservationId, 100_000, false), /verified provider/)
  assert.throws(() => settle(db, 'family-b', r.reservationId, 100_000), /unavailable/)
  assert.throws(() => settle(db, 'family-a', r.reservationId, 900_001), /exceeds reserved/)
  assert.equal(status(db).heldMicros, 900_000)
  assert.deepEqual(settle(db, 'family-a', r.reservationId, 100_000),
    { settled: true, billedMicros: 100_000 })
  assert.deepEqual([status(db).heldMicros, status(db).billedMicros,
    status(db).remainingMicros], [0, 100_000, 900_000])
  assert.equal(reserve(db, 900_000).allowed, true)
})

test('idempotent provider receipts cannot change; verified zero frees reservation', t => {
  const db = fixture(t)
  limit(db, 'family-a', 100)
  const r = reserve(db, 50)
  settle(db, 'family-a', r.reservationId, 0)
  settle(db, 'family-a', r.reservationId, 0)
  assert.throws(() => settle(db, 'family-a', r.reservationId, 1), /Conflicting/)
  assert.equal(status(db).remainingMicros, 100)
  assert.equal(status(db).pendingReservations, 0)
})

test('UTC month rollover preserves old holds and lowering a limit never resets usage', t => {
  const db = fixture(t)
  limit(db, 'family-a', 500)
  const oldTime = new Date('2026-10-31T23:59:59Z')
  const november = new Date('2026-11-01T00:00:00Z')
  const old = reserve(db, 500, 'family-a', 'cloud_ai', oldTime)
  assert.equal(reserve(db, 500, 'family-a', 'web_search', november).allowed, true)
  limit(db, 'family-a', 100)
  assert.equal(status(db, 'family-a', november).remainingMicros, 0)
  settle(db, 'family-a', old.reservationId, 20)
  assert.equal(status(db, 'family-a', oldTime).billedMicros, 20)
  assert.equal(status(db, 'family-a', november).heldMicros, 500)
  assert.equal(reserve(db, 1, 'family-a', 'web_search', november).allowed, false)
})

test('invalid amount, category, date, household and limit fail closed', t => {
  const db = fixture(t)
  limit(db, 'family-a', 100)
  for (const v of [-1, 0, 0.5, '1', Number.MAX_SAFE_INTEGER])
    assert.throws(() => reserve(db, v), /Invalid USD/)
  assert.throws(() => reserve(db, 1, 'family-a', 'unreviewed'), /Invalid paid API/)
  assert.throws(() => reserve(db, 1, 'unknown-family'), /not active/)
  assert.throws(() => status(db, 'family-a', new Date('invalid')), /Invalid paid API usage period/)
  assert.throws(() => limit(db, 'family-a', 100_000_000_001), /Invalid USD/)
  db.prepare("UPDATE household_registry SET disabled=1 WHERE storage_id='family-b'").run()
  assert.throws(() => status(db, 'family-b'), /not active/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM private_paid_api_reservations').get().n, 0)
})
