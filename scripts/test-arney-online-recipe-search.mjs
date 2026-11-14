import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseArneyPublicRecipeRequest, formatArneyPublicRecipeReply } from '../src/arneyOnlineResearch.mjs'
import { searchPublicRecipes, normalizePublicRecipeQuery } from '../Server/arney-public-recipe-search.mjs'

const meal = { idMeal: '52772', strMeal: 'Teriyaki Chicken Casserole', strCategory: 'Chicken' }
const makeFetcher = (body, status = 200) => async (url, options) => {
  assert.equal(new URL(url).origin, 'https://www.themealdb.com')
  assert.equal(new URL(url).pathname, '/api/json/v1/1/search.php')
  assert.equal(options.method, 'GET')
  assert.equal(options.redirect, 'error')
  assert.ok(options.signal)
  return { ok: status === 200, status, headers: {get: () => '0'}, text: async () => JSON.stringify(body) }
}

test('explicit recipe web questions produce minimal generic provider queries', () => {
  assert.deepEqual(parseArneyPublicRecipeRequest('Find chicken recipes online'), {query:'chicken'})
  assert.deepEqual(parseArneyPublicRecipeRequest('Can you search the web for salmon dinner ideas?'), {query:'salmon'})
  assert.deepEqual(parseArneyPublicRecipeRequest('Hey Arney, find easy pasta recipes online'), {query:'pasta'})
  assert.deepEqual(parseArneyPublicRecipeRequest('Find recipes online'), {query:null})
})
test('no implicit network for local meal planning, private calendar, or writes', () => {
  for (const p of ['Plan dinners next week','Suggest five dinners from our recipes',
    'What is on my calendar?','Move dinner next week','Add chicken recipes online to our meals',
    'Save chicken recipes online','Book travel meals online',
    'Can you search online for our family schedule?', 'Find a recipe for my wife online']) {
    const r = parseArneyPublicRecipeRequest(p)
    assert.ok(r === null || r.query === null, p)
  }
})
test('generic query validation rejects personal data, URLs, oversized strings', () => {
  for (const q of ['http://127.0.0.1', 'bob@example.com','a','a'.repeat(90),'secret token',
    'chicken\nmalicious','../../etc/passwd']) {
    assert.equal(normalizePublicRecipeQuery(q), null, q)
  }
  assert.equal(normalizePublicRecipeQuery(' chicken '), 'chicken')
})
test('official API is queried only once with a fixed destination and trimmed output', async () => {
  const out = await searchPublicRecipes('chicken', {fetchImpl: makeFetcher({meals:[meal,meal,
    {idMeal:'x',strMeal:'bad'}, {...meal,idMeal:'56789',strMeal:'Chicken soup'}]})})
  assert.equal(out.recipes.length, 2)
  assert.equal(out.provider, 'TheMealDB')
  assert.equal(out.recipes.find(recipe => recipe.id === '52772')?.url, 'https://www.themealdb.com/meal/52772-Teriyaki-Chicken-Casserole-Recipe')
  assert.equal(out.recipes.find(recipe => recipe.id === '52772')?.category, 'Chicken')
})
test('malformed upstream errors fail closed and no local data is saved', async () => {
  await assert.rejects(searchPublicRecipes('chicken',{fetchImpl:makeFetcher({noMeals:true})}))
  await assert.rejects(searchPublicRecipes('chicken',{fetchImpl:makeFetcher({meals:[]},500)}))
  assert.deepEqual(await searchPublicRecipes('chicken',{fetchImpl:makeFetcher({meals:null})}),
    {recipes:[],provider:'TheMealDB'})
})
test('Arney replies include sources and never imply saved events or grocery writes', () => {
  const r=formatArneyPublicRecipeReply({recipes:[{name:meal.strMeal,category:'Chicken',
    url:'https://www.themealdb.com/meal/52772-Teriyaki-Chicken-Casserole-Recipe'}]},'chicken')
  assert.equal(r.kind,'information')
  assert.match(r.text,/TheMealDB/)
  assert.match(r.text,/Nothing was saved/)
  assert.ok(!r.text.includes('Saved to'))
  assert.match(formatArneyPublicRecipeReply({recipes:[]},'salmon').text,/No matching public/)
})
test('feature remains after family authentication and before generic intent; no paid/cloud AI', () => {
  const s=readFileSync(new URL('../Server/index.mjs',import.meta.url),'utf8')
  const a=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8')
  assert.ok(s.indexOf('installFamilyAuth(app, database, __dirname)') <
    s.indexOf("app.post('/api/ai/recipe-search'"))
  assert.ok(s.indexOf("app.post('/api/ai/recipe-search'") <
    s.indexOf("app.post('/api/ai/intent'"))
  assert.ok(a.indexOf("parseArneyRecipeDiscovery(command)") <
    a.indexOf("'/api/ai/intent'"))
  assert.ok(!readFileSync(new URL('../Server/arney-public-recipe-search.mjs',import.meta.url),'utf8')
    .includes('11434'))
})
