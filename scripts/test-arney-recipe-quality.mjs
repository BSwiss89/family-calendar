import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseArneyRecipeDiscovery } from '../src/arneyRecipeDiscovery.mjs'
import { ARNEY_RECIPE_SUGGESTIONS, suggestionPage } from '../src/arneyRecipeSuggestions.mjs'
import { searchPublicRecipes } from '../Server/arney-public-recipe-search.mjs'

const meal=(id,name,category='Chicken',instructions='Mix ingredients. Bake and serve.',extras={})=>({
  idMeal:String(id), strMeal:name, strCategory:category, strArea:'American',
  strMealThumb:'https://www.themealdb.com/images/media/meals/abc123.jpg',
  strIngredient1:'Chicken',strMeasure1:'1 cup',strIngredient2:'Rice',strMeasure2:'2 cups',
  strInstructions:instructions,...extras,
})
function fakeSource(entries) {
  const calls=[]
  const fetchImpl=async (url,options)=>{
    const u=new URL(url)
    assert.equal(u.origin,'https://www.themealdb.com')
    assert.equal(options.redirect,'error')
    assert.equal(options.method,'GET')
    assert.ok(options.signal)
    const type=u.pathname.endsWith('search.php')?'name':
      u.pathname.endsWith('filter.php')?'category':
        u.pathname.endsWith('lookup.php')?'detail':'INVALID'
    assert.notEqual(type,'INVALID')
    const value=u.searchParams.get(type==='name'?'s':type==='category'?'c':'i')
    const key=type+':'+value
    calls.push(key)
    return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({meals:entries[key]??null})}
  }
  return {calls,fetchImpl}
}
test('all 18 on-screen suggestion prompts open the real recipe parser',()=>{
  assert.equal(ARNEY_RECIPE_SUGGESTIONS.length,18)
  assert.equal(new Set(ARNEY_RECIPE_SUGGESTIONS).size,18)
  assert.deepEqual(suggestionPage(3),suggestionPage(0))
  for(let page=0;page<3;page++)assert.equal(suggestionPage(page).length,6)
  for(const phrase of ARNEY_RECIPE_SUGGESTIONS){
    const result=parseArneyRecipeDiscovery(phrase)
    assert.ok(result,'not routed: '+phrase)
    assert.ok(result.query)
    assert.ok(!/\b(?:my|our|family|wife|husband)\b/i.test(result.query),
      'personal language in generic public query: '+result.query)
  }
  const cases=[
    ['Find easy casseroles','casserole','method','casserole'],
    ['Find something for picky eaters','any','purpose','picky'],
    ['Show me simple pasta dishes','pasta','easy',true],
    ['Find easy breakfast ideas','breakfast','method','breakfast'],
    ['Find mild dinners for kids','any','kidFriendly',true],
    ['Find budget-friendly meals','any','purpose','budget'],
    ['Find healthy family dinners','any','purpose','healthy'],
    ['Find meals with fewer dishes to wash','any','method','low-cleanup'],
    ['Give me something different for dinner','any','purpose','different'],
    ['Find easy meals for busy weeknights','any','quick',true],
    ['Find meals with ground beef','beef','method',''],
  ]
  for(const [phrase,expectedQuery,key,expected] of cases){
    const found=parseArneyRecipeDiscovery(phrase)
    assert.equal(found?.query,expectedQuery,phrase)
    assert.equal(found?.preferences[key],expected,phrase)
  }
  for(const phrase of ['Save chicken recipes to my shopping list','Plan dinners next week',
    'Find our saved recipes','Delete easy meal events'])
    assert.equal(parseArneyRecipeDiscovery(phrase),null,phrase)
})
test('generic search adds varied free categories and bounded ID lookups',async()=>{
  const entries={
    'name:chicken':[meal(52772,'Chicken and Rice')],
    'name:pasta':[], 'name:soup':[], 'name:rice':[],
    'category:Chicken':Array.from({length:40},(_,i)=>({idMeal:String(60000+i)})),
    'category:Beef':[{idMeal:'61001'},{idMeal:'61002'}],
    'category:Vegetarian':[{idMeal:'62001'}],
  }
  for(let i=0;i<40;i++)entries['detail:'+(60000+i)]=[meal(60000+i,'Chicken Dinner '+i)]
  entries['detail:61001']=[meal(61001,'Beef Skillet','Beef')]
  entries['detail:61002']=[meal(61002,'Beef Casserole','Beef')]
  entries['detail:62001']=[meal(62001,'Vegetable Rice','Vegetarian')]
  const fake=fakeSource(entries)
  const result=await searchPublicRecipes('any',{fetchImpl:fake.fetchImpl,preferences:{easy:true,kidFriendly:true}})
  assert.ok(result.recipes.length>=4)
  assert.ok(result.recipes.some(x=>x.category==='Beef'))
  assert.ok(result.recipes.some(x=>x.category==='Vegetarian'))
  assert.ok(result.recipes.every(x=>x.ingredients.length>0&&x.instructions.length>0))
  assert.ok(result.recipes.length<=25)
  assert.ok(fake.calls.filter(x=>x.startsWith('detail:')).length<=12)
  assert.ok(fake.calls.length<=19,'bounded total provider requests')
  assert.ok(fake.calls.every(x=>!x.includes('my family')&&!x.includes('password')))
})
test('preparation technique and familiar customizable food affect rank beyond ingredient count',async()=>{
  const harder=meal(60071,'Chicken Julienne','Chicken',
    'Julienne vegetables. Temper the sauce. Knead and proof dough for hours. Deep-fry.')
  const easier=meal(60072,'Chicken Quesadilla','Chicken',
    'Combine ingredients. Heat a skillet. Assemble and serve with optional toppings.',
    {strIngredient3:'Tortilla',strMeasure3:'2',strIngredient4:'Cheese',strMeasure4:'1 cup'})
  const fake=fakeSource({'name:chicken':[harder,easier]})
  const result=await searchPublicRecipes('chicken',{fetchImpl:fake.fetchImpl,
    preferences:{easy:true,kidFriendly:true,purpose:'picky'}})
  assert.equal(result.recipes[0].id,'60072')
  assert.ok(result.recipes[0].matchNotes.some(x=>/familiar|prep/i.test(x)))
})
test('method discovery never mislabels an ordinary bake as air fryer or slow cooker',async()=>{
  const fake=fakeSource({
    'name:air fryer':[],'name:fries':[],
    'category:Chicken':[{idMeal:'52772'}],
    'detail:52772':[meal(52772,'Baked Chicken','Chicken','Preheat oven. Bake and serve.')],
  })
  const found=await searchPublicRecipes('any',{fetchImpl:fake.fetchImpl,preferences:{method:'air-fryer'}})
  assert.equal(found.recipes.length,0)
})
test('provider failure in optional categories still preserves safe full recipe names',async()=>{
  const source=async url=>{
    const u=new URL(url)
    if(u.pathname.endsWith('filter.php'))throw Error('category unavailable')
    return {ok:true,headers:{get:()=>null},text:async()=>JSON.stringify({
      meals:u.searchParams.get('s')==='chicken'?[meal(52772,'Chicken Supper')]:null,
    })}
  }
  const result=await searchPublicRecipes('any',{fetchImpl:source})
  assert.equal(result.recipes.length,1)
  assert.equal(result.recipes[0].name,'Chicken Supper')
})
test('recipe examples show only before search and preserve clean recipe carousel',()=>{
  const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8')
  const carousel=readFileSync(new URL('../src/ArneyRecipeCarousel.tsx',import.meta.url),'utf8')
  assert.ok(app.includes('suggestionPage(arneyRecipeSuggestionPage).map'))
  assert.ok(app.includes('void submitAiCommand(phrase)'))
  assert.ok(app.includes('!aiCommandResult && arneyRecipeResults.length === 0'))
  assert.ok(app.includes('setArneyRecipeSuggestionPage(0)'))
  assert.ok(!carousel.includes('Try asking Arney'))
  assert.ok(!carousel.includes('arney-recipe-skip'))
})
