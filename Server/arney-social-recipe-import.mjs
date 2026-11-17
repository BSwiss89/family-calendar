// Phase 1: on-demand, authenticated import of user-supplied public Instagram
// and Facebook links plus optional caption text. No scraping, credentials,
// downloaded videos, image reuse, account crawling or generated recipe facts.
// Meta oEmbed can confirm availability; it does NOT provide recipe data.
const IG_HOSTS = new Set(['instagram.com', 'www.instagram.com'])
const FB_HOSTS = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com'])
const META_ORIGIN = 'https://graph.facebook.com'
const MAX_URL = 1800
const MAX_CAPTION = 10000

export function normalizeSocialRecipeUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL || !value.trim())
    throw new TypeError('Paste a public Instagram or Facebook post link.')
  let link
  try { link = new URL(value.trim()) }
  catch { throw new TypeError('Enter a full HTTPS Instagram or Facebook post URL.') }
  if (link.protocol !== 'https:' || link.username || link.password ||
      link.port || link.hash || link.hostname.endsWith('.')) {
    throw new TypeError('Only ordinary public HTTPS post links are accepted.')
  }
  const host = link.hostname.toLowerCase()
  const instagram = IG_HOSTS.has(host)
  const facebook = FB_HOSTS.has(host)
  if (!instagram && !facebook)
    throw new TypeError('Use an Instagram or Facebook post or Reel URL.')
  // No open redirects. We never fetch the user URL; the only outbound request
  // is to Meta's fixed graph.facebook.com oEmbed API host.
  const path = link.pathname
  if (instagram && !/^\/(?:p|reel|tv)\/[A-Za-z0-9_-]{5,70}\/?$/.test(path))
    throw new TypeError('Use the direct Instagram post or Reel link.')
  const facebookPath = /^\/(?:share\/(?:r|v|p)\/[A-Za-z0-9_-]{5,90}|reel\/[A-Za-z0-9_-]{5,90}|(?:[^/]+\/)?(?:posts|videos)\/[A-Za-z0-9_.-]{5,100})\/?$/.test(path)
  const facebookWatch = path === '/watch/' || path === '/watch'
  const facebookPermalink = path === '/permalink.php'
  if (facebook && !facebookPath &&
      !(facebookWatch && /^[0-9]{5,30}$/.test(link.searchParams.get('v') ?? '')) &&
      !(facebookPermalink &&
        /^[0-9]{5,30}$/.test(link.searchParams.get('story_fbid') ?? '') &&
        /^[0-9]{5,30}$/.test(link.searchParams.get('id') ?? ''))) {
    throw new TypeError('Use a direct Facebook post, Reel or video link.')
  }
  const safe = new URL('https://' + (instagram ? 'www.instagram.com' : 'www.facebook.com') + path)
  if (facebookWatch) safe.searchParams.set('v', link.searchParams.get('v'))
  if (facebookPermalink) {
    safe.searchParams.set('story_fbid', link.searchParams.get('story_fbid'))
    safe.searchParams.set('id', link.searchParams.get('id'))
  }
  return {
    platform: instagram ? 'Instagram' : 'Facebook',
    url: safe.href,
    endpoint: instagram ? 'instagram_oembed' :
      (/\/(?:reel|videos)\//.test(path) || /^\/share\/[rv]\//.test(path) || facebookWatch)
        ? 'oembed_video' : 'oembed_post',
  }
}

