import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseArneyRecipeDiscovery, normalizeArneyRecipeResults } from '../src/arneyRecipeDiscovery.mjs'
import { searchPublicRecipes } from '../Server/arney-public-recipe-search.mjs'
import { normalizeTheMealDbImageUrl, fetchVerifiedRecipeImage } from '../Server/arney-public-recipe-image.mjs'
import sharp from 'sharp'

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
    query:'chicken',preferences:{onePot:true,pasta:true,kidFriendly:true,easy:false,quick:false}})
  assert.deepEqual(parseArneyRecipeDiscovery('Find chicken recipes'),{
    query:'chicken',preferences:{onePot:false,pasta:false,kidFriendly:false,easy:false,quick:false}})
  assert.deepEqual(parseArneyRecipeDiscovery('Find pasta recipes'),{
    query:'pasta',preferences:{onePot:false,pasta:false,kidFriendly:false,easy:false,quick:false}})
  assert.equal(parseArneyRecipeDiscovery('Find recipes online').query,'any')
})
test('natural easy, quick, and kid-friendly requests allow generic meal discovery',()=>{
  const easy=parseArneyRecipeDiscovery('Find easy meals')
  assert.deepEqual(easy,{query:'any',preferences:{
    onePot:false,pasta:false,kidFriendly:false,easy:true,quick:false}})
  const child=parseArneyRecipeDiscovery('Find kid friendly meals')
  assert.equal(child.query,'any')
  assert.equal(child.preferences.kidFriendly,true)
  const combined=parseArneyRecipeDiscovery('Hey Arney, find easy, kid-friendly meals for dinner')
  assert.equal(combined.query,'any')
  assert.equal(combined.preferences.easy,true)
  assert.equal(combined.preferences.kidFriendly,true)
  const quick=parseArneyRecipeDiscovery('Can you find quick chicken dinners?')
  assert.equal(quick.query,'chicken')
  assert.equal(quick.preferences.quick,true)
  assert.equal(parseArneyRecipeDiscovery('Find easy pasta meals').query,'pasta')
  assert.equal(parseArneyRecipeDiscovery('Plan easy dinners next week'),null)
})
test('generic free provider search samples a small fixed menu, ranks mild low-effort ideas, and uses no private data',async()=>{
  const f=mockSource({chicken:[spicy,chickenPasta],pasta:[chickenPasta],
    soup:[creamy],rice:[chickenPasta]})
  const out=await searchPublicRecipes('any',{fetchImpl:f.fetchImpl,
    preferences:{kidFriendly:true,easy:true,quick:true}})
  assert.deepEqual(f.calls,['chicken','pasta','soup','rice'])
  assert.equal(out.recipes.length,3)
  assert.notEqual(out.recipes[0].id,'52773','spicy recipe should not outrank mild options')
  assert.ok(out.recipes[0].matchNotes.some(t=>t.includes('ease not verified')))
  assert.ok(out.recipes[0].matchNotes.some(t=>t.includes('cook time not verified')))
  assert.ok(out.recipes.every(r=>r.url.startsWith('https://www.themealdb.com/meal/')))
})
test('recipe results hide only assistant conversation controls, not normal reply controls',()=>{
  const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8')
  const carousel=readFileSync(new URL('../src/ArneyRecipeCarousel.tsx',import.meta.url),'utf8')
  assert.ok(app.includes('ai-command-recipe-mode'))
  assert.ok(app.includes('arneyRecipeResults.length === 0 && aiVoiceDirect'))
  assert.ok(app.includes('arneyRecipeResults.length === 0 && (<div className="ai-command-actions">'))
  assert.ok(app.includes('arneyRecipeResults.length === 0 && (<div className="arney-conversation-audio-controls">'))
  assert.ok(carousel.includes('Save to Recipes'))
  assert.ok(carousel.includes('Next ›'))
  assert.ok(!carousel.includes('arney-recipe-skip'))
  assert.ok(!carousel.includes('arney-recipe-help'))
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
  assert.ok(!carousel.includes('Find {Math.min(5,recipes.length-visible)} More'))
  assert.ok(!carousel.includes('nextBatch'))
  assert.ok(carousel.includes('recipes.map((item, i) =>'))
  assert.ok(carousel.includes('onScroll={handleScroll}'))
  assert.ok(carousel.includes("behavior: 'smooth'"))
  assert.ok(carousel.includes('onReviewSave(selected)'))
  assert.ok(app.includes('setRecipePublicImageUrl(recipe.image)'))
  assert.ok(app.includes("'/api/arney/public-recipe-image'"))
  assert.ok(app.includes("new File([photoBlob], 'arney-recipe.webp'"))
  assert.ok(app.includes('onlineImageFailed'))
})


test('photo import permits only official fixed media links and rejects arbitrary URLs', async () => {
  const allowed = 'https://www.themealdb.com/images/media/meals/abc123.jpg'
  assert.equal(normalizeTheMealDbImageUrl(allowed), allowed)
  for (const source of [
    'http://www.themealdb.com/images/media/meals/abc123.jpg',
    'https://www.themealdb.com.evil.example/images/media/meals/abc123.jpg',
    'https://www.themealdb.com/images/media/meals/abc123.jpg?next=http://127.0.0.1',
    'https://127.0.0.1/images/media/meals/abc123.jpg',
    'https://www.themealdb.com/meal/52772-Recipe',
  ]) assert.equal(normalizeTheMealDbImageUrl(source), null)
  await assert.rejects(
    fetchVerifiedRecipeImage('https://127.0.0.1/internal', {
      fetchImpl: () => { throw new Error('should never fetch'); },
    }), /Unapproved/
  )
})

test('photo import validates actual pixels, size and redirect policy and returns local-ready WebP', async () => {
  const source = 'https://www.themealdb.com/images/media/meals/abc123.jpg'
  const photo = await sharp({create:{width:64,height:48,channels:3,background:'#aabbcc'}})
    .jpeg().toBuffer()
  const headers = {get: name => name==='content-type'?'image/jpeg':name==='content-length'?String(photo.length):null}
  let calls=0
  const fetchImpl=async (url, options) => {
    assert.equal(url,source)
    assert.equal(options.redirect,'error')
    assert.ok(options.signal)
    calls+=1
    return {ok:true,headers,body:{async *[Symbol.asyncIterator](){yield photo}}}
  }
  const result=await fetchVerifiedRecipeImage(source,{fetchImpl})
  assert.equal(calls,1)
  const m=await sharp(result).metadata()
  assert.equal(m.format,'webp')
  assert.equal(m.width,64)
  assert.equal(m.height,48)
  await assert.rejects(fetchVerifiedRecipeImage(source,{
    fetchImpl:async()=>({ok:true,headers:{get:n=>n==='content-type'?'text/html':null},
      body:{async *[Symbol.asyncIterator](){yield Buffer.from('<html>')}}}),
  }), /not a supported image/)
  await assert.rejects(fetchVerifiedRecipeImage(source,{
    fetchImpl:async()=>({ok:true,headers:{get:n=>n==='content-type'?'image/jpeg':null},
      body:{async *[Symbol.asyncIterator](){yield Buffer.alloc(3*1024*1024+1)}}}),
  }), /too large/)
})
