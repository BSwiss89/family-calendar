// Migration preflight: test candidate startup, repeatability, and old-code compatibility
// on a disposable, consistent snapshot of the running household SQLite database.
// NEVER writes to the live DB, uploads, or live source. NEVER binds port 3001.
// This is a strict additive-schema smoke test; destructive/data-rewriting migrations
// require a separate reviewed migration/rollback procedure.
import { DatabaseSync, backup } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const home = process.env.USERPROFILE ?? os.homedir()
const live = path.join(home, 'Projects', 'family-calendar')
const test = path.join(home, 'Projects', 'family-calendar-test')
const liveDb = path.join(live, 'Server', 'data', 'calendar.db')
const candidate = path.join(test, 'Server', 'index.mjs')
const previous = path.join(live, 'Server', 'index.mjs')
const port = 13003
const url = 'http://127.0.0.1:' + port + '/api/health'
const required = ['events', 'people', 'lists', 'list_items', 'recipes', 'meal_plan_items']
const assert = (ok, message) => { if (!ok) throw new Error(message) }
const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds))
const quote = (name) => '"' + name.replaceAll('"', '""') + '"'

function readSchemaAndRows(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get()
    assert(integrity?.integrity_check === 'ok', 'SQLite integrity check failed')
    assert(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'SQLite foreign keys are invalid')
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map(record => record.name)
    const tables = {}
    for (const name of names) {
      const columns = db.prepare('PRAGMA table_info(' + quote(name) + ')').all()
      const originalColumns = columns.map(c => ({
        name: c.name, type: c.type, notnull: c.notnull, pk: c.pk,
      }))
      const selection = columns.map(c => quote(c.name)).join(', ')
      // Sort row signatures so SQLite row order cannot create false failures.
      const rows = db.prepare('SELECT ' + selection + ' FROM ' + quote(name)).all()
      const encoded = rows.map(row => JSON.stringify(row)).sort()
      tables[name] = { columns: originalColumns, rowCount: encoded.length, digest: createHash('sha256').update(encoded.join('\n')).digest('hex') }
    }
    return tables
  } finally {
    db.close()
  }
}

function comparePreservation(before, after, label) {
  for (const table of required) assert(after[table], label + ': missing required table ' + table)
  for (const [name, original] of Object.entries(before)) {
    const updated = after[name]
    assert(updated, label + ': original table disappeared: ' + name)
    for (const column of original.columns) {
      const match = updated.columns.find(c => c.name === column.name)
      assert(match, label + ': original column removed: ' + name + '.' + column.name)
      assert(match.type === column.type && match.notnull === column.notnull && match.pk === column.pk,
        label + ': incompatible original column changed: ' + name + '.' + column.name)
    }
    assert(updated.rowCount >= original.rowCount,
      label + ': table lost existing records: ' + name)
  }
}

function oldColumnsUnchanged(beforeFile, afterFile, tables) {
  const before = new DatabaseSync(beforeFile, { readOnly: true })
  const after = new DatabaseSync(afterFile, { readOnly: true })
  try {
    for (const [name, table] of Object.entries(tables)) {
      const selection = table.columns.map(c => quote(c.name)).join(', ')
      const query = 'SELECT ' + selection + ' FROM ' + quote(name)
      const original = before.prepare(query).all().map(row => JSON.stringify(row)).sort()
      const updated = after.prepare(query).all().map(row => JSON.stringify(row)).sort()
      assert(JSON.stringify(original) === JSON.stringify(updated),
        'Existing records/values changed in ' + name + '; manual review required')
    }
  } finally { before.close(); after.close() }
}

async function isPortOpen() {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(800)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
  })
}

async function runServer(entry, label) {
  assert(!(await isPortOpen()), 'Port ' + port + ' already in use; refusing to test against another server')
  const child = spawn(process.execPath, [entry], {
    cwd: path.dirname(path.dirname(entry)),
    windowsHide: true,
    env: { ...process.env, FAMILY_CALENDAR_HOST: '127.0.0.1', FAMILY_CALENDAR_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    output = (output + data.toString()).slice(-4000)
  })
  try {
    let healthy = false
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) break
      try {
        const result = await fetch(url, { signal: AbortSignal.timeout(1000) })
        if (result.ok && (await result.json()).status === 'ok') {
          healthy = true
          break
        }
      } catch { /* Server not ready yet */ }
      await sleep(250)
    }
    assert(healthy && child.exitCode === null, label + ' did not become healthy. ' + output.slice(-1000))
    console.log('[PASS] ' + label + ' started and answered isolated HTTP health check')
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill()
      await Promise.race([exited, sleep(5000)])
      if (child.exitCode === null) {
        child.kill('SIGKILL')
        await Promise.race([exited, sleep(3000)])
      }
    }
    assert(child.exitCode !== null, label + ' subprocess would not exit; manual investigation required')
  }
}

