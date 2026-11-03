// Read-only production DB access; backups go to a new recovery directory.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {DatabaseSync, backup} from 'node:sqlite'
const [mode, source, root, testDb, liveUploads, testUploads] = process.argv.slice(2)
if (!['backup','verify'].includes(mode) || !testUploads) throw Error('Invalid database verification arguments')
const real = file => fs.realpathSync(file).toLowerCase()
if (real(source) === real(testDb) || real(liveUploads) === real(testUploads)) throw Error('LIVE and TEST storage must be independent')
const tables = ['events','people','lists','list_items','recipes','meal_plan_items','family_users','family_sessions']
function inspect(file) {
  const db = new DatabaseSync(file, {readOnly:true})
  try {
    const checks = db.prepare('PRAGMA integrity_check').all()
    if (checks.length !== 1 || checks[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw Error('SQLite integrity failed')
    const counts = {}
    for (const table of tables) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) counts[table] = db.prepare('SELECT count(*) AS n FROM "'+table+'"').get().n
    }
    return counts
  } finally { db.close() }
}
if (mode === 'backup') {
  const dest = path.join(root, 'calendar.db')
  if (fs.existsSync(dest)) throw Error('Backup destination must be new')
  const db = new DatabaseSync(source, {readOnly:true})
  try { await backup(db, dest) } finally { db.close() }
  const restore = dest+'.restore-check'
  fs.copyFileSync(dest, restore, fs.constants.COPYFILE_EXCL)
  const counts = inspect(dest)
  inspect(restore)
  const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  if (hash(dest) !== hash(restore)) throw Error('Independent restore copy mismatch')
  fs.writeFileSync(path.join(root,'counts.json'), JSON.stringify(counts), {flag:'wx'})
  console.log('LIVE_SQLITE_BACKUP_AND_ISOLATED_RESTORE=PASS')
} else {
  const expected = JSON.parse(fs.readFileSync(path.join(root,'counts.json'),'utf8'))
  const actual = inspect(source)
  for (const [table, count] of Object.entries(expected)) if (actual[table] !== count) throw Error('Existing row count changed: '+table)
  console.log('LIVE_SQLITE_INTEGRITY_AND_EXISTING_COUNTS=PASS')
}
