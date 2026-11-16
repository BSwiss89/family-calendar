import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { classifyHouseholdMeal, readHouseholdRecipeHistory,
  reorderRecipesForHousehold } from '../Server/arney-household-recipe-ranking.mjs'

function household() {
  const db=new DatabaseSync(':memory:')
  db.exec('CREATE TABLE recipes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tags TEXT)')
  db.exec('CREATE TABLE meal_plan_items (id INTEGER PRIMARY KEY, date TEXT, meal_type TEXT, recipe_id INTEGER, title TEXT NOT NULL)')
  return db
}
function save(db,name,tags=null) {
  return db.prepare('INSERT INTO recipes (name,tags) VALUES (?,?)').run(name,tags).lastInsertRowid
}
function plan(db,title,recipeId=null,date='2026-11-17') {
  db.prepare('INSERT INTO meal_plan_items (date,meal_type,recipe_id,title) VALUES (?,?,?,?)')
    .run(date,'dinner',recipeId,title)
}

test('classifies actual meal names and tags but not unrelated stock ingredients',()=>{
  assert.deepEqual(classifyHouseholdMeal({
    name:'Chicken Noodle Soup',tags:null,ingredients:'Chicken broth'
  }).sort(),['chicken','pasta','soup'])
  assert.deepEqual(classifyHouseholdMeal({name:'Vegetable Soup',ingredients:'Chicken broth'}),
    ['soup'])
  assert.ok(classifyHouseholdMeal({name:'Family Dinner',tags:'Chicken, Soup'}).includes('chicken'))
  assert.deepEqual(classifyHouseholdMeal({name:'Dinner',tags:null}),[])
  assert.deepEqual(classifyHouseholdMeal({name:'Turkey Meatballs'}),['turkey'],
    'turkey meatballs must never silently train the beef category')
})

test('household history counts saves once and each selected plan slot twice, without ratings',()=>{
  const db=household()
  const id=save(db,'Chicken Soup')
  save(db,'Broccoli Soup')
  plan(db,'Chicken Soup',Number(id),'2026-11-17')
  plan(db,'Chicken Soup',Number(id),'2026-11-20')
  plan(db,'Pasta Night',null,'2026-11-21')
  const counts=readHouseholdRecipeHistory(db)
  assert.equal(counts.chicken,5)
  assert.equal(counts.soup,6)
  assert.equal(counts.pasta,2)
  assert.equal(Object.keys(counts).length,3)
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM meal_plan_items').get().total,3)
  db.close()
})

test('household history uses replacement edits not old abandoned menu choices',()=>{
  const db=household()
  plan(db,'Chicken Dinner')
  assert.equal(readHouseholdRecipeHistory(db).chicken,2)
  db.prepare('UPDATE meal_plan_items SET title=? WHERE id=1').run('Vegetable Soup')
  const latest=readHouseholdRecipeHistory(db)
  assert.equal(latest.chicken,undefined)
  assert.equal(latest.soup,2)
  db.close()
})

const suggestions={
  provider:'TheMealDB',
  recipes:[
    {id:'1',name:'Beef Steak',category:'Beef',tags:''},
    {id:'2',name:'Vegetable Soup',category:'Vegetarian',tags:''},
    {id:'3',name:'Pasta Dinner',category:'Pasta',tags:''},
    {id:'4',name:'Fish Tacos',category:'Seafood',tags:''},
    {id:'5',name:'Chicken Dinner',category:'Chicken',tags:''},
    {id:'6',name:'Rice Bowl',category:'Miscellaneous',tags:''},
    {id:'7',name:'Chicken Soup',category:'Chicken',tags:''},
    {id:'8',name:'Salad',category:'Vegetarian',tags:''},
  ],
}

test('reordering changes ordering only, preserves every recipe and never mutates provider cache',()=>{
  const original=JSON.parse(JSON.stringify(suggestions))
  const counts={chicken:15,soup:4}
  const sorted=reorderRecipesForHousehold(suggestions,'any',counts)
  assert.ok(sorted.recipes.findIndex(x=>x.id==='5')<suggestions.recipes.findIndex(x=>x.id==='5'))
  assert.ok(sorted.recipes.findIndex(x=>x.id==='7')<suggestions.recipes.findIndex(x=>x.id==='7'))
  assert.deepEqual(sorted.recipes.map(x=>x.id).sort(),suggestions.recipes.map(x=>x.id).sort())
  assert.deepEqual(suggestions,original)
  assert.equal(sorted.provider,'TheMealDB')
  assert.equal(reorderRecipesForHousehold(suggestions,'beef',counts),suggestions,
    'specific ingredient searches remain in provider relevance order')
  assert.deepEqual(reorderRecipesForHousehold(suggestions,'any',{}).recipes,
    suggestions.recipes)
})

test('two isolated household databases rank identical public results independently',()=>{
  const a=household(),b=household()
  plan(a,'Chicken Dinner')
  plan(a,'Chicken Dinner',null,'2026-11-18')
  plan(a,'Chicken Dinner',null,'2026-11-19')
  plan(a,'Chicken Dinner',null,'2026-11-20')
  plan(b,'Vegetable Soup')
  plan(b,'Vegetable Soup',null,'2026-11-18')
  const aRank=reorderRecipesForHousehold(suggestions,'any',readHouseholdRecipeHistory(a))
  const bRank=reorderRecipesForHousehold(suggestions,'any',readHouseholdRecipeHistory(b))
  assert.notDeepEqual(aRank.recipes.map(x=>x.id),bRank.recipes.map(x=>x.id))
  assert.equal(aRank.recipes[0].id,'5')
  assert.equal(bRank.recipes[0].id,'2')
  assert.equal(suggestions.recipes[0].id,'1','provider result stays uncached/unchanged')
  a.close()
  b.close()
})

test('large selection counts have a bounded influence and do not remove other groups',()=>{
  const wide=Array.from({length:25},(_,i)=>({
    id:String(i),name:i===24?'Chicken Soup':'Vegetable Salad '+i,category:'Vegetarian'
  }))
  const result={provider:'TheMealDB',recipes:wide}
  const sorted=reorderRecipesForHousehold(result,'any',{chicken:100000,soup:100000})
  assert.equal(sorted.recipes.length,25)
  const moved=sorted.recipes.findIndex(x=>x.id==='24')
  assert.ok(moved>=17 && moved<24,'even huge history moves at most seven places')
  assert.equal(new Set(sorted.recipes.map(x=>x.id)).size,25)
})

test('authenticated recipe route invokes household ranking only after public provider search',()=>{
  const server=readFileSync(new URL('../Server/index.mjs',import.meta.url),'utf8')
  const route=server.slice(server.indexOf("app.post('/api/ai/recipe-search'"),
    server.indexOf("app.post('/api/ai/intent'"))
  assert.ok(route.indexOf('await searchPublicRecipes(')<route.indexOf('readHouseholdRecipeHistory(database)'))
  assert.ok(route.includes("if (query === 'any')"))
  assert.ok(route.includes('return response.json(result)'))
  assert.ok(!route.includes('householdCounts:')&&!route.includes('fetch(OLLAMA'))
})
