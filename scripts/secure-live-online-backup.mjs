// Standalone online SQLite backup for Secure LIVE.
// Preserves the running database, including WAL-backed transactions.
import { backup, DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const [, , sourcePath, destinationPath] = process.argv
if (!sourcePath || !destinationPath) {
  console.error('Usage: node secure-live-online-backup.mjs <source.db> <new-backup.db>')
  process.exit(2)
}
const source = resolve(sourcePath)
const destination = resolve(destinationPath)
if (source === destination || !existsSync(source) || existsSync(destination)) {
  throw new Error('Backup requires an existing source and a NEW destination')
}
const db = new DatabaseSync(source, { readOnly: true })
try {
  await backup(db, destination)
} finally {
  db.close()
}
const restored = new DatabaseSync(destination, { readOnly: true })
try {
  const checks = restored.prepare('PRAGMA integrity_check').all()
  if (checks.length !== 1 || checks[0].integrity_check !== 'ok') {
    throw new Error('SQLite backup integrity verification FAILED')
  }
  console.log('SQLITE ONLINE BACKUP PASS: integrity_check=ok')
  const tables = new Set(
    restored.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((row) => row.name),
  )
  for (const table of ['family_users', 'family_sessions']) {
    if (tables.has(table)) {
      console.log(\`BACKUP_\${table.toUpperCase()}=\${restored.prepare(\`SELECT count(*) AS n FROM \${table}\`).get().n}\`)
    }
  }
} finally {
  restored.close()
}