async function consistentCopy(source, target) {
  const db = new DatabaseSync(source, { readOnly: true })
  try { await backup(db, target) } finally { db.close() }
  assert(fs.existsSync(target) && fs.statSync(target).size > 0, 'SQLite backup is empty')
}

async function main() {
  assert(fs.existsSync(liveDb) && fs.existsSync(candidate) && fs.existsSync(previous),
    'Expected live/test paths missing; no preflight performed')
  assert(fs.existsSync(path.join(test, 'node_modules', 'express')),
    'Test dependencies missing; run update-test.ps1 first')
  assert(fs.existsSync(path.join(test, 'dist', 'index.html')),
    'Test frontend build missing; run update-test.ps1 first')

  const stagingParent = path.join(test, 'logs')
  fs.mkdirSync(stagingParent, { recursive: true })
  const stage = fs.mkdtempSync(path.join(stagingParent, 'migration-smoke-'))
  const snapshot = path.join(stage, 'pre-migration.db')
  const newRoot = path.join(stage, 'candidate')
  const oldRoot = path.join(stage, 'previous')
  try {
    fs.mkdirSync(path.join(newRoot, 'Server', 'data'), { recursive: true })
    fs.mkdirSync(path.join(oldRoot, 'Server', 'data'), { recursive: true })
    fs.mkdirSync(path.join(newRoot, 'dist'), { recursive: true })
    fs.mkdirSync(path.join(oldRoot, 'dist'), { recursive: true })
    // Because the staged folders sit under test/logs, Node resolves imports from test/node_modules.
    for (const [folder, entry] of [[newRoot, candidate], [oldRoot, previous]]) {
      fs.copyFileSync(entry, path.join(folder, 'Server', 'index.mjs'))
      fs.copyFileSync(path.join(test, 'dist', 'index.html'), path.join(folder, 'dist', 'index.html'))
    }

    console.log('Creating temporary SQLite snapshot. The live database remains untouched...')
    await consistentCopy(liveDb, snapshot)
    const baseline = readSchemaAndRows(snapshot)
    for (const table of required) assert(baseline[table], 'Live snapshot missing table: ' + table)
    console.log('[PASS] Snapshot integrity and existing tables')

    const candidateDb = path.join(newRoot, 'Server', 'data', 'calendar.db')
    const previousDb = path.join(oldRoot, 'Server', 'data', 'calendar.db')
    await consistentCopy(snapshot, candidateDb)

    await runServer(path.join(newRoot, 'Server', 'index.mjs'), 'Candidate backend migration')
    comparePreservation(baseline, readSchemaAndRows(candidateDb), 'Candidate migration')
    oldColumnsUnchanged(snapshot, candidateDb, baseline)
    console.log('[PASS] Existing tables, columns and record values preserved')

    await runServer(path.join(newRoot, 'Server', 'index.mjs'), 'Candidate second startup')
    comparePreservation(baseline, readSchemaAndRows(candidateDb), 'Repeated migration')
    oldColumnsUnchanged(snapshot, candidateDb, baseline)
    console.log('[PASS] Candidate migration is repeatable')

    await consistentCopy(candidateDb, previousDb)
    await runServer(path.join(oldRoot, 'Server', 'index.mjs'), 'Previous live backend compatibility')
    comparePreservation(baseline, readSchemaAndRows(previousDb), 'Old backend on migrated DB')
    oldColumnsUnchanged(snapshot, previousDb, baseline)
    console.log('[PASS] Previous backend can start on migrated schema')

    console.log('')
    console.log('ADDITIVE SQLITE MIGRATION PREFLIGHT PASSED')
    console.log('No live files, ports, data, or scheduled tasks were changed.')
    console.log('This preflight alone does NOT authorize automatic schema migration deployments.')
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

await main().catch(error => {
  console.error('SQLITE MIGRATION PREFLIGHT FAILED: ' + error.message)
  process.exitCode = 1
})
