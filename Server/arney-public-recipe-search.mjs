// Authenticated, read-only recipe discovery using ONLY fixed official
// TheMealDB V1 (free personal-development API) endpoints. No raw utterances,
// family data, arbitrary URLs, paid models, or calendar/database writes.
const ROOT = 'https://www.themealdb.com/api/json/v1/1/'
const RESULT_LIMIT = 25
const MAX_RESPONSE = 500_000
const CACHE_TTL = 180_000
const CATEGORY_LOOKUPS = 12
const cache = new Map()

export function normalizePublicRecipeQuery(raw) {
  if (typeof raw !== 'string' || raw.length > 70 || /[\x00-\x1f\x7f]/.test(raw)) return null
  const query = raw.trim().replace(/\s+/g, ' ')
  if (query.length < 2 || query.length > 60 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9 '-]*$/.test(query) ||
      /(?:@|https?:|www\.|password|secret|token|address)/i.test(query)) return null
  return query
}
function safeText(value, max = 100) {
  return typeof value === 'string'
    ? value.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ').trim().slice(0, max) : ''
}
function publicMeal(item) {
  if (!item || typeof item !== 'object' || !/^\d{4,12}$/.test(String(item.idMeal))) return null
  const name = safeText(item.strMeal, 110)
  if (!name) return null
  const category = safeText(item.strCategory, 45)
  const area = safeText(item.strArea, 70)
  const thumb = typeof item.strMealThumb === 'string' ? item.strMealThumb : ''
  const image = /^https:\/\/(?:www\.)?themealdb\.com\/images\/media\/meals\/[a-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(thumb)
    ? thumb : ''
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 110)
  if (!slug) return null
  const ingredients = []
  for (let i=1; i<=20; i++) {
    const ingredient = safeText(item['strIngredient'+i], 120)
    if (!ingredient) continue
    const measure = safeText(item['strMeasure'+i], 65)
    ingredients.push((measure ? measure + ' ' : '') + ingredient)
  }
  const instructions = safeText(item.strInstructions, 12000)
  return {
    id: String(item.idMeal), name, category, area, image,
    ingredients, instructions,
    url: 'https://www.themealdb.com/meal/'+String(item.idMeal)+'-'+slug+'-Recipe',
  }
}

const PURPOSES = new Set(['','picky','budget','healthy','different'])
const METHODS = new Set(['','air-fryer','slow-cooker','breakfast','casserole','low-cleanup'])
function preferencesOrDefault(value) {
  const v = value === undefined ? {} : value
  if (!v || typeof v !== 'object' || Array.isArray(v) ||
      Object.keys(v).some(k=>!['pasta','onePot','kidFriendly','easy','quick','purpose','method'].includes(k)) ||
      Object.entries(v).some(([k,x])=>['purpose','method'].includes(k) ? typeof x!=='string' : typeof x!=='boolean') ||
      !PURPOSES.has(v.purpose??'') || !METHODS.has(v.method??'')) throw new TypeError('Invalid recipe preferences.')
  return {
    pasta: v.pasta===true, onePot: v.onePot===true,
    kidFriendly: v.kidFriendly===true, easy: v.easy===true, quick: v.quick===true,
    purpose: v.purpose??'', method: v.method??'',
  }
}
async function officialRequest(path, parameter, value, fetchImpl) {
  // These three endpoint paths and their query keys are constants chosen in
  // code, not URLs from a user or an upstream result.
  if (!['search.php','filter.php','lookup.php'].includes(path) ||
      !{ 'search.php':['s'], 'filter.php':['c'], 'lookup.php':['i'] }[path].includes(parameter))
    throw new TypeError('Unsupported recipe endpoint.')
  const url = new URL(path,ROOT)
  url.searchParams.set(parameter,value)
  const response = await fetchImpl(url.toString(),{
    method:'GET',redirect:'error',signal:AbortSignal.timeout(8_000),headers:{Accept:'application/json'},
  })
  if(!response.ok) throw new Error('Public recipe provider is unavailable.')
  const len=Number(response.headers?.get?.('content-length')??0)
  if(!Number.isFinite(len)||len>MAX_RESPONSE) throw new Error('Public recipe response too large.')
  const body=await response.text()
  if(body.length>MAX_RESPONSE) throw new Error('Public recipe response too large.')
  const parsed=JSON.parse(body)
  if(!parsed || (parsed.meals!==null && !Array.isArray(parsed.meals)))
    throw new Error('Invalid public recipe provider response.')
  return (parsed.meals??[]).slice(0,100)
}
const nameSearch=(term,fetchImpl)=>officialRequest('search.php','s',term,fetchImpl)
const categorySearch=(name,fetchImpl)=>officialRequest('filter.php','c',name,fetchImpl)
const lookup=(id,fetchImpl)=>officialRequest('lookup.php','i',id,fetchImpl)

