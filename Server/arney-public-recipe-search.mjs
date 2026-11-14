// Arney public recipe research — explicit read-only, free, keyless personal
// project lookup through a pinned official API. No arbitrary URL fetch, model
// prompt, private calendar context, database writes, or durable search history.
const SEARCH_URL = 'https://www.themealdb.com/api/json/v1/1/search.php'
const MAX_RESPONSE = 500_000

export function normalizePublicRecipeQuery(raw) {
  if (typeof raw !== 'string' || raw.length > 70) return null
  const query = raw.trim().replace(/\s+/g, ' ')
  if (query.length < 2 || query.length > 60 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9 '-]*$/.test(query) ||
      /(?:@|https?:|www\.|password|secret|token|address)/i.test(query)) return null
  return query
}

function publicMeal(item) {
  if (!item || typeof item !== 'object' || !/^\d{4,12}$/.test(String(item.idMeal))) return null
  const name = typeof item.strMeal === 'string'
    ? item.strMeal.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 110) : ''
  if (!name) return null
  const category = typeof item.strCategory === 'string'
    ? item.strCategory.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 45) : ''
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 110)
  if (!slug) return null
  const url = 'https://www.themealdb.com/meal/' + item.idMeal + '-' + slug + '-Recipe'
  return { name, category, url }
}

export async function searchPublicRecipes(rawQuery, { fetchImpl = fetch } = {}) {
  const query = normalizePublicRecipeQuery(rawQuery)
  if (!query) throw new TypeError('Invalid generic recipe lookup.')
  const url = new URL(SEARCH_URL)
  url.searchParams.set('s', query)
  const response = await fetchImpl(url.toString(), {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8_000),
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error('Public recipe provider is unavailable.')
  const length = Number(response.headers?.get?.('content-length') ?? 0)
  if (length > MAX_RESPONSE) throw new Error('Public recipe payload exceeds limit.')
  const body = await response.text()
  if (body.length > MAX_RESPONSE) throw new Error('Public recipe payload exceeds limit.')
  const parsed = JSON.parse(body)
  if (!parsed || (parsed.meals !== null && !Array.isArray(parsed.meals))) {
    throw new Error('Public recipe provider returned an invalid response.')
  }
  const seen = new Set()
  const recipes = []
  for (const item of parsed.meals ?? []) {
    const meal = publicMeal(item)
    if (!meal || seen.has(meal.url)) continue
    seen.add(meal.url)
    recipes.push(meal)
    if (recipes.length >= 5) break
  }
  return { recipes, provider: 'TheMealDB' }
}
