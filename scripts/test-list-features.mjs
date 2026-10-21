import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  normalizeListCategory, ensureListItemCategories,
} from '../Server/list-features.mjs'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE lists (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT; CREATE TABLE list_items (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE, text TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0) STRICT")
  return db
}

test('category migration is additive, repeatable, and keeps old rows', () => {
  const db = fixture()
  try {
    db.prepare('INSERT INTO lists (name) VALUES (?)').run('Weekly groceries')
    db.prepare('INSERT INTO list_items (list_id, text, completed, sort_order) VALUES (1, ?, 1, 1)').run('Milk')
    ensureListItemCategories(db)
    ensureListItemCategories(db)
    assert.deepEqual({ ...db.prepare('SELECT text, completed, category FROM list_items').get() }, {
      text:'Milk', completed:1, category:'General',
    })
  } finally { db.close() }
})

test('category validation accepts custom names and rejects oversized values', () => {
  assert.equal(normalizeListCategory(undefined), 'General')
  assert.equal(normalizeListCategory('  Produce  '), 'Produce')
  assert.equal(normalizeListCategory(' '), 'General')
  assert.throws(() => normalizeListCategory('x'.repeat(41)), RangeError)
  assert.throws(() => normalizeListCategory(7), TypeError)
})
