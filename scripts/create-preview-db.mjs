// Create one isolated preview database from the separate TEST database, never from LIVE.
// Usage: node scripts/create-preview-db.mjs <test-db-path> <preview-db-path>
// Runs only when the preview DB does not yet exist.

import { DatabaseSync, backup } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const [sourcePath, targetPath] = process.argv.slice(2)
if (!sourcePath || !targetPath) {
  throw new Error('Expected source and destination database paths.')
}

const source = path.resolve(sourcePath)
const target = path.resolve(targetPath)
const pathKey = (value) => value.toLowerCase()
const expectedTest = path.resolve(process.env.USERPROFILE ?? '', 'Projects', 'family-calendar-test', 'Server', 'data', 'calendar.db')
const expectedPreview = path.resolve(process.env.USERPROFILE ?? '', 'Projects', 'family-calendar-preview', 'Server', 'data', 'calendar.db')
if (pathKey(source) !== pathKey(expectedTest) || pathKey(target) !== pathKey(expectedPreview)) {
  throw new Error('Refusing database paths outside the isolated TEST and PREVIEW folders.')
}
if (!fs.existsSync(source)) {
  throw new Error('The separate testing database is missing. Live data will not be used.')
}
if (fs.existsSync(target)) {
  console.log('Keeping existing isolated preview database.')
  process.exit(0)
}

fs.mkdirSync(path.dirname(target), { recursive: true })
const temporary = target + '.creating-' + process.pid
let succeeded = false
try {
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    await backup(db, temporary)
  } finally {
    db.close()
  }
  const check = new DatabaseSync(temporary, { readOnly: true })
  try {
    const result = check.prepare('PRAGMA integrity_check').get()
    if (result?.integrity_check !== 'ok') {
      throw new Error('Preview SQLite snapshot failed integrity check.')
    }
  } finally {
    check.close()
  }
  if (fs.existsSync(target)) {
    throw new Error('Preview destination appeared during backup; refusing overwrite.')
  }
  fs.renameSync(temporary, target)
  succeeded = true
  console.log('Created verified, independent preview SQLite database.')
} finally {
  if (!succeeded) {
    fs.rmSync(temporary, { force: true })
  }
}
