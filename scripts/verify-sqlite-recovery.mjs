// Verifies recoverability of a fresh backup without writing to the live database.
// Uses Node 24's built-in SQLite online backup API. Does not start/stop any server.
import { DatabaseSync, backup } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

const root = process.env.USERPROFILE ?? os.homedir()
const liveDb = path.join(root, 'Projects', 'family-calendar', 'Server', 'data', 'calendar.db')
const backupFolder = path.join(root, 'Projects', 'family-calendar-release-backups', 'sqlite')
const requiredTables = ['events', 'people', 'lists', 'list_items', 'recipes', 'meal_plan_items']
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const runId = stamp + '-' + randomUUID().slice(0, 8)
const snapshot = path.join(backupFolder, 'calendar-' + runId + '.db')
const restored = path.join(backupFolder, 'restore-test-' + runId + '.db')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function fileSha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function verifyDb(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get()
    assert(integrity?.integrity_check === 'ok', 'SQLite integrity_check did not return ok')
    const present = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map(row => row.name)
    )
    for (const table of requiredTables) {
      assert(present.has(table), 'Missing expected table: ' + table)
    }
    const rowCounts = Object.fromEntries(requiredTables.map(table => {
      const count = db.prepare('SELECT COUNT(*) AS n FROM "' + table + '"').get().n
      return [table, count]
    }))
    return { tableCount: present.size, rowCounts }
  } finally {
    db.close()
  }
}

async function main() {
  assert(fs.existsSync(liveDb), 'Live SQLite database is missing')
  fs.mkdirSync(backupFolder, { recursive: true })

  const source = new DatabaseSync(liveDb, { readOnly: true })
  try {
    console.log('Creating consistent SQLite snapshot from the running calendar...')
    await backup(source, snapshot)
  } finally {
    source.close()
  }

  assert(fs.statSync(snapshot).size > 0, 'Online backup produced an empty file')

  // Simulate restoration into an entirely separate file; never overwrite the live DB.
  fs.copyFileSync(snapshot, restored, fs.constants.COPYFILE_EXCL)
  const sourceHash = fileSha256(snapshot)
  assert(fileSha256(restored) === sourceHash, 'Restored file differs from saved backup')

  const saved = verifyDb(snapshot)
  const recovered = verifyDb(restored)
  assert(
    JSON.stringify(saved) === JSON.stringify(recovered),
    'Recovered SQLite schema/table counts differ from the saved snapshot'
  )

  console.log('')
  console.log('SQLITE BACKUP RESTORE TEST PASSED')
  console.log('Restored database integrity: OK')
  console.log('Required application tables: ' + requiredTables.length + ' present')
  console.log('Snapshot size: ' + (fs.statSync(snapshot).size / 1024 / 1024).toFixed(2) + ' MiB')
  console.log('Saved independent recovery snapshot: ' + snapshot)
  console.log('Live database: not replaced or modified')
}

try {
  await main()
} catch (error) {
  console.error('SQLITE BACKUP RESTORE TEST FAILED: ' + error.message)
  console.error('Any saved snapshot has been left in place for inspection.')
  process.exitCode = 1
} finally {
  // The temporary restored copy is disposable; keep the original snapshot for release recovery.
  try {
    fs.rmSync(restored, { force: true })
  } catch (error) {
    console.error('Could not remove temporary restore copy: ' + error.message)
    process.exitCode = 1
  }
}
