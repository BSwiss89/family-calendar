import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  normalizeListCategory, ensureListItemCategories, duplicateListInDatabase,
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

test('reuse list creates independent items, preserving categories/order while clearing checks', () => {
  const db=fixture()
  try {
    ensureListItemCategories(db)
    db.prepare('INSERT INTO lists (name) VALUES (?)').run('Groceries')
    const ins=db.prepare('INSERT INTO list_items (list_id,text,completed,sort_order,category) VALUES (1,?,?,?,?)')
    ins.run('Milk',1,2,'Dairy')
    ins.run('Apples',0,1,'Produce')
    const reused=duplicateListInDatabase(db,1,'Groceries (Copy)')
    assert.equal(reused?.id,2)
    assert.equal(reused?.copiedItems,2)
    assert.deepEqual(db.prepare('SELECT id,text,category,completed,sort_order FROM list_items WHERE list_id=2 ORDER BY sort_order').all().map(({text,category,completed,sort_order})=>({text,category,completed,sort_order})),[
      {text:'Apples',category:'Produce',completed:0,sort_order:1},
      {text:'Milk',category:'Dairy',completed:0,sort_order:2},
    ])
    assert.equal(db.prepare('SELECT completed FROM list_items WHERE list_id=1 AND text=?').get('Milk').completed,1)
    db.prepare('UPDATE list_items SET text=? WHERE list_id=2 AND text=?').run('Whole milk','Milk')
    assert.equal(db.prepare('SELECT text FROM list_items WHERE list_id=1 AND text=?').get('Milk').text,'Milk')
  } finally {db.close()}
})

test('missing source does not create a new list', () => {
  const db=fixture()
  try {
    ensureListItemCategories(db)
    assert.equal(duplicateListInDatabase(db,200,'None'),null)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lists').get().n,0)
  } finally {db.close()}
})