function searchPlan(query,p) {
  const q=query.toLowerCase()
  const generic=q==='any' || (p.method==='breakfast' && q==='breakfast')
  if(!generic) {
    if(p.method==='air-fryer') return {names:['air fryer',q],categories:['Chicken']}
    if(p.method==='slow-cooker') return {names:['slow cooker',q],categories:['Beef']}
    return {names:p.pasta&&q!=='pasta'?[q,'pasta']:[q],categories:[]}
  }
  if(p.method==='breakfast') return {names:['pancake','egg','breakfast'],categories:['Breakfast']}
  if(p.method==='air-fryer') return {names:['air fryer','fries'],categories:['Chicken']}
  if(p.method==='slow-cooker') return {names:['slow cooker','stew'],categories:['Beef']}
  if(p.method==='casserole') return {names:['casserole','bake','pasta'],categories:['Pasta','Beef']}
  if(p.purpose==='picky'||p.kidFriendly)
    return {names:['pasta','chicken','meatball','pizza'],categories:['Chicken','Pasta','Beef']}
  if(p.purpose==='healthy')
    return {names:['salad','salmon','vegetable'],categories:['Vegetarian','Seafood','Chicken']}
  if(p.purpose==='budget')
    return {names:['rice','pasta','bean'],categories:['Vegetarian','Pasta','Chicken']}
  if(p.purpose==='different')
    return {names:['mushroom','salmon','lamb'],categories:['Seafood','Vegetarian','Lamb']}
  if(p.method==='low-cleanup'||p.onePot)
    return {names:['stew','soup','rice'],categories:['Chicken','Pasta','Vegetarian']}
  return {names:p.pasta?['pasta','macaroni','spaghetti']:['chicken','pasta','soup','rice'],
    categories:p.pasta?['Pasta']:['Chicken','Beef','Vegetarian']}
}

const SPICY=/\b(?:hot sauce|cayenne|sriracha|jalape[nñ]o|scotch bonnet|habanero|red chilli|green chilli|chili flakes|chilli flakes|hot pepper)\b/i
const FAMILIAR=/\b(?:pasta|pizza|chicken|quesadilla|taco|spaghetti|macaroni|cheese|burger|meatball|potato|noodle|pancake|nugget|rice|lasagna|casserole)\b/i
const VEG=/\b(?:carrot|broccoli|spinach|tomato|lettuce|pepper|zucchini|peas|beans|lentil|cabbage|kale|mushroom|cauliflower|asparagus)\b/i
const LEAN=/\b(?:chicken breast|turkey|fish|salmon|tuna|lentil|beans|tofu)\b/i
const STAPLES=/\b(?:rice|pasta|potato|flour|egg|bean|lentil|tomato|onion|chicken|carrot|oat|milk|cheese)\b/i
const ADVANCED=/\b(?:temper|deglaze|julienne|carameliz|proof|knead|double boiler|deep[- ]fry|braise|blanch|emulsif|ferment|laminat)\b/i
const PREP=/\b(?:chop|dice|mince|peel|grate|julienne|knead|roll|shred|marinate|debone|fillet)\b/gi
const CONVENIENT=/\b(?:one[- ]?pot|one[- ]?pan|single[- ]?pot|one skillet|same pan|sheet[- ]?pan|baking tray|slow cooker|crock[- ]?pot|mix together|place in (?:an? )?(?:oven|baking dish))\b/i
const AIRFRY=/\bair[- ]?fry(?:er|ing)?\b/i
const SLOW=/\b(?:slow cooker|slow cook|crock[- ]?pot)\b/i
const SIMPLE=/\b(?:mix|stir|combine|assemble|bake|simmer|heat|serve|pour|toss|sprinkle)\b/gi
const CUSTOM=/\b(?:optional|toppings?|serve with|add to taste|garnish|on the side|top with)\b/i

