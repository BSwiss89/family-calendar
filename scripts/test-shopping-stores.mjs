import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { ensureShoppingStores, getShoppingStores, normalizeShoppingItem,
  looksLikeShoppingList, requireStoreId, suggestShoppingStoreId,
  organizeShoppingStores, saveShoppingStoreCorrection, sortUnknownStoresWithOllama } from '../Server/smart-stores.mjs'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE lists (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT; CREATE TABLE list_items (id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES lists(id), text TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'General', completed INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0) STRICT")
  db.prepare('INSERT INTO lists(id,name) VALUES (1,?), (2,?)').run('Groceries','To-Do')
  ensureShoppingStores(db)
  return db
}
test('store schema additive and idempotent; existing rows remain untouched', () => {
  const db = fixture()
  try {
    db.prepare("INSERT INTO list_items (id,list_id,text,completed,sort_order) VALUES (1,1,'Milk',1,7)").run()
    ensureShoppingStores(db)
    assert.deepEqual(getShoppingStores(db).map(s=>s.name), ['H-E-B','Walmart',"Sam's Club"])
    assert.deepEqual({ ...db.prepare('SELECT text,completed,sort_order,store_id,store_manual FROM list_items').get() },
      { text:'Milk',completed:1,sort_order:7,store_id:null,store_manual:0 })
    assert.equal(db.prepare('SELECT store_enabled FROM lists WHERE id=1').get().store_enabled, 1)
    assert.equal(db.prepare('SELECT store_enabled FROM lists WHERE id=2').get().store_enabled, 0)
  } finally { db.close() }
})
test('offline suggestions choose broad categories and distinguish bulk', () => {
  const db = fixture()
  try {
    const stores = Object.fromEntries(getShoppingStores(db).map(s=>[s.name,s.id]))
    assert.equal(suggestShoppingStoreId(db,'milk','Dairy'),stores['H-E-B'])
    assert.equal(suggestShoppingStoreId(db,'laundry detergent','Household'),stores.Walmart)
    assert.equal(suggestShoppingStoreId(db,'bulk paper towels','Household'),stores["Sam's Club"])
    assert.equal(suggestShoppingStoreId(db,'call grandma','General'),null)
    assert.equal(normalizeShoppingItem(' MILK!!!  '),'milk')
    assert.equal(looksLikeShoppingList('Weekly grocery trip'),true)
    assert.equal(looksLikeShoppingList('Work To-Dos'),false)
    assert.throws(()=>requireStoreId(db,999),RangeError)
  } finally { db.close() }
})
test('learning corrections persists, does not mutate other lists, existing overrides survive', () => {
  const db = fixture()
  try {
    const insert=db.prepare('INSERT INTO list_items (list_id,text,category,completed,sort_order) VALUES (?,?,?,?,?)')
    insert.run(1,'Milk','Dairy',1,7)
    insert.run(1,'Detergent','Household',0,4)
    insert.run(1,'Mystery object','General',0,9)
    insert.run(2,'Milk','Dairy',0,2)
    const first=organizeShoppingStores(db,1)
    assert.deepEqual(first,{sorted:2,remaining:1,disabled:false})
    assert.deepEqual(organizeShoppingStores(db,2),{sorted:0,remaining:0,disabled:true})
    const sams=getShoppingStores(db).find(s=>s.name==="Sam's Club").id
    assert.equal(saveShoppingStoreCorrection(db,1,sams),true)
    assert.equal(suggestShoppingStoreId(db,'milk','Dairy'),sams)
    const again=organizeShoppingStores(db,1)
    assert.equal(again.sorted,0)
    const values=db.prepare('SELECT list_id,text,completed,sort_order,store_id,store_manual FROM list_items ORDER BY id').all()
    assert.equal(values[0].store_id,sams)
    assert.equal(values[0].store_manual,1)
    assert.equal(values[0].completed,1)
    assert.equal(values[0].sort_order,7)
    assert.equal(values[3].store_id,null)
    assert.equal(saveShoppingStoreCorrection(db,999,sams),false)
  } finally { db.close() }
})
test('disabled store remains attached to items and learned choices', () => {
  const db = fixture()
  try {
    const walmart=getShoppingStores(db).find(s=>s.name==='Walmart').id
    db.prepare("INSERT INTO list_items (id,list_id,text,category) VALUES (1,1,'soap','Household')").run()
    saveShoppingStoreCorrection(db,1,walmart)
    db.prepare('UPDATE shopping_stores SET enabled=0 WHERE id=?').run(walmart)
    assert.equal(suggestShoppingStoreId(db,'soap','Household'),walmart)
    assert.equal(db.prepare('SELECT store_id FROM list_items WHERE id=1').get().store_id,walmart)
  } finally { db.close() }
})
test('local AI is optional and safe when unavailable', async () => {
  const db=fixture()
  try {
    db.prepare("INSERT INTO list_items (id,list_id,text) VALUES (1,1,'Unusual shopping item')").run()
    const result=await sortUnknownStoresWithOllama(db,1,'http://127.0.0.1:1/api/chat','offline')
    assert.deepEqual(result,{aiSorted:0,aiAvailable:false})
    assert.equal(db.prepare('SELECT store_id FROM list_items WHERE id=1').get().store_id,null)
  } finally { db.close() }
})
