// Synthetic, isolated startup controls only. No production services are
// started, and only temporary SQLite/storage paths are used.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'
import {
  planApprovedPrivateHouseholdStartup, assertPrivateStartupLocksClear,
  launchApprovedPrivateHouseholdBackends,
} from '../Server/private-approved-household-startup.mjs'

const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'Server')

function fakeCentral({ pendingApprovals = 0, approved = [], activeOwners = true } = {}) {
  return {
    prepare(sql) {
      if (sql.startsWith('SELECT h.storage_id AS householdId')) {
        return { all: () => approved.map(id => ({ householdId: id })) }
      }
      if (sql.startsWith('SELECT 1 AS allowed')) {
        return { get: () => activeOwners ? { allowed: 1 } : undefined }
      }
      if (sql.startsWith('SELECT COUNT(*) AS n FROM private_activated_households')) {
        return { get: () => ({ n: pendingApprovals }) }
      }
      if (sql.startsWith('SELECT id FROM household_registry')) {
        return { get: id => ['family-a', 'family-b', ...approved].includes(id)
          ? { id: 1 } : undefined }
      }
      throw new Error('Unexpected synthetic central query: ' + sql)
    },
  }
}

function withStorage(action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-approved-startup-test-'))
  try {
    const storageRoot = path.join(root, 'private')
    fs.mkdirSync(storageRoot)
    for (const householdId of ['family-a', 'family-b']) {
      provisionEmptyHousehold({ serverDirectory, storageRoot, householdId })
    }
    return action({ storageRoot })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('only configured fixture families and centrally approved active new owners may boot', () =>
  withStorage(({ storageRoot }) => {
    const values = { identityDatabase: fakeCentral(), serverDirectory, storageRoot }
    const plan = planApprovedPrivateHouseholdStartup(values)
    assert.deepEqual(plan.householdIds, ['family-a', 'family-b'])
    assert(Object.isFrozen(plan) && Object.isFrozen(plan.householdIds))
    assert.throws(() => planApprovedPrivateHouseholdStartup({
      ...values, baselineHouseholdIds: ['family-a', 'family-aaaaaaaaaaaaaaaaaaaaaaaa'],
    }), /Unreviewed baseline/)
    assert.throws(() => planApprovedPrivateHouseholdStartup({
      ...values, identityDatabase: fakeCentral({ pendingApprovals: 1 }),
    }), /inactive or inconsistent ownership/)
    const newId = 'family-' + 'a'.repeat(24)
    assert.throws(() => planApprovedPrivateHouseholdStartup({
      ...values, identityDatabase: fakeCentral({ approved: [newId], pendingApprovals: 1,
        activeOwners: false }),
    }), /inactive or inconsistent ownership/)
    assert.throws(() => planApprovedPrivateHouseholdStartup({
      ...values, identityDatabase: fakeCentral({ approved: [newId], pendingApprovals: 1 }),
    }), /ENOENT|household|metadata/i, 'Missing provisioned disk must stop startup')
  }))

test('stale backend and gateway writer markers block restart; locks are never cleared', () =>
  withStorage(({ storageRoot }) => {
    const args = { serverDirectory, storageRoot, householdIds: ['family-a', 'family-b'] }
    assert.deepEqual(assertPrivateStartupLocksClear(args),
      { locksClear: true, recoveryApproved: false })
    const backendLock = path.join(storageRoot, 'households', 'family-a',
      '.family-calendar-private-backend-writer.lock')
    fs.mkdirSync(backendLock)
    assert.throws(() => assertPrivateStartupLocksClear(args), /backend lock still exists/)
    assert(fs.existsSync(backendLock))
    fs.rmdirSync(backendLock)
    const gatewayLock = path.join(storageRoot, '.family-calendar-private-gateway-writer.lock')
    fs.mkdirSync(gatewayLock)
    assert.throws(() => assertPrivateStartupLocksClear(args), /gateway lock still exists/)
    assert(fs.existsSync(gatewayLock))
  }))

test('healthy launch has independent 256-bit secrets, unique private ports and exact child handles', async () => {
  const plan = Object.freeze({ householdIds: Object.freeze([
    'family-a', 'family-b', 'family-' + 'a'.repeat(24),
  ]) })
  const seen = []
  let nextPort = 48210
  const result = await launchApprovedPrivateHouseholdBackends({
    plan, usedPorts: new Set([48209]),
    allocateLoopbackPort: async () => nextPort++,
    launchBackend: async ({ householdId, port, upstreamToken }) => {
      seen.push([householdId, port, upstreamToken])
      return { householdId, child: { pid: 123 } }
    },
    awaitHealthyBackend: async () => {},
    stopBackend: async () => { throw new Error('Should not stop healthy backend') },
    previousTokens: { 'family-a': 'a'.repeat(64) },
  })
  assert.equal(result.backends.length, 3)
  assert.deepEqual(Object.keys(result.backendPorts), plan.householdIds)
  assert.deepEqual(Object.values(result.backendPorts), [48210, 48211, 48212])
  assert.equal(new Set(Object.values(result.backendTokens)).size, 3)
  assert.equal(seen.length, 3)
  for (const [householdId, port, secret] of seen) {
    assert(Number.isInteger(port))
    assert.match(secret, /^[a-f0-9]{64}$/)
    assert.equal(result.backendTokens[householdId], secret)
  }
})

test('failed or unsafe child startup is rolled back using captured handles only', async () => {
  const plan = Object.freeze({ householdIds: Object.freeze(['family-a', 'family-b']) })
  const stopped = []
  const options = {
    plan, usedPorts: new Set(),
    allocateLoopbackPort: async () => 48300,
    launchBackend: async ({ householdId }) => ({ householdId, child: { pid: 123 } }),
    awaitHealthyBackend: async () => {},
    stopBackend: async backend => { stopped.push(backend.householdId) },
  }
  await assert.rejects(launchApprovedPrivateHouseholdBackends(options),
    /unsafe or reused port/)
  assert.deepEqual(stopped, ['family-a'])
  stopped.length = 0
  await assert.rejects(launchApprovedPrivateHouseholdBackends({
    ...options, usedPorts: new Set(),
    allocateLoopbackPort: async used => {
      const port = 48300 + used.size
      used.add(port)
      return port
    },
    awaitHealthyBackend: async backend => {
      if (backend.householdId === 'family-b') throw new Error('Unhealthy private backend.')
    },
  }), /Unhealthy private backend/)
  assert.deepEqual(stopped, ['family-b', 'family-a'])
  await assert.rejects(launchApprovedPrivateHouseholdBackends({
    ...options, usedPorts: new Set(),
    allocateLoopbackPort: async () => 3001,
  }), /unsafe or reused port/)
})

test('cannot claim successful cleanup if the captured child refused to exit', async () => {
  const plan = Object.freeze({ householdIds: Object.freeze(['family-a', 'family-b']) })
  await assert.rejects(launchApprovedPrivateHouseholdBackends({
    plan, usedPorts: new Set(),
    allocateLoopbackPort: async used => 48400 + used.size,
    launchBackend: async ({ householdId }) => ({ householdId, child: { pid: 123 } }),
    awaitHealthyBackend: async backend => {
      if (backend.householdId === 'family-b') throw new Error('Backend failed.')
    },
    stopBackend: async backend => {
      if (backend.householdId === 'family-b') throw new Error('Unverified process exit.')
    },
  }), error => error instanceof AggregateError &&
    /shutdown is unverified/.test(error.message) &&
    error.errors.length === 2)
})