const INGREDIENT_HEADING = /^(?:ingredients?(?:\s+list)?|what you(?:'|’)ll need|what you need|you will need|you need|for the (?:chicken|sauce|pasta|rice|marinade|dressing|seasoning|bowl|vegetables|veggies))\s*(?:\([^)]{1,60}\))?\s*(?::|[-–—])?\s*(.*)$/i
const STEP_HEADING = /^(?:instructions?|directions?|method|steps?|how to (?:make|cook)(?: this| it)?|preparation|how it's made|how to prepare|cooking instructions?)\s*(?::|[-–—])?\s*(.*)$/i
// Creator descriptions often divide ingredient lists into multiple parts and
// place a sauce/toppings section AFTER their first Instructions heading.
// Those new ingredients must never be discarded as instructions.
// Instagram creators may put a complete recipe in a verified or pasted
// pinned comment without an "Ingredients" heading. Preserve explicit
// component labels ("Chili Chicken Thighs", "Sticky Gochujang Glaze",
// "To Serve") rather than treating them as ingredients or recipe titles.
const COMMENT_INGREDIENT_PART_HEADING = /^(?:to serve|(?:[\p{L}\p{N}'’&-]+\s+){0,5}(?:chicken(?:\s+thighs?)?|thighs?|glaze|marinade|dressing|sauce|toppings?|garnish))\s*:\s*$/iu
const COMMENT_RECIPE_MARKER = /^recipe\s*:?\s*$/i
const INGREDIENT_PART_HEADING = /^(?:(?:for\s+(?:the\s+|a\s+)?)?(?:sauce|marinade|dressing|glaze|toppings?|garnish|seasoning(?:\s+mix)?|spice\s+(?:mix|blend)|filling|crust|chicken|rice|pasta|vegetables|veggies|salad|assembly|bowl|protein)(?:\s+ingredients?)?|(?:[\p{L}\p{N}'’&-]+(?:\s+[\p{L}\p{N}'’&-]+){0,4})\s+ingredients?)\s*(?:\([^)]{1,60}\))?\s*[:\-–—]?\s*$/iu
const STRONG_INGREDIENT = /^(?:\d+(?:[.,]\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞])\s*(?:g|kg|mg|grams?|ml|l|liters?|oz|lbs?|pounds?|cups?|tbsp|tsp|tablespoons?|teaspoons?|cloves?|slices?|pieces?)\b/i
const TITLE_HEADING = /^(?:recipe|dish|title)\s*:\s*(.{3,120})$/i
const LIST_MARKER = /^\s*(?:[-*•·▪◦]\s*|\d{1,2}[.)]\s+)\s*/
const DISCARD = /^(?:#.*|follow (?:me|us)|link in (?:my |our )?bio|save (?:this|for later)|(?:https?:\/\/|www\.)\S+)$/i
function cleanLine(line) {
  return line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
}
function withoutListMarker(line) { return line.replace(LIST_MARKER, '').trim() }

// Only use a fallback when the caption has no parseable section labels.
// Keep these deterministic: never turn a general promotional sentence into a recipe.
const COOKING_ACTION = /^(?:preheat|heat|cook|bake|fry|air.?fry|boil|simmer|grill|roast|toast|mix|stir|blend|whisk|combine|add|pour|season|marinate|chop|dice|slice|drain|serve|place|spread|brush|flip|transfer|cut|coat|sauté|saute|prepare|remove|let|line|top|finish|toss|put|cover)\b/i
const MEASURED_INGREDIENT = /^(?:(?:\d+(?:[.,]\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞])\s*(?:(?:g|kg|mg|ml|l|oz|lb|lbs|cups?|tbsp|tsp|tablespoons?|teaspoons?|cloves?|slices?|pinch(?:es)?|pieces?)\b|[a-z][a-z -]{2,70}\b))/i
function extractCaptionFallback(lines, type) {
  const found = []
  for (const line of lines) {
    if (found.length >= 80 || line.length > (type === 'ingredients' ? 260 : 500)) continue
    if (DISCARD.test(line) || /\b(?:calories|carbs|protein|macros)\b/i.test(line)) continue
    const text = withoutListMarker(line)
    if (type === 'ingredients') {
      const bullet = /^[-*•·▪◦]\s*/.test(line)
      if (bullet && (MEASURED_INGREDIENT.test(text) ||
        (text.length <= 130 && !COOKING_ACTION.test(text) && !/:$/.test(text)))) found.push(text)
    } else {
      const numbered = /^\d{1,2}[.)]\s+/.test(line)
      if (numbered && COOKING_ACTION.test(text)) found.push(text)
    }
  }
  return found
}


// Some creators write "introduction -> recipe title -> plain ingredient list
// -> Instructions" without an Ingredients heading or bullet markers.
// Only infer a list when several short, explicit quantity lines form a
// contiguous recipe-like block before Instructions. Never treat intro prose,
// the Reel's visible contents, or model guesses as measurements.
const UNLABELED_AMOUNT = /^(?:\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?(?:\s+\d+\/\d+)?|\d+\/\d+|[¼½¾⅓⅔⅛⅜⅝⅞])\s+(?:[\p{L}][\p{L}\p{N}'’,/-]*\s*){1,25}$/iu
const NON_RECIPE_INTRO = /^(?:this (?:was|is|recipe)|we (?:made|love|tried)|i (?:made|love|tried)|save this|you (?:need|have)|follow|link in|so (?:good|easy)|who (?:else|wants)|here(?:'s| is))\b/i
function likelyStandaloneRecipeTitle(line) {
  const candidate = line.trim().replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '')
  return candidate.length >= 3 && candidate.length <= 100 &&
    candidate.split(/\s+/).length <= 14 &&
    !NON_RECIPE_INTRO.test(candidate) &&
    !/[.!?;:]/.test(candidate) &&
    !/^\d/.test(candidate) &&
    !/^(?:macros?|calories|servings?|ingredients?|instructions?|directions?|recipe)\b/i.test(candidate) &&
    !COOKING_ACTION.test(candidate) &&
    !DISCARD.test(candidate)
}
function looksLikeUnlabeledMeasuredIngredient(line) {
  if (!line || line.length > 170 || /[.!?]$/.test(line) || /:\s+\S/.test(line)) return false
  const text = withoutListMarker(line)
  return UNLABELED_AMOUNT.test(text) &&
    !COOKING_ACTION.test(text) &&
    !/^\d+(?:[.,]\d+)?\s*(?:calories?|kcal|protein|carbs?|fat)\b/i.test(text)
}
function inferUnlabeledIngredientBlock(lines) {
  // Explicit headings keep using the existing, stronger section parser.
  const instructionsAt = lines.findIndex(line => STEP_HEADING.test(line.replace(/^[^\p{L}\p{N}]+/u, '')))
  const limit = instructionsAt < 0 ? lines.length : instructionsAt
  if (lines.slice(0, limit).some(line =>
    INGREDIENT_HEADING.test(line.replace(/^[^\p{L}\p{N}]+/u, '')) ||
    INGREDIENT_PART_HEADING.test(line.replace(/^[^\p{L}\p{N}]+/u, '')) ||
    COMMENT_INGREDIENT_PART_HEADING.test(line.replace(/^[^\p{L}\p{N}]+/u, '')))) return null
  const measured = []
  for (let i = 0; i < limit; i++) {
    if (looksLikeUnlabeledMeasuredIngredient(lines[i])) measured.push(i)
  }
  if (measured.length < 3) return null
  // A long unrelated block of numeric claims is not an ingredient list.
  const first = measured[0], last = measured.at(-1)
  if (last - first > 30 || !measured.some((n, i) => i > 0 && n - measured[i - 1] <= 2)) return null
  const indices = new Set(measured)
  for (let i = first; i <= last; i++) {
    const text = lines[i]
    if (!text || indices.has(i)) continue
    // Allow short unmeasured items such as "Salt and pepper" or "Fresh parsley".
    if (text.length <= 130 && !NON_RECIPE_INTRO.test(text) &&
        !COOKING_ACTION.test(withoutListMarker(text)) &&
        !/[!?]$/.test(text) && !/:\s+\S/.test(text) &&
        !DISCARD.test(text)) indices.add(i)
  }
  // No unmeasured prose outside the measured block becomes an ingredient.
  let title = ''
  for (let i = first - 1; i >= 0; i--) {
    if (!lines[i]) continue
    if (likelyStandaloneRecipeTitle(lines[i])) title = lines[i].trim()
    break
  }
  return { indices, title }
}

export function parseSocialRecipeCaption(value) {
  if (typeof value !== 'string' || value.length > MAX_CAPTION)
    throw new TypeError('The optional pasted caption is too long.')
  const lines = value.replace(/\r\n?/g, '\n').split('\n').map(cleanLine)
  const inferred = inferUnlabeledIngredientBlock(lines)
  let section = '', title = inferred?.title ?? '', explicitTitle = false, ingredientSection = ''
  const ingredients = [], steps = [], ingredientParts = []
  const componentName = value => value.replace(/^for\s+(?:the\s+|a\s+)?/i,'')
    .replace(/\([^)]*\)/g,'').replace(/\s+ingredients?$/i,'')
    .replace(/[:\-–—]+$/,'').trim().toLowerCase()
  function addIngredient(text) {
    const ingredient = withoutListMarker(text)
    if (!ingredient || ingredient.length > 260 || ingredients.length >= 80) return
    ingredients.push(ingredient)
    ingredientParts.push({ line: ingredient, section: ingredientSection })
  }
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    if (!line) continue
    // A verified quantity-based list takes priority over model-extracted guesses.
    if (inferred?.indices.has(lineIndex)) {
      section = 'ingredients'
      ingredientSection = ''
      addIngredient(line)
      continue
    }
    // Social captions often prefix section headings with cooking emojis.
    const headingLine = line.replace(/^[^\p{L}\p{N}]+/u, '')
    // A standalone "📌 RECIPE:" is a marker, not a title or ingredient.
    if (COMMENT_RECIPE_MARKER.test(headingLine)) continue
    let match = TITLE_HEADING.exec(headingLine)
    if (match) { title = match[1].trim(); explicitTitle = true; continue }
    match = INGREDIENT_HEADING.exec(headingLine)
    if (match) {
      section = 'ingredients'
      ingredientSection = /^for\s+(?:the\s+|a\s+)?/i.test(headingLine)
        ? componentName(headingLine.replace(match[1] || '', '')) : ''
      if (match[1] && /[\p{L}\p{N}]/u.test(match[1])) addIngredient(match[1])
      continue
    }
    // Recipe component headings may appear before or after cooking directions.
    // Recognize only short standalone titles, not arbitrary prose.
    if (INGREDIENT_PART_HEADING.test(headingLine) ||
        COMMENT_INGREDIENT_PART_HEADING.test(headingLine)) {
      section = 'ingredients'
      ingredientSection = componentName(headingLine)
      continue
    }
    match = STEP_HEADING.exec(headingLine)
    if (match) {
      section = 'instructions'
      if (match[1] && /[\p{L}\p{N}]/u.test(match[1])) steps.push(withoutListMarker(match[1]))
      continue
    }
    if (DISCARD.test(line)) continue
    // Pinned comments often contain "•1. Line an air fryer rack..." with a
    // bullet AND a numbered cooking step. The bullet is not an ingredient.
    const numberedCookingLine = /^\s*(?:[-*•·▪◦]\s*)?\d{1,2}[.)]\s+(.+)$/.exec(line)
    if (numberedCookingLine && (section === 'instructions' || COOKING_ACTION.test(numberedCookingLine[1]))) {
      section = 'instructions'
      if (steps.length < 80) steps.push(numberedCookingLine[1].slice(0, 500))
      continue
    }
    // A separately bulleted measured ingredient that follows instructions
    // belongs in Ingredients, not simultaneously in the cooking directions.
    if (section === 'instructions' && /^[-*•·▪◦]\s+/.test(line) &&
        STRONG_INGREDIENT.test(withoutListMarker(line)) &&
        !COOKING_ACTION.test(withoutListMarker(line))) {
      addIngredient(line)
      continue
    }
    if (section === 'ingredients') {
      addIngredient(line)
      continue
    }
    if (section === 'instructions') {
      if (steps.length < 80) steps.push(withoutListMarker(line).slice(0, 500))
      continue
    }
    // The first caption line is only a suggested title, never fabricated.
    if (!title && likelyStandaloneRecipeTitle(line)) {
      title = line.replace(/^["'“”]+|["'“”]+$/g, '').trim()
    }
  }
  // Always recover *clearly measured* bulleted ingredients even when another
  // section was already parsed. The previous all-or-nothing fallback silently
  // omitted separate ingredient groups after an Instructions heading.
  const normalized = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const seen = new Set(ingredients.map(normalized))
  for (const item of extractCaptionFallback(lines, 'ingredients')) {
    const key = normalized(item)
    if (seen.has(key) || !STRONG_INGREDIENT.test(item) || ingredients.length >= 80) continue
    ingredientSection = ''
    addIngredient(item)
    seen.add(key)
  }
  if (!steps.length) steps.push(...extractCaptionFallback(lines, 'instructions'))
  // Preserve creator-supplied serving count and nutrition without fabricating values.
  const servingsLabel = /\b(?:Makes|Serves)\s+(\d{1,3})\s+Servings?\b/i.exec(value)
  const servingsTotal = /\(\s*(\d{1,3})\s+Total\s*\)/i.exec(value)
  const servings = Number(servingsLabel?.[1] || servingsTotal?.[1] || 0)
  const macros = lines.find(line =>
    /\b\d{1,4}\s*(?:Calories|kcal)\b/i.test(line) &&
    /\bProtein\b/i.test(line) && /\bCarbs?\b/i.test(line) &&
    /\bFat\b/i.test(line))
  return {
    name: title.slice(0, 110),
    servings: servings >= 1 && servings <= 1000 ? String(servings) : '',
    notes: macros ? 'Creator-reported macros per serving: ' + macros.slice(0, 250) : '',
    titleIsExplicit: explicitTitle,
    ingredients: ingredients.filter(Boolean).join('\n').slice(0, 7000),
    ingredientParts,
    instructions: steps.filter(Boolean).join('\n').slice(0, 8000),
    suppliedCaption: Boolean(value.trim()),
  }
}

export async function previewSocialRecipe({ url, caption = '' } = {}, fetchMeta = fetch) {
  const source = normalizeSocialRecipeUrl(url)
  const recipe = parseSocialRecipeCaption(caption)
  let publicEmbedAvailable = false
  try {
    const api = new URL('/v27.0/' + source.endpoint, META_ORIGIN)
    api.searchParams.set('url', source.url)
    api.searchParams.set('omitscript', 'true')
    // No source URLs, captions, household data or credentials appear in logs.
    const response = await fetchMeta(api.href, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3500),
    })
    publicEmbedAvailable = response.ok
    await response.body?.cancel?.()
  } catch {
    // Private/removed post, rate limiting, offline server, or unavailable Meta.
    // The user's pasted caption remains editable, even without a public embed.
  }
  const missing = []
  if (!recipe.ingredients) missing.push('ingredients')
  if (!recipe.instructions) missing.push('instructions')
  return {
    platform: source.platform,
    sourceUrl: source.url,
    publicEmbedAvailable,
    name: recipe.name,
    titleIsExplicit: recipe.titleIsExplicit,
    ingredients: recipe.ingredients,
    instructions: recipe.instructions,
    suppliedCaption: recipe.suppliedCaption,
    missing,
    // This text reflects actual available fields, NOT a claim that the video
    // was watched or that a caption was fetched automatically from Meta.
    notice: recipe.suppliedCaption
      ? (missing.length
          ? 'Only explicitly labeled parts of the pasted caption were extracted. Add missing ' + missing.join(' and ') + ' yourself before saving.'
          : 'Ingredients and instructions were copied from your pasted caption. Review them before saving.')
      : 'A link alone does not expose recipe instructions. Paste the creator’s caption or type the recipe manually. Videos are not downloaded or transcribed.',
  }
}