function countMatches(text,re) {return [...text.matchAll(re)].length}
function rankMeal(item,query,p) {
  const title=item.name.toLowerCase()
  const ingredients=item.ingredients.join(' ').toLowerCase()
  const directions=item.instructions.toLowerCase()
  const both=title+' '+ingredients+' '+directions
  const q=query.toLowerCase()
  const generic=q==='any' || (q==='breakfast' && p.method==='breakfast')
  if(!generic&&!title.includes(q)&&!ingredients.includes(q)) return null
  if(p.pasta&&!/\b(?:pasta|spaghetti|penne|macaroni|noodles|fettuccine|fusilli|linguine|orzo)\b/i.test(title+' '+ingredients))return null
  if(p.method==='air-fryer'&&!AIRFRY.test(title+' '+directions))return null
  if(p.method==='slow-cooker'&&!SLOW.test(title+' '+directions))return null
  if(p.method==='breakfast'&&!/\bbreakfast\b/i.test(item.category+' '+title))return null
  if(p.method==='casserole'&&!/\b(?:casserole|bake|baked|gratin|lasagna)\b/i.test(title))return null
  const count=item.ingredients.length
  const prep=countMatches(directions,PREP)
  const simple=countMatches(directions,SIMPLE)
  const advanced=ADVANCED.test(directions)
  const convenient=CONVENIENT.test(title+' '+directions)
  const familiar=FAMILIAR.test(title)
  const spicy=SPICY.test(ingredients+' '+title)
  const veggies=VEG.test(ingredients)
  const lean=LEAN.test(ingredients)
  const staples=countMatches(ingredients,new RegExp(STAPLES.source,'gi'))
  const customizable=CUSTOM.test(directions)
  const steps=directions.split(/(?:[.!?]\s+|\r?\n+)/).map(s=>s.trim()).filter(Boolean).length
  const shortSteps=steps>0&&steps<=7
  const lowPrep=prep<=2 && !advanced
  let score=generic?0:(title.includes(q)?7:4)
  const notes=[]
  if(p.pasta) notes.push('Pasta ingredients listed')
  if(p.onePot||p.method==='low-cleanup') {
    score+=convenient?12:0
    if(convenient) notes.push('One-pan or simple setup described')
  }
  if(p.easy||p.quick) {
    // No single threshold decides "easy": technique, hands-on preparation,
    // step count, and ingredients all contribute without hard filtering.
    score+=lowPrep?12:-Math.min(10,prep*2+Number(advanced)*7)
    score+=shortSteps?8:0
    score+=simple>1?4:0
    score+=count>0&&count<=8?5:count>15?-3:0
    if(lowPrep) notes.push('Light hands-on prep wording (estimate)')
    else if(shortSteps) notes.push('Fewer described cooking steps')
    if(p.quick&&convenient)score+=5
    // Explicit preparation time is not provided reliably by this service:
    // never infer a real total from length of instructions.
  }
  if(p.kidFriendly||p.purpose==='picky') {
    score+=spicy?-16:6
    score+=familiar?12:0
    score+=customizable?5:0
    if(familiar) notes.push('Familiar dish style (preference estimate)')
    else if(!spicy) notes.push('No obvious hot peppers listed')
    if(p.purpose==='picky' && customizable)score+=8
  }
  if(p.purpose==='budget') {
    score+=Math.min(12,staples*2)
    score-=count>13?4:0
    if(staples>=2)notes.push('Common staples listed; prices not checked')
  }
  if(p.purpose==='healthy') {
    score+=veggies?10:0
    score+=lean?8:0
    score-=spicy?0:0
    if(veggies)notes.push('Vegetables listed; nutrition not verified')
    else if(lean)notes.push('Lean protein or legumes listed')
  }
  if(p.purpose==='different') {
    score+=/(?:seafood|lamb|vegetarian|miscellaneous)/i.test(item.category)?10:0
  }
  if(p.method==='air-fryer'||p.method==='slow-cooker')
    notes.push('Cooking method mentioned in source')
  return {...item,matchNotes:notes.slice(0,3),score}
}

