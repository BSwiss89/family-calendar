// Arney public recipe discovery. Only a generic dish/ingredient or sentinel
// 'any' goes to the fixed provider; full speech and family context stay local.
const RECIPE_NOUN = /\b(?:recipes?|dinners?|meals?|dishes?|breakfasts?|lunch(?:es)?|snacks?|food|dinner ideas?|casseroles?|picky eaters?)\b/i
const READ_START = /^(?:(?:hey\s+)?arney[,!\s]*)?(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:find|search|look\s+up|show|suggest|recommend|give)\b/i
const WRITE_START = /^(?:(?:hey\s+)?arney[,!\s]*)?(?:add|save|create|schedule|put|delete|remove|cancel|change|update|book|order|buy|plan)\b/i
const LOCAL = /\b(?:my|our|saved|existing|family's)\s+(?:favorite\s+)?recipes?\b/i
const KNOWN = ['chicken','salmon','shrimp','turkey','beef','pork','tofu','tuna','fish','lamb','rice','potatoes','mushrooms','pasta']
const DISH_ALIASES = [{pattern:/\bcasseroles?\b/i,value:'casserole'},
  {pattern:/\bquesadillas?\b/i,value:'quesadilla'},
  {pattern:/\bmeatballs?\b/i,value:'meatball'}]

export function parseArneyRecipeDiscovery(raw) {
  if (typeof raw !== 'string' || raw.length > 250 || /[\x00-\x1f\x7f]/.test(raw)) return null
  const prompt = raw.trim().replace(/[‘’]/g, "'").replace(/\s+/g, ' ')
  if (!prompt || WRITE_START.test(prompt) || !READ_START.test(prompt) ||
      !RECIPE_NOUN.test(prompt) || LOCAL.test(prompt)) return null
  const preferences = {
    onePot: /\b(?:one|single)[ -]?(?:pot|pan)\b/i.test(prompt),
    pasta: /\b(?:pasta|spaghetti|penne|macaroni|noodles|fettuccine)\b/i.test(prompt),
    kidFriendly: /\b(?:kid(?:s)?|child(?:ren)?|toddler|family)[ -]?friendly\b|\b(?:mild|not spicy|for (?:the )?kids)\b/i.test(prompt),
    easy: /\b(?:easy|simple|beginner|low[ -]?effort|few ingredients?)\b/i.test(prompt),
    quick: /\b(?:quick|fast|speedy|weeknight|busy weeknights?|30[ -]?minute|under \d+ minutes?)\b/i.test(prompt),
    purpose: /\b(?:picky eaters?|fussy eaters?)\b/i.test(prompt) ? 'picky' :
      /\b(?:budget[ -]?friendly|inexpensive|cheap)\b/i.test(prompt) ? 'budget' :
        /\b(?:healthy|nutritious|balanced)\b/i.test(prompt) ? 'healthy' :
          /\b(?:something different|new (?:dinner|meal) ideas?)\b/i.test(prompt) ? 'different' : '',
    method: /\b(?:air[ -]?fryer)\b/i.test(prompt) ? 'air-fryer' :
      /\b(?:slow[ -]?cooker|crock[ -]?pot)\b/i.test(prompt) ? 'slow-cooker' :
        /\b(?:breakfasts?)\b/i.test(prompt) ? 'breakfast' :
          /\b(?:casseroles?)\b/i.test(prompt) ? 'casserole' :
            /\b(?:fewer dishes|less cleanup|one[ -]?pot|one[ -]?pan)\b/i.test(prompt) ? 'low-cleanup' : '',
  }
  // A picky-eater request is kid oriented, but 'family dinner' alone
  // is not automatically a claim that every child will like it.
  if (preferences.purpose === 'picky') preferences.kidFriendly = true
  const stripped = prompt.replace(/^(?:(?:hey\s+)?arney[,!\s]*)?(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:find|search|look\s+up|show|suggest|recommend|give)(?:\s+me)?\b/i,' ')
    .replace(/\b(?:one|single)[ -]?(?:pot|pan)\b/gi,' ')
    .replace(/\b(?:kid(?:s)?|child(?:ren)?|toddler|family)[ -]?friendly\b|\bfor (?:the )?kids\b/gi,' ')
    .replace(/\b(?:easy|simple|beginner|low[ -]?effort|few ingredients?|quick|fast|speedy|weeknight|busy weeknights?|30[ -]?minute|under \d+ minutes?|budget[ -]?friendly|inexpensive|cheap|healthy|nutritious|balanced|picky eaters?|fussy eaters?|something different|new (?:dinner|meal) ideas?|air[ -]?fryer|slow[ -]?cooker|crock[ -]?pot|fewer dishes(?: to wash)?|less cleanup)\b/gi,' ')
    .replace(/\b(?:online|internet|web|search|recipes?|dinners?|meals?|dishes?|ideas?|mild|not spicy|for|with|using|some|any|a|an|the|me|please|that|are|in|of|tonight|today|busy|our|my|family|kids|children|show|give|something|ground|busy|weeknights?)\b/gi,' ')
    .replace(/[^A-Za-z0-9 ' -]/g,' ').replace(/\s+/g,' ').trim().toLowerCase()
  const main = KNOWN.find(word => new RegExp('\\b' + word + '\\b','i').test(stripped))
  const dish = DISH_ALIASES.find(x=>x.pattern.test(stripped))?.value
  const query = main || dish || (stripped && /^[a-z][a-z '-]{1,40}$/i.test(stripped) &&
    stripped.split(' ').length <= 3 && !/\b(?:wife|husband|family|personal|private|what|where|who|can|could|would|you|we|make|cook)\b/.test(stripped)
    ? stripped : null)
  if (query === 'pasta') preferences.pasta = false
  return { query: query ?? 'any', preferences }
}

export function normalizeArneyRecipeResults(payload) {
  if (!payload || !Array.isArray(payload.recipes)) return []
  const seen = new Set()
  const output = []
  for (const item of payload.recipes.slice(0, 30)) {
    if (!item || typeof item !== 'object' ||
        typeof item.id !== 'string' || !/^\d{4,12}$/.test(item.id) ||
        typeof item.name !== 'string' || !item.name.trim() || item.name.length > 110 ||
        typeof item.url !== 'string' ||
        !/^https:\/\/www\.themealdb\.com\/meal\/\d{4,12}-[a-z0-9-]+-Recipe$/i.test(item.url) ||
        !item.url.includes('/meal/' + item.id + '-') ||
        !Array.isArray(item.ingredients) || item.ingredients.length > 20 ||
        !item.ingredients.every(x => typeof x === 'string' && x.length <= 200) ||
        typeof item.instructions !== 'string' || item.instructions.length > 12000 ||
        seen.has(item.id)) continue
    seen.add(item.id)
    const image = typeof item.image === 'string' &&
      /^https:\/\/(?:www\.)?themealdb\.com\/images\/media\/meals\/[a-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(item.image)
      ? item.image : ''
    const clean = (x, max) => typeof x === 'string' ?
      x.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : ''
    output.push({
      id: item.id, name: clean(item.name,110), url:item.url, image,
      category: clean(item.category,45), area: clean(item.area,70),
      ingredients:item.ingredients.map(v=>v.trim()).filter(Boolean),
      instructions:item.instructions.trim(),
      matchNotes: Array.isArray(item.matchNotes) ? item.matchNotes.filter(x=>typeof x==='string').slice(0,3).map(x=>clean(x,80)) : [],
    })
  }
  return output
}
