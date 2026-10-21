import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  normalizeListCategory, ensureListItemCategories,
  suggestListCategory, organizeExistingListItems,
} from '../Server/list-features.mjs'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE lists (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT; CREATE TABLE list_items (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE, text TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0) STRICT")
  ensureListItemCategories(db)
  return db
}
test('category migration is additive, repeatable, and keeps old rows', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("CREATE TABLE lists (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT; CREATE TABLE list_items (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL, text TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0) STRICT")
    db.prepare('INSERT INTO lists (name) VALUES (?)').run('Weekly groceries')
    db.prepare('INSERT INTO list_items (list_id, text, completed, sort_order) VALUES (1, ?, 1, 1)').run('Milk')
    ensureListItemCategories(db)
    ensureListItemCategories(db)
    assert.deepEqual({ ...db.prepare('SELECT text, completed, category FROM list_items').get() }, {
      text:'Milk', completed:1, category:'General',
    })
  } finally { db.close() }
})
test('category validation still accepts custom names and rejects oversized values', () => {
  assert.equal(normalizeListCategory(undefined), 'General')
  assert.equal(normalizeListCategory('  Produce  '), 'Produce')
  assert.equal(normalizeListCategory(' '), 'General')
  assert.throws(() => normalizeListCategory('x'.repeat(41)), RangeError)
  assert.throws(() => normalizeListCategory(7), TypeError)
})
test('automatic category suggestions handle typical groceries and household items', () => {
  for (const [item, category] of [
    ['2% milk', 'Dairy'], ['a dozen eggs', 'Dairy'],
    ['Bananas', 'Produce'], ['fresh apples', 'Produce'],
    ['ground beef', 'Meat'], ['rotisserie chicken', 'Deli'],
    ['Paper towels', 'Household'], ['laundry detergent', 'Household'],
    ['ice cream', 'Frozen'], ['soda', 'Beverages'],
    ['dog food', 'Pet Supplies'], ['baby wipes', 'Baby'],
    ['whole wheat bread', 'Bakery'], ['canned beans', 'Pantry'],
  ]) {
    assert.equal(suggestListCategory(item), category, item)
  }
})
test('unknown items stay uncategorized; rules use whole words', () => {
  for (const item of ['fix the fence', 'Buy a gift', 'foobar', '', 45, 'soapstone']) {
    assert.equal(suggestListCategory(item), null, String(item))
  }
})
test('organizes existing General items only without touching checkmarks, sort, names or other lists', () => {
  const db = fixture()
  try {
    db.prepare('INSERT INTO lists(id,name) VALUES (1,?), (2,?)').run('Groceries', 'Work')
    const insert = db.prepare('INSERT INTO list_items (list_id, text, completed, sort_order, category) VALUES (?, ?, ?, ?, ?)')
    insert.run(1, 'Milk', 1, 7, 'General')
    insert.run(1, 'Paper towels', 0, 9, 'General')
    insert.run(1, 'Apples', 0, 4, 'Errands') // Manual category must stay.
    insert.run(1, 'Call grandma', 1, 6, 'General') // No confident category.
    insert.run(2, 'Bananas', 0, 2, 'General') // Other list must stay.
    assert.deepEqual(organizeExistingListItems(db, 1), { categorized: 2, remainingGeneral: 1 })
    const actual = db.prepare('SELECT list_id, text, completed, sort_order, category FROM list_items ORDER BY id').all().map(x => ({ ...x }))
    assert.deepEqual(actual, [
      { list_id:1, text:'Milk', completed:1, sort_order:7, category:'Dairy' },
      { list_id:1, text:'Paper towels', completed:0, sort_order:9, category:'Household' },
      { list_id:1, text:'Apples', completed:0, sort_order:4, category:'Errands' },
      { list_id:1, text:'Call grandma', completed:1, sort_order:6, category:'General' },
      { list_id:2, text:'Bananas', completed:0, sort_order:2, category:'General' },
    ])
    assert.deepEqual(organizeExistingListItems(db,1), { categorized:0, remainingGeneral:1 })
  } finally { db.close() }
})
test('unknown list cannot mutate or create anything', () => {
  const db = fixture()
  try {
    assert.equal(organizeExistingListItems(db, 999), null)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM list_items').get().n, 0)
  } finally { db.close() }
})