export async function searchPublicRecipes(rawQuery,{fetchImpl=fetch,preferences}={}) {
  const query=normalizePublicRecipeQuery(rawQuery)
  if(!query)throw new TypeError('Invalid generic recipe lookup.')
  const p=preferencesOrDefault(preferences)
  const key=query.toLowerCase()+'|'+JSON.stringify(p)
  const now=Date.now()
  if(fetchImpl===fetch){
    const cached=cache.get(key)
    if(cached && cached.expires>now)return cached.value
  }
  const plan=searchPlan(query,p)
  const nameTerms=[...new Set(plan.names)].slice(0,4)
  const categories=[...new Set(plan.categories)].slice(0,3)
  // Name search delivers full recipes. Category filters provide diverse IDs;
  // details are fetched via the official lookup endpoint only, with a strict
  // per-request cap. Category failures are best-effort, but a total provider
  // outage is not falsely presented as "no recipes".
  const nameResponses=await Promise.all(nameTerms.map(term=>nameSearch(term,fetchImpl)))
  const byId=new Map()
  for(const item of nameResponses.flat()){
    const meal=publicMeal(item)
    if(meal&&!byId.has(meal.id))byId.set(meal.id,meal)
  }
  if(categories.length){
    const categoryResponses=await Promise.all(categories.map(category=>
      categorySearch(category,fetchImpl).catch(()=>[])))
    const toLookup=[]
    for(let i=0;i<categoryResponses.length;i++){
      const group=categoryResponses[i]
      // Distributed picks avoid only using the provider's top few entries.
      const slots=Math.min(4,group.length)
      for(let j=0;j<slots;j++){
        const position=Math.floor(j*group.length/slots)
        const id=String(group[position]?.idMeal??'')
        if(/^\d{4,12}$/.test(id)&&!byId.has(id)&&!toLookup.includes(id))
          toLookup.push(id)
      }
    }
    const ids=toLookup.slice(0,CATEGORY_LOOKUPS)
    const detailResults=await Promise.all(ids.map(id=>lookup(id,fetchImpl).catch(()=>[])))
    for(const item of detailResults.flat()){
      const meal=publicMeal(item)
      if(meal&&!byId.has(meal.id))byId.set(meal.id,meal)
    }
  }
  const ranked=[...byId.values()].map(item=>rankMeal(item,query,p)).filter(Boolean)
    .sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name,'en-US')||a.id.localeCompare(b.id))
  // For wide discovery, avoid a long run of one cuisine/category at the top.
  const selected=[]
  const seenCategory=new Map()
  const generic=query.toLowerCase()==='any'||p.method==='breakfast'
  if(generic)for(const item of ranked){
    const key=item.category||'Other'
    if((seenCategory.get(key)??0)>=8)continue
    selected.push(item)
    seenCategory.set(key,(seenCategory.get(key)??0)+1)
    if(selected.length===RESULT_LIMIT)break
  }
  if(selected.length<RESULT_LIMIT)for(const item of ranked){
    if(selected.includes(item))continue
    selected.push(item)
    if(selected.length===RESULT_LIMIT)break
  }
  const recipes=selected.map(({score,...rest})=>rest)
  const response={recipes,provider:'TheMealDB'}
  if(fetchImpl===fetch){
    if(cache.size>20)cache.delete(cache.keys().next().value)
    cache.set(key,{expires:now+CACHE_TTL,value:response})
  }
  return response
}
