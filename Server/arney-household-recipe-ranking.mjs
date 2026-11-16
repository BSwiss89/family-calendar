// Household-only, read-only learning for Arney recipe result ordering.
// Derives preferences from the existing household-specific SQLite recipes
// and meal-plan slots. No schema, tracking, profiles, ratings or writes.
// The fixed category score is applied locally AFTER public recipe search;
// nothing from household data is sent to TheMealDB.
const GROUPS = Object.freeze({
  chicken: /\b(?:chicken|poultry)\b/i,
  beef: /\b(?:beef|steak|brisket|sirloin)\b/i,
  pork: /\b(?:pork|bacon|ham|sausage)\b/i,
  turkey: /\bturkey\b/i,
  seafood: /\b(?:seafood|fish|salmon|shrimp|tuna|cod|tilapia|prawn|crab)\b/i,
  pasta: /\b(?:pasta|spaghetti|penne|macaroni|lasagna|lasagne|fettuccine|noodles?|linguine|alfredo|ravioli)\b/i,
  soup: /\b(?:soup|stew|chowder|bisque|broth|ramen)\b/i,
  casserole: /\b(?:casserole|bake|baked|gratin)\b/i,
  rice: /\b(?:rice|risotto)\b/i,
  pizza: /\bpizza\b/i,
  salad: /\bsalad\b/i,
  vegetarian: /\b(?:vegetarian|vegan|tofu|lentil|chickpea)\b/i,
  breakfast: /\b(?:breakfast|pancake|waffle|omelette|omelet|french toast)\b/i,
})

function text(value) {
  return typeof value === 'string' ? value.slice(0, 1000) : ''
}

export function classifyHouseholdMeal({ name, tags, category } = {}) {
  // Prefer names and explicit tags over ingredients. "Chicken broth" in
  // vegetable soup should not count as a chicken preference.
  const descriptor = [text(name), text(tags), text(category)].join(' ')
  return Object.keys(GROUPS).filter(group => GROUPS[group].test(descriptor))
}

export function readHouseholdRecipeHistory(database) {
  const saved = database.prepare(
    'SELECT name, tags FROM recipes ORDER BY id DESC LIMIT 1000'
  ).all()
  const planned = database.prepare(
    'SELECT meal_plan_items.title, recipes.name AS recipeName, ' +
    'recipes.tags AS recipeTags FROM meal_plan_items ' +
    'LEFT JOIN recipes ON recipes.id = meal_plan_items.recipe_id ' +
    'ORDER BY meal_plan_items.date DESC, meal_plan_items.id DESC LIMIT 2000'
  ).all()
  const counts = Object.create(null)
  const record = (meal, weight) => {
    for (const group of classifyHouseholdMeal(meal))
      counts[group] = (counts[group] ?? 0) + weight
  }
  for (const recipe of saved)
    record({ name: recipe.name, tags: recipe.tags }, 1)
  for (const slot of planned)
    record({ name: slot.recipeName || slot.title, tags: slot.recipeTags }, 2)
  return counts
}

export function reorderRecipesForHousehold(result, query, householdCounts) {
  // Keep the public provider response/cache, returned IDs and 25-result cap
  // untouched. Explicit ingredient/dish searches are NEVER reranked.
  if (!result || !Array.isArray(result.recipes) ||
      query !== 'any' || result.recipes.length < 2 ||
      !householdCounts || typeof householdCounts !== 'object')
    return result
  const entries = result.recipes.map((recipe, originalPosition) => {
    const groups = classifyHouseholdMeal(recipe)
    const weight = groups.reduce((sum, group) => {
      const raw = householdCounts[group]
      return sum + (Number.isFinite(raw) && raw > 0 ? raw : 0)
    }, 0)
    // Maximum movement: 7 slots. Popularity cannot erase underlying recipe
    // suitability or hide unpopular choices.
    const boost = Math.min(7, Math.floor(Math.log2(1 + weight) * 2))
    return { recipe, originalPosition, rank: originalPosition - boost }
  })
  entries.sort((a, b) => a.rank - b.rank || a.originalPosition - b.originalPosition)
  return { ...result, recipes: entries.map(x => x.recipe) }
}
