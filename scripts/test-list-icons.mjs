import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { LIST_ICON_IDS, normalizeListIcon, ensureListIcons } from '../Server/list-icons.mjs'

test('list icon values are finite and do not include heart', () => {
  assert.ok(LIST_ICON_IDS.includes('balloons'))
  assert.equal(LIST_ICON_IDS.includes('heart'), false)
  assert.equal(new Set(LIST_ICON_IDS).size, LIST_ICON_IDS.length)
  assert.equal(normalizeListIcon('balloons'), 'balloons')
  assert.equal(normalizeListIcon(null), null)
  assert.equal(normalizeListIcon(undefined), null)
  assert.throws(() => normalizeListIcon('💝'), RangeError)
  assert.throws(() => normalizeListIcon('heart'), RangeError)
  assert.throws(() => normalizeListIcon({}), RangeError)
})
test('idempotent additive icon migration does not alter existing lists or items', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("CREATE TABLE lists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP) STRICT; CREATE TABLE list_items (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL, text TEXT NOT NULL) STRICT; INSERT INTO lists(id,name) VALUES (10,'My custom list'); INSERT INTO list_items(id,list_id,text) VALUES (12,10,'kept item')")
    ensureListIcons(db)
    ensureListIcons(db)
    assert.equal(db.prepare('SELECT icon FROM lists WHERE id=10').get().icon, null)
    db.prepare('UPDATE lists SET icon=? WHERE id=10').run('balloons')
    assert.deepEqual({ ...db.prepare('SELECT id,name,icon FROM lists WHERE id=10').get() }, { id:10, name:'My custom list', icon:'balloons' })
    assert.equal(db.prepare('SELECT text FROM list_items WHERE id=12').get().text, 'kept item')
    assert.equal(db.prepare('PRAGMA table_info(lists)').all().filter(col => col.name === 'icon').length, 1)
  } finally { db.close() }
})
