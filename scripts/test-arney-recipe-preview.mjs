import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseArneyRecipeDiscovery, normalizeArneyRecipeResults } from '../src/arneyRecipeDiscovery.mjs'
import { searchPublicRecipes } from '../Server/arney-public-recipe-search.mjs'

const dish = (id,name,ingredients,{instructions='Cook everything together.',spicy=false}={})=>({
  idMeal:String(id),strMeal:name,strCategory:'Pasta',strArea:'American',
  strMealThumb:'https://www.themealdb.com/images/media/meals/abc123.jpg',
  strIngredient1:'Chicken',strMeasure1:'1 cup',strIngredient2:ingredients,
  strMeasure2:'100 g',strIngredient3:spicy?'Cayenne':'Cream',strMeasure3:'1 tsp',
  strInstructions:instructions
})
const chickenPasta=dish(52772,'One-Pot Chicken Penne','Penne Pasta',{instructions:'Cook in one pot until done.'})
const spicy=dish(52773,'Spicy Chicken Pasta','Spaghetti',{spicy:true})
const creamy=dish(52774,'Chicken Noodles','Noodles',{instructions:'Use a large pot to cook.'})
const unrelated={...dish(52775,'Beef Pasta Bake','Penne Pasta'),strIngredient1:'Beef'}
function mockSource(sources) {
  const calls=[]
  const fetchImpl=async url => {
    const u=new URL(url)
    assert.equal(u.origin,'https://www.themealdb.com')
    assert.equal(u.pathname,'/api/json/v1/1/search.php')
    calls.push(u.searchParams.get('s'))
    return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({meals:sources[u.searchParams.get('s')]||null})}
  }
  return {fetchImpl,calls}
}
test('understands natural compound preferences without leaking entire utterances',()=>{
  assert.deepEqual(parseArneyRecipeDiscovery('Find me chicken recipes, one pot, pasta, kid friendly'),{
    query:'chicken',preferences:{onePot:true,pasta:true,kidFriendly:true}})
  assert.deepEqual(parseArneyRecipeDiscovery('Find chicken recipes'),{
    query:'chicken',preferences:{onePot:false,pasta:false,kidFriendly:false}})
  assert.deepEqual(parseArneyRecipeDiscovery('Find pasta recipes'),{
    query:'pasta',preferences:{onePot:false,pasta:false,kidFriendly:false}})
  assert.equal(parseArneyRecipeDiscovery('Find recipes online').query,null)
})
test('saved meals and calendar writes never initiate public discovery',()=>{
  for(const prompt of ['Find our saved recipes','Suggest five dinners from our recipes',
    'Plan dinners next week','Save chicken recipes to my calendar',
    'Add chicken recipes to shopping list','Cancel dinner next week',
    'What is on my calendar this week']) assert.equal(parseArneyRecipeDiscovery(prompt),null,prompt)
})
test('uses name-only free V1 searches then locally ranks one pot / pasta / milder ingredients',async()=>{
  const f=mockSource({chicken:[spicy,creamy,chickenPasta],pasta:[chickenPasta,unrelated]})
  const r=await searchPublicRecipes('chicken',{
    fetchImpl:f.fetchImpl,preferences:{onePot:true,pasta:true,kidFriendly:true}})
  assert.deepEqual(f.calls,['chicken','pasta'])
  assert.equal(r.recipes[0].id,'52772')
  assert.equal(r.recipes.length,3)
  assert.ok(r.recipes[0].matchNotes.includes('Contains pasta'))
  assert.ok(r.recipes[0].matchNotes.includes('One-pot wording found'))
  assert.match(r.recipes[0].matchNotes.join(' '),/not guaranteed kid-friendly/)
  assert.ok(!r.recipes[1].instructions.includes('<script>'))
  assert.ok(r.recipes.every(x=>x.id!=='52775'))
})
test('official-only photos, bounded detail text, and ingredient measurements are normalized',async()=>{
  const bad={...chickenPasta,strMealThumb:'https://evil.example/tracker.jpg',
    strIngredient1:'Penne Pasta',strMeasure1:'3 cups',
    strInstructions:'Directions here.\n'.repeat(1500)}
  const f=mockSource({chicken:[bad]})
  const r=await searchPublicRecipes('chicken',{fetchImpl:f.fetchImpl})
  assert.equal(r.recipes[0].image,'')
  assert.ok(r.recipes[0].ingredients[0].includes('3 cups'))
  assert.ok(r.recipes[0].instructions.length<=12000)
  assert.ok(r.recipes[0].url.startsWith('https://www.themealdb.com/meal/'))
})
test('repeated IDs are deduplicated and preview rejects injected external URLs',async()=>{
  const f=mockSource({chicken:[chickenPasta,chickenPasta,spicy]})
  const r=await searchPublicRecipes('chicken',{fetchImpl:f.fetchImpl})
  assert.equal(r.recipes.length,2)
  const broken={...r.recipes[0],url:'https://evil.example/'}
  const normalized=normalizeArneyRecipeResults({recipes:[broken,...r.recipes]})
  assert.equal(normalized.length,2)
  assert.equal(normalized[0].id,'52772')
  assert.equal(normalized[0].image,'https://www.themealdb.com/images/media/meals/abc123.jpg')
})
test('swipeable selection is separate from explicit recipe form submission',()=>{
  const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8')
  const carousel=readFileSync(new URL('../src/ArneyRecipeCarousel.tsx',import.meta.url),'utf8')
  assert.ok(app.indexOf('const publicRecipeRequest = parseArneyRecipeDiscovery(command)') <
    app.indexOf('const planningReply = publicRecipeRequest ? null : planArneyReadOnlyRequest('))
  assert.ok(app.includes('<ArneyRecipeCarousel recipes={arneyRecipeResults}'))
  assert.ok(app.includes('setRecipeFormOpen(true)'))
  assert.ok(app.includes('setRecipeSourceUrl(recipe.url)'))
  assert.ok(app.includes("setRecipeIngredients(recipe.ingredients.join('\\n'))"))
  assert.ok(!carousel.includes("fetch('/api/recipes'"))
  assert.ok(carousel.includes('Find {Math.min(5,recipes.length-visible)} More'))
  assert.ok(carousel.includes('onTouchEnd'))
  assert.ok(carousel.includes('onReviewSave(item)'))
})
