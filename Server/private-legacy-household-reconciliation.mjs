// DEVELOPMENT-ONLY, read-only legacy-to-household data reconciliation.
// Compare a separately prepared OFFLINE legacy backup against an isolated
// household candidate AFTER migration. Does not acquire a live backup, start
// services, import accounts or authorize a TEST/LIVE cutover.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { resolveHouseholdStorage } from './household-storage.mjs'

const LEGACY_MARKER = '.family-calendar-legacy-offline-review.json'
const MAX_ROWS_PER_TABLE = 250000
const MAX_UPLOAD_FILES = 20000

function reject(message) {
  throw new Error('Offline legacy reconciliation refused: ' + message)
}

function inside(parent, target) {
  const relative = path.relative(parent, target)
  return relative === '' || (relative !== '..' &&
    !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}

function realDirectory(name) {
  if (typeof name !== 'string' || !path.isAbsolute(name)) {
    reject('absolute staging paths are required.')
  }
  if (fs.lstatSync(name).isSymbolicLink()) reject('staging links are forbidden.')
  const real = fs.realpathSync(name)
  if (!fs.statSync(real).isDirectory()) reject('staging root must be a directory.')
  return real
}

function file(root, relative) {
  const full = path.join(root, relative)
  const stat = fs.lstatSync(full)
  if (!stat.isFile() || stat.isSymbolicLink() ||
      !inside(root, fs.realpathSync(full))) reject('unsafe staging file.')
  return full
}

function directory(root, relative) {
  const full = path.join(root, relative)
  const stat = fs.lstatSync(full)
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      !inside(root, fs.realpathSync(full))) reject('unsafe staging directory.')
  return full
}

function exactNames(folder, expected) {
  const actual = fs.readdirSync(folder).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    reject('incomplete or unexpected offline staging files.')
  }
}

function digest(filename) {
  const fd = fs.openSync(filename, 'r')
  const h = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (n === 0) break
      h.update(buffer.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

function uploads(root, folder) {
  const found = []
  function walk(relative) {
    const current = directory(root, relative)
    for (const name of fs.readdirSync(current).sort()) {
      const entry = path.join(relative, name)
      const stats = fs.lstatSync(path.join(root, entry))
      if (stats.isSymbolicLink()) reject('upload links are forbidden.')
      if (stats.isDirectory()) {
        walk(entry)
      } else if (stats.isFile()) {
        found.push({
          relative: path.relative(path.join(root, folder), path.join(root, entry))
            .split(path.sep).join('/'),
          sha256: digest(file(root, entry)),
        })
      } else {
        reject('unsupported upload file type.')
      }
      if (found.length > MAX_UPLOAD_FILES) reject('too many uploaded files.')
    }
  }
  walk(folder)
  return found
}

function sqliteCheck(db) {
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    reject('SQLite integrity or foreign-key check failed.')
  }
}

function tables(db) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(row => row.name)
}

function quote(name) {
  return '"' + name.replaceAll('"', '""') + '"'
}

function columns(db, table) {
  return db.prepare('PRAGMA table_info(' + quote(table) + ')').all()
    .map(c => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }))
}

function cell(value) {
  if (value === null) return ['null']
  if (typeof value === 'bigint') return ['integer', value.toString()]
  if (typeof value === 'number') return ['number', value]
  if (typeof value === 'string') return ['text', value]
  if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('base64')]
  reject('unsupported SQLite value type.')
}

function signatures(db, table, names) {
  const query = 'SELECT ' + names.map(quote).join(', ') + ' FROM ' + quote(table)
  const output = []
  for (const row of db.prepare(query).iterate()) {
    if (output.length >= MAX_ROWS_PER_TABLE) reject('table exceeds comparison limit.')
    const values = names.map(name => cell(row[name]))
    output.push(createHash('sha256').update(JSON.stringify(values)).digest('hex'))
  }
  return output.sort()
}

/**
 * The operator must separately acquire an offline, checkpointed backup and
 * place it in legacyRoot/{data/calendar.db,uploads/,marker}. The isolated
 * household must already be provisioned; this function NEVER creates either.
 * Only already-existing files are opened, SQLite read-only.
 */
export function reconcileOfflineLegacyHousehold({
  serverDirectory, legacyRoot, householdStorageRoot, householdId,
}) {
  const checkout = path.dirname(fs.realpathSync(serverDirectory))
  const source = realDirectory(legacyRoot)
  const stage = realDirectory(householdStorageRoot)
  if (inside(checkout, source) || inside(checkout, stage) ||
      inside(source, stage) || inside(stage, source)) {
    reject('staging must be separate and outside the application checkout.')
  }
  exactNames(source ? directory(source, '.') : source,
    [LEGACY_MARKER, 'data', 'uploads'])
  const marker = JSON.parse(fs.readFileSync(file(source, LEGACY_MARKER), 'utf8'))
  if (marker?.kind !== 'legacy-calendar-offline-review' || marker?.version !== 1) {
    reject('explicit offline legacy staging marker required.')
  }
  exactNames(directory(source, 'data'), ['calendar.db'])
  directory(source, 'uploads')
  const sourceFile = file(source, 'data/calendar.db')
  const target = resolveHouseholdStorage({
    serverDirectory, storageRoot: stage, householdId,
  })
  exactNames(directory(stage, path.join('households', householdId, 'data')),
    ['calendar.db'])
  const targetFile = target.databasePath
  if (fs.realpathSync(sourceFile) === fs.realpathSync(targetFile)) {
    reject('source and candidate databases must differ.')
  }

  const original = new DatabaseSync(sourceFile, { readOnly: true })
  const migrated = new DatabaseSync(targetFile, { readOnly: true })
  let tableCount = 0
  let recordCount = 0
  try {
    sqliteCheck(original)
    sqliteCheck(migrated)
    const originalTables = tables(original)
    const candidateTables = new Set(tables(migrated))
    if (!originalTables.includes('events') || !originalTables.includes('people')) {
      reject('required legacy calendar tables are missing.')
    }
    for (const table of originalTables) {
      if (!candidateTables.has(table)) reject('legacy table missing from candidate.')
      const oldColumns = columns(original, table)
      const newer = columns(migrated, table)
      if (!oldColumns.every(c => newer.some(n =>
        n.name === c.name && n.type === c.type &&
        n.notnull === c.notnull && n.pk === c.pk))) {
        reject('legacy table column changed.')
      }
      const names = oldColumns.map(c => c.name)
      const before = signatures(original, table, names)
      const after = signatures(migrated, table, names)
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        reject('existing row values or counts changed in ' + table + '.')
      }
      tableCount++
      recordCount += before.length
    }
  } finally {
    migrated.close()
    original.close()
  }

  const legacyUploads = uploads(source, 'uploads')
  const migratedUploads = uploads(
    stage, path.join('households', householdId, 'uploads'))
  if (JSON.stringify(legacyUploads) !== JSON.stringify(migratedUploads)) {
    reject('uploaded files are missing or modified.')
  }
  return {
    ok: true,
    originalTablesChecked: tableCount,
    originalRecordsPreserved: recordCount,
    uploadFilesPreserved: legacyUploads.length,
    productionDeploymentAuthorized: false,
  }
}
