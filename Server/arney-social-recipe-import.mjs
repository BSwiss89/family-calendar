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

const INGREDIENT_HEADING = /^(?:ingredients?|what you(?:'|’)ll need|you will need)\s*(?::|[-–—])?\s*(.*)$/i
const STEP_HEADING = /^(?:instructions?|directions?|method|steps?|how to (?:make|cook)(?: this| it)?|preparation)\s*(?::|[-–—])?\s*(.*)$/i
const TITLE_HEADING = /^(?:recipe|dish|title)\s*:\s*(.{3,120})$/i
const LIST_MARKER = /^\s*(?:[-*•·▪◦]\s*|\d{1,2}[.)]\s+)\s*/
const DISCARD = /^(?:#.*|follow (?:me|us)|link in (?:my |our )?bio|save (?:this|for later)|(?:https?:\/\/|www\.)\S+)$/i
function cleanLine(line) {
  return line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
}
function withoutListMarker(line) { return line.replace(LIST_MARKER, '').trim() }

export function parseSocialRecipeCaption(value) {
  if (typeof value !== 'string' || value.length > MAX_CAPTION)
    throw new TypeError('The optional pasted caption is too long.')
  const lines = value.replace(/\r\n?/g, '\n').split('\n').map(cleanLine)
  let section = '', title = '', explicitTitle = false
  const ingredients = [], steps = []
  for (const line of lines) {
    if (!line) continue
    let match = TITLE_HEADING.exec(line)
    if (match) { title = match[1].trim(); explicitTitle = true; continue }
    match = INGREDIENT_HEADING.exec(line)
    if (match) {
      section = 'ingredients'
      if (match[1]) ingredients.push(withoutListMarker(match[1]))
      continue
    }
    match = STEP_HEADING.exec(line)
    if (match) {
      section = 'instructions'
      if (match[1]) steps.push(withoutListMarker(match[1]))
      continue
    }
    if (DISCARD.test(line)) continue
    if (section === 'ingredients') {
      if (ingredients.length < 80 && line.length <= 260)
        ingredients.push(withoutListMarker(line))
      continue
    }
    if (section === 'instructions') {
      if (steps.length < 80) steps.push(withoutListMarker(line).slice(0, 500))
      continue
    }
    // The first caption line is only a suggested title, never fabricated.
    if (!title && line.length >= 4 && line.length <= 110 && !/^[#@]/.test(line)) {
      title = line.replace(/^["'“”]+|["'“”]+$/g, '').trim()
    }
  }
  return {
    name: title.slice(0, 110),
    titleIsExplicit: explicitTitle,
    ingredients: ingredients.filter(Boolean).join('\n').slice(0, 7000),
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
