// Phase 4B: explicitly requested public recipe lookup. Never infer web access
// from calendar data, saved recipes, shopping lists, or a generic meal-plan request.
const WRITE_VERBS = /^(?:add|save|create|schedule|put|delete|remove|cancel|change|update|book|order|buy|plan)\b/i
const ONLINE = /\b(?:online|internet|the web|web search)\b/i
const RECIPE = /\b(?:recipes?|dinners?|meals?|dishes?)\b/i
const READ = /^(?:(?:hey\s+)?arney[,!\s]*)?(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:find|search|look\s+up|show|suggest|recommend|give|browse|what)\b/i

export function parseArneyPublicRecipeRequest(raw) {
  if (typeof raw !== 'string' || raw.length > 250) return null
  const question = raw.trim().replace(/[‘’]/g, "'").replace(/\s+/g, ' ')
  const bare = question.replace(/^(?:hey\s+)?arney[,!\s]*/i, '')
  if (!question || WRITE_VERBS.test(bare) || !READ.test(question) ||
      !ONLINE.test(question) || !RECIPE.test(question)) return null
  let query = bare
    .replace(/^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:find|search|look\s+up|show|suggest|recommend|give|browse|what)\s*/i, ' ')
    .replace(/\b(?:the\s+web|web\s+search|internet|online|recipes?|dinners?|meals?|dishes?|ideas?|cooking|cook|food|something|some|any|a|an|the|me|please|for|with|using|on|from|about|that|are|can|i|you|three|five|seven|3|5|7|easy|quick|healthy|new)\b/gi, ' ')
    .replace(/[^a-zA-Z0-9 '-]/g, ' ')
    .replace(/\s+/g, ' ').trim()
  if (/^(?:my|our|family|wife|husband|daughter|son)\b/i.test(query) ||
      query.length > 60 || query.split(' ').length > 5) return { query: null }
  // Only the selected generic food query leaves the family server.
  return { query: query || null }
}

export function formatArneyPublicRecipeReply(payload, query) {
  if (!payload || !Array.isArray(payload.recipes)) {
    return { kind: 'error', text: 'Online recipe results could not be verified. Nothing was saved.' }
  }
  const rows = payload.recipes.filter(item => item && typeof item.name === 'string' &&
    typeof item.url === 'string' && item.url.startsWith('https://www.themealdb.com/meal/')
  ).slice(0, 5)
  if (!rows.length) return {
    kind: 'information',
    text: 'No matching public recipes were found for "' + query + '". Try a simpler ingredient or dish name. Nothing was saved.',
  }
  const text = rows.map((r, i) => {
    const label = r.name.replace(/[\x00-\x1f]/g, ' ').slice(0, 110)
    const category = typeof r.category === 'string' && r.category.trim()
      ? ' (' + r.category.replace(/[\x00-\x1f]/g, ' ').slice(0, 45) + ')' : ''
    return (i + 1) + '. ' + label + category + '\n   ' + r.url
  }).join('\n')
  return {
    kind: 'information',
    text: 'Public recipes for "' + query + '" from TheMealDB:\n' +
      text + '\nThese are ideas only. No recipes, meals, lists, or events were saved.',
  }
}