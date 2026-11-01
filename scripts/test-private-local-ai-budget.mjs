import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  createHouseholdMembershipTables, registerHousehold,
} from '../Server/household-memberships.mjs'
import {
  createPrivateLocalAiBudgetTables, setPrivateLocalAiMonthlyLimit,
  privateLocalAiBudgetStatus, reservePrivateLocalAiRequest,
} from '../Server/private-local-ai-budget.mjs'

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  createHouseholdMembershipTables(db)
  registerHousehold(db, { householdId: 'family-a', displayName: 'Family A' })
  registerHousehold(db, { householdId: 'family-b', displayName: 'Family B' })
  createPrivateLocalAiBudgetTables(db)
  createPrivateLocalAiBudgetTables(db)
  return db
}

test('local Ollama requests are disabled until a trusted per-household limit exists', t => {
  const db = fixture(t)
  const request = { householdId: 'family-a', at: new Date('2026-10-19T12:00:00Z') }
  assert.deepEqual(privateLocalAiBudgetStatus(db, request), {
    periodUtc: '2026-10', monthlyRequestLimit: 0,
    usedRequests: 0, remainingRequests: 0,
  })
  assert.equal(reservePrivateLocalAiRequest(db, request).allowed, false)
  assert.equal(privateLocalAiBudgetStatus(db, request).usedRequests, 0)
})

test('a strict monthly request cap is independent per household and advances in UTC', t => {
  const db = fixture(t)
  setPrivateLocalAiMonthlyLimit(db, { householdId: 'family-a', monthlyLimit: 2 })
  setPrivateLocalAiMonthlyLimit(db, { householdId: 'family-b', monthlyLimit: 1 })
  const at = new Date('2026-10-31T23:59:59Z')
  assert.equal(reservePrivateLocalAiRequest(db, { householdId: 'family-a', at }).allowed, true)
  assert.equal(reservePrivateLocalAiRequest(db, { householdId: 'family-a', at }).allowed, true)
  assert.equal(reservePrivateLocalAiRequest(db, { householdId: 'family-a', at }).allowed, false)
  assert.deepEqual(privateLocalAiBudgetStatus(db, { householdId: 'family-a', at }), {
    periodUtc: '2026-10', monthlyRequestLimit: 2,
    usedRequests: 2, remainingRequests: 0,
  })
  assert.equal(reservePrivateLocalAiRequest(db, { householdId: 'family-b', at }).allowed, true)
  assert.equal(reservePrivateLocalAiRequest(db, { householdId: 'family-b', at }).allowed, false)
  assert.deepEqual(privateLocalAiBudgetStatus(db, {
    householdId: 'family-a', at: new Date('2026-11-01T00:00:00Z'),
  }), { periodUtc:'2026-11', monthlyRequestLimit: 2,
    usedRequests: 0, remainingRequests: 2 })
})

test('lowering a limit never silently resets historical usage; invalid requests fail closed', t => {
  const db = fixture(t)
  const at = new Date('2026-10-19T12:00:00Z')
  setPrivateLocalAiMonthlyLimit(db, { householdId: 'family-a', monthlyLimit: 3 })
  assert.equal(reservePrivateLocalAiRequest(db, { householdId: 'family-a', at }).allowed, true)
  setPrivateLocalAiMonthlyLimit(db, { householdId: 'family-a', monthlyLimit: 0 })
  assert.equal(reservePrivateLocalAiRequest(db, { householdId: 'family-a', at }).allowed, false)
  assert.deepEqual(privateLocalAiBudgetStatus(db, { householdId: 'family-a', at }), {
    periodUtc: '2026-10', monthlyRequestLimit: 0,
    usedRequests: 1, remainingRequests: 0,
  })
  assert.throws(() => setPrivateLocalAiMonthlyLimit(db, {
    householdId: 'family-b', monthlyLimit: 1001,
  }), /Invalid/)
  assert.throws(() => reservePrivateLocalAiRequest(db, {
    householdId: 'missing-family', at,
  }), /not active/)
  assert.throws(() => privateLocalAiBudgetStatus(db, {
    householdId: 'family-b', at: new Date('bad'),
  }), /Invalid local AI usage period/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM private_local_ai_usage').get().n, 1)
})
