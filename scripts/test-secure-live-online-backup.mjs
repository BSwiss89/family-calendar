import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const helper = fileURLToPath(new URL('./secure-live-online-backup.mjs', import.meta.url))

test('online backup copies valid SQLite and refuses overwrite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fc-secure-live-backup-'))
  try {
    const source = join(directory, 'source.db')
    const destination = join(directory, 'backup.db')
    const db = new DatabaseSync(source)
    try {
      db.exec('CREATE TABLE family_users (id INTEGER PRIMARY KEY); INSERT INTO family_users (id) VALUES (1);')
      db.exec('CREATE TABLE family_sessions (id INTEGER PRIMARY KEY); INSERT INTO family_sessions (id) VALUES (1);')
    } finally { db.close() }
    const created = spawnSync(process.execPath, [helper, source, destination], { encoding: 'utf8' })
    assert.equal(created.status, 0, created.stderr)
    assert.match(created.stdout, /SQLITE ONLINE BACKUP PASS/)
    const backup = new DatabaseSync(destination, { readOnly: true })
    try {
      assert.equal(backup.prepare('SELECT count(*) AS n FROM family_users').get().n, 1)
      assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    } finally { backup.close() }
    const again = spawnSync(process.execPath, [helper, source, destination], { encoding: 'utf8' })
    assert.notEqual(again.status, 0, 'Must refuse to overwrite a previous backup')
    assert.equal(existsSync(destination), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
