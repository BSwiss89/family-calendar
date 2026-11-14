// Arney read-only public recipe discovery. All outbound URLs are constructed
// against fixed official V1 TheMealDB endpoints (personal development use).
// No household data, arbitrary URLs, paid AI calls, or SQLite writes.
const SEARCH_URL = 'https://www.themealdb.com/api/json/v1/1/search.php'
const MAX_RESPONSE = 500_000
const RESULT_LIMIT = 25
const CACHE_TTL = 180_000
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
  for (let i=1; i<=20; i+=1) {
    const ingredient = safeText(item['strIngredient'+i], 120)
    if (!ingredient) continue
    const measure = safeText(item['strMeasure'+i], 65)
    ingredients.push((measure ? measure + ' ' : '') + ingredient)
  }
  const instructions = safeText(item.strInstructions, 12000)
  const url = 'https://www.themealdb.com/meal/'+String(item.idMeal)+'-'+slug+'-Recipe'
  return { id:String(item.idMeal), name, category, area, image, ingredients, instructions, url }
}
function preferencesOrDefault(value) {
  if (value === undefined) return { pasta:false, onePot:false, kidFriendly:false }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k=>!['pasta','onePot','kidFriendly'].includes(k)) ||
      Object.values(value).some(v=>typeof v !== 'boolean')) throw new TypeError('Invalid recipe preferences.')
  return { pasta: value.pasta === true, onePot: value.onePot === true, kidFriendly: value.kidFriendly === true }
}
async function nameSearch(query, fetchImpl) {
  const url = new URL(SEARCH_URL)
  url.searchParams.set('s',query)
  const response = await fetchImpl(url.toString(),{
    method:'GET',redirect:'error',signal:AbortSignal.timeout(8_000),headers:{Accept:'application/json'}
  })
  if(!response.ok)throw new Error('Public recipe provider is unavailable.')
  const len=Number(response.headers?.get?.('content-length')??0)
  if(!Number.isFinite(len)||len>MAX_RESPONSE)throw new Error('Public recipe response too large.')
  const body=await response.text()
  if(body.length>MAX_RESPONSE)throw new Error('Public recipe response too large.')
  const parsed=JSON.parse(body)
  if(!parsed || (parsed.meals!==null && !Array.isArray(parsed.meals)))throw new Error('Invalid public recipe provider response.')
  return (parsed.meals??[]).slice(0,100)
}
function rankMeal(item, query, p) {
  const title=item.name.toLowerCase()
  const joined=item.ingredients.join(' ').toLowerCase()
  const q=query.toLowerCase()
  if(!title.includes(q)&&!joined.includes(q))return null
  const hasPasta=/(?:\bpasta\b|\bspaghetti\b|\bpenne\b|\bmacaroni\b|\bfettuccine\b|\bfusilli\b|\blinguine\b|\bnoodles\b|\borzo\b)/i.test(title+' '+joined)
  if(p.pasta && !hasPasta)return null
  const onePot=/(?:\bone[- ]?(?:pot|pan)\b|\bsingle[- ]?(?:pot|pan)\b|\bin the same (?:pot|pan)\b)/i.test(title+' '+item.instructions)
  const spicy=/(?:\bchill?i\b|\bhot sauce\b|\bcayenne\b|\bsriracha\b|\bjalape[ñn]o\b|\bchili flakes\b|\bscotch bonnet\b)/i.test(joined)
  const tags=[]
  if(p.pasta&&hasPasta)tags.push('Contains pasta')
  if(p.onePot&&onePot)tags.push('One-pot wording found')
  if(p.kidFriendly&&!spicy)tags.push('Milder ingredients (not guaranteed kid-friendly)')
  const score=(title.includes(q)?6:4)+(p.pasta&&hasPasta?10:0)+
    (p.onePot&&onePot?12:0)+(p.kidFriendly&&!spicy?4:0)
  return {...item,matchNotes:tags,score}
}
export async function searchPublicRecipes(rawQuery,{fetchImpl=fetch,preferences}={}) {
  const query=normalizePublicRecipeQuery(rawQuery)
  if(!query)throw new TypeError('Invalid generic recipe lookup.')
  const p=preferencesOrDefault(preferences)
  const key=query.toLowerCase()+'|'+Number(p.onePot)+Number(p.pasta)+Number(p.kidFriendly)
  const now=Date.now()
  if(fetchImpl===fetch){
    const cached=cache.get(key)
    if(cached&&cached.expires>now)return cached.value
  }
  const raw=await nameSearch(query,fetchImpl)
  // Combine two *name* searches using the free V1 API. No paid multi-filter.
  // Both return complete details and need no arbitrary third-party URL fetch.
  if(p.pasta && query.toLowerCase()!=='pasta'){
    raw.push(...await nameSearch('pasta',fetchImpl))
  }
  const byId=new Map()
  for(const item of raw){
    const meal=publicMeal(item)
    if(meal&&!byId.has(meal.id))byId.set(meal.id,meal)
  }
  const matches=[...byId.values()].map(x=>rankMeal(x,query,p)).filter(Boolean)
    .sort((a,b)=>b.score-a.score || a.name.localeCompare(b.name,'en-US') || a.id.localeCompare(b.id))
  const recipes=matches.slice(0,RESULT_LIMIT).map(({score,...rest})=>rest)
  const response={recipes,provider:'TheMealDB'}
  if(fetchImpl===fetch){
    if(cache.size>20)cache.delete(cache.keys().next().value)
    cache.set(key,{expires:now+CACHE_TTL,value:response})
  }
  return response
}
