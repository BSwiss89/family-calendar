// Boot two REAL Family Calendar Node servers against separate EMPTY household
// SQLite databases and uploads. All listeners are 127.0.0.1 on random ports;
// neither live nor existing preview database is read or modified.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Server')
const entry = path.join(serverDirectory, 'index.mjs')
const forbiddenPorts = new Set([3001, 13001, 13002, 13003, 11434])

async function findTestPort(exclude = new Set()) {
  for (let tries = 0; tries < 20; tries++) {
    const server = createServer()
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve(server.address().port))
    })
    await new Promise(resolve => server.close(resolve))
    if (!forbiddenPorts.has(port) && !exclude.has(port)) return port
  }
  throw new Error('No free and safe loopback test port was found.')
}

function startProcess(storageRoot, householdId, port) {
  const child = spawn(process.execPath, [entry], {
    cwd: path.dirname(serverDirectory),
    windowsHide: true,
    env: {
      ...process.env,
      FAMILY_CALENDAR_HOST: '127.0.0.1',
      FAMILY_CALENDAR_PORT: String(port),
      FAMILY_CALENDAR_AUTH_MODE: 'disabled',
      FAMILY_CALENDAR_HOUSEHOLD_STORAGE_ROOT: storageRoot,
      FAMILY_CALENDAR_HOUSEHOLD_ID: householdId,
      FAMILY_CALENDAR_HOUSEHOLD_TEST_ONLY: 'YES',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { logs = (logs + chunk.toString('utf8')).slice(-2000) })
  }
  return { child, base: 'http://127.0.0.1:' + port, logs: () => logs }
}

async function waitForHealth(processInfo) {
  for (let retry = 0; retry < 60; retry++) {
    if (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) break
    try {
      const response = await fetch(processInfo.base + '/api/health', {
        signal: AbortSignal.timeout(1000),
        cache: 'no-store',
      })
      if (response.ok && (await response.json()).status === 'ok') return
    } catch { /* server may still be starting */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('Isolated household server never became healthy: ' + processInfo.logs())
}

async function requestJson(base, endpoint, body = null) {
  const response = await fetch(base + endpoint, {
    method: body == null ? 'GET' : 'POST',
    headers: body == null ? {} : { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  const result = await response.json()
  assert.ok(response.ok, endpoint + ' returned HTTP ' + response.status + ': ' + JSON.stringify(result))
  return result
}

async function stopProcess(processInfo) {
  if (!processInfo) return
  const { child } = processInfo
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill()
  const finished = await Promise.race([
    exited.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 5000)),
  ])
  assert.equal(finished, true, 'Failed to stop disposable household server.')
}

test('two actual loopback API servers never mix calendar data, lists, or uploaded files', {
  timeout: 40000,
}, async () => {
  assert.equal(fs.existsSync(entry), true, 'Real calendar Node entry not found.')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-household-instances-'))
  const storageRoot = path.join(work, 'isolated-storage')
  fs.mkdirSync(storageRoot)
  const running = []
  try {
    const familyA = provisionEmptyHousehold({ serverDirectory, storageRoot, householdId: 'family-a' })
    const familyB = provisionEmptyHousehold({ serverDirectory, storageRoot, householdId: 'family-b' })
    const portA = await findTestPort()
    const portB = await findTestPort(new Set([portA]))
    const first = startProcess(storageRoot, 'family-a', portA)
    const second = startProcess(storageRoot, 'family-b', portB)
    running.push(first, second)
    await Promise.all([waitForHealth(first), waitForHealth(second)])
    assert.deepEqual(await requestJson(first.base, '/api/events'), [])
    assert.deepEqual(await requestJson(second.base, '/api/events'), [])

    await requestJson(first.base, '/api/events', { date: '2026-12-20', title: 'ONLY family A', time: '12:00' })
    await requestJson(second.base, '/api/events', { date: '2026-12-21', title: 'ONLY family B', time: '13:00' })
    const eventsA = await requestJson(first.base, '/api/events')
    const eventsB = await requestJson(second.base, '/api/events')
    assert.equal(eventsA.length, 1)
    assert.equal(eventsB.length, 1)
    assert.equal(eventsA[0].title, 'ONLY family A')
    assert.equal(eventsB[0].title, 'ONLY family B')
    // Both families can have event ID=1; identifiers cannot cross the boundary.
    assert.equal(eventsA[0].id, eventsB[0].id)
    const missingFromB = await fetch(second.base + '/api/events/' + eventsA[0].id, {
      method: 'DELETE',
    })
    // IDs alone are not unique across families, so deleting an ID in a different
    // *process* would delete that family's event. The future authenticated gateway
    // must never route a family A request to family B's process.
    assert.equal(missingFromB.status, 200)
    assert.equal((await requestJson(second.base, '/api/events')).length, 0)
    assert.equal((await requestJson(first.base, '/api/events')).length, 1)

    await requestJson(first.base, '/api/lists', { name: 'ONLY family A shopping' })
    await requestJson(second.base, '/api/lists', { name: 'ONLY family B shopping' })
    const listsA = await requestJson(first.base, '/api/lists')
    const listsB = await requestJson(second.base, '/api/lists')
    assert.equal(listsA.length, 1)
    assert.equal(listsB.length, 1)
    assert.equal(listsA[0].name, 'ONLY family A shopping')
    assert.equal(listsB[0].name, 'ONLY family B shopping')

    // The uploaded path is predictable on purpose: bytes must still be isolated
    // even when the filenames match exactly in two households.
    fs.writeFileSync(path.join(familyA.uploadFolder, 'shared-name.txt'), 'family A private photo')
    fs.writeFileSync(path.join(familyB.uploadFolder, 'shared-name.txt'), 'family B private photo')
    const photoA = await fetch(first.base + '/uploads/shared-name.txt')
    const photoB = await fetch(second.base + '/uploads/shared-name.txt')
    assert.equal(photoA.status, 200)
    assert.equal(photoB.status, 200)
    assert.equal(await photoA.text(), 'family A private photo')
    assert.equal(await photoB.text(), 'family B private photo')
    console.log('[PASS] Two real Calendar Node processes used separate household databases and uploads.')
    console.log('[PASS] Events, lists, and identically named uploaded files remain physically separate.')
    console.log('[PASS] Both listeners were private loopback ports, not production or preview.')
  } finally {
    const failures = []
    for (const processInfo of running) {
      try {
        await stopProcess(processInfo)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 0) {
      fs.rmSync(work, { recursive: true, force: true })
    } else {
      console.error('Disposable test folder retained for safe inspection: ' + work)
      throw failures[0]
    }
  }
})
