// TEST-only Instagram creator-comment retrieval: one public endpoint,
// bounded cursor continuation, no cookies, login, extra hosts or fallback scrapers.
// The Reel owner identity comes from the yt-dlp metadata already read for its caption.
const API_ORIGIN = 'https://www.instagram.com'
const PAGE_LIMIT = 5
const COMMENT_LIMIT = 120
const RESPONSE_LIMIT_BYTES = 256 * 1024
const PAGE_TIMEOUT_MS = 6500
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function instagramShortcodeMediaId(sourceUrl) {
  let url
  try { url = new URL(sourceUrl) } catch { return '' }
  if (url.protocol !== 'https:' || url.hostname !== 'www.instagram.com') return ''
  const match = /^\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]{5,24})\/?$/.exec(url.pathname)
  if (!match) return ''
  let id = 0n
  for (const character of match[1]) {
    const digit = ALPHABET.indexOf(character)
    if (digit < 0) return ''
    id = id * 64n + BigInt(digit)
  }
  return String(id)
}

function verifiedCreator(metadata) {
  const name = typeof metadata?.channel === 'string'
    ? metadata.channel.trim().replace(/^@/, '').toLowerCase() : ''
  const id = metadata?.uploader_id
  const hasId = typeof id === 'string' || typeof id === 'number'
  return metadata?.extractor_key === 'Instagram' &&
    (/^[a-z0-9._]{1,30}$/.test(name) || (hasId && /^[0-9]{3,25}$/.test(String(id))))
}

function normalizeComment(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const node = input.node && typeof input.node === 'object' ? input.node : input
  const person = node.user || node.owner || {}
  const value = node.text
  if (typeof value !== 'string') return null
  return {
    author: typeof person.username === 'string' ? person.username : '',
    author_id: person.pk ?? person.id ?? null,
    text: value.slice(0, 6000),
    timestamp: node.created_at ?? node.timestamp ?? null,
    id: node.pk ?? node.id ?? null,
    is_pinned: node.is_pinned === true || node.pinned === true,
  }
}

function pageFromResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const wrapper = data.edge_media_to_parent_comment || data
  const raw = Array.isArray(wrapper.edges) ? wrapper.edges
    : Array.isArray(wrapper.comments) ? wrapper.comments
      : Array.isArray(data.comments) ? data.comments : null
  if (!raw) return null
  const comments = raw.map(normalizeComment).filter(Boolean)
  const pageInfo = wrapper.page_info || data.page_info || {}
  const more = data.has_more_comments === true ||
    data.has_more_headload_comments === true ||
    pageInfo.has_next_page === true
  // Some public Instagram comment responses use min_id (newer -> older),
  // older response shapes use max_id, and GraphQL uses end_cursor.
  const cursor = typeof data.next_min_id === 'string' && data.next_min_id
    ? { name:'min_id', value:data.next_min_id }
    : typeof data.next_max_id === 'string' && data.next_max_id
      ? { name:'max_id', value:data.next_max_id }
      : typeof pageInfo.end_cursor === 'string' && pageInfo.end_cursor
        ? { name:'max_id', value:pageInfo.end_cursor } : null
  return { comments, more, cursor }
}

async function readBoundedJson(response) {
  const length = Number(response.headers?.get('content-length') || 0)
  if (Number.isFinite(length) && length > RESPONSE_LIMIT_BYTES) return null
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > RESPONSE_LIMIT_BYTES) return null
      chunks.push(Buffer.from(value))
    }
  } finally {
    try { await reader.cancel() } catch { /* Reading is already finished. */ }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { return null }
}

function missing(reason, commentsExamined = 0, pagesChecked = 0) {
  return { text:'', source:'unavailable', creatorVerified:false,
    pinnedConfirmed:false, commentsExamined, pagesChecked, reason }
}

// This is the sole Instagram comment path. The caller passes the existing
// creator verifier, rather than adding a second identity or recipe classifier.
export async function readInstagramCreatorRecipePages(sourceUrl, metadata, {
  fetchImpl = fetch,
  selectComment,
} = {}) {
  const mediaId = instagramShortcodeMediaId(sourceUrl)
  if (!mediaId) return missing('invalid-instagram-url')
  if (!verifiedCreator(metadata) || typeof selectComment !== 'function')
    return missing('creator-metadata-unavailable')

  const seenIds = new Set()
  const seenCursors = new Set()
  const foundComments = []
  let cursor = null
  let pagesChecked = 0
  for (let pageNumber = 0; pageNumber < PAGE_LIMIT && foundComments.length < COMMENT_LIMIT; pageNumber++) {
    const url = new URL('/api/v1/media/' + mediaId + '/comments/', API_ORIGIN)
    url.searchParams.set('can_support_threading', 'true')
    url.searchParams.set('permalink_enabled', 'false')
    url.searchParams.set('sort_order', 'recent')
    if (cursor) url.searchParams.set(cursor.name, cursor.value)
    let response
    try {
      response = await fetchImpl(url.href, {
        method:'GET',redirect:'error',credentials:'omit',
        headers:{
          Accept:'application/json',
          'X-IG-App-ID':'936619743392459',
          'X-ASBD-ID':'359341',
          'X-IG-WWW-Claim':'0',
          Origin:API_ORIGIN,
          Referer:API_ORIGIN + '/',
        },
        signal:AbortSignal.timeout(PAGE_TIMEOUT_MS),
      })
    } catch { return missing('comment-network-unavailable', foundComments.length, pagesChecked) }
    pagesChecked++
    if (response.status === 401 || response.status === 403)
      return missing('comment-access-denied', foundComments.length, pagesChecked)
    if (response.status === 429)
      return missing('comment-rate-limited', foundComments.length, pagesChecked)
    if (!response.ok)
      return missing('comment-http-error', foundComments.length, pagesChecked)
    const body = await readBoundedJson(response)
    const parsed = pageFromResponse(body)
    if (!parsed) return missing('comment-invalid-page', foundComments.length, pagesChecked)
    for (const comment of parsed.comments) {
      if (foundComments.length >= COMMENT_LIMIT) break
      const identity = comment.id != null
        ? 'id:' + String(comment.id)
        : 'text:' + String(comment.author) + ':' + String(comment.timestamp) + ':' + comment.text
      if (seenIds.has(identity)) continue
      seenIds.add(identity)
      foundComments.push(comment)
    }
    const selected = selectComment({ ...metadata, comments:foundComments })
    if (selected?.creatorVerified && selected.text)
      return { ...selected, commentsExamined:foundComments.length,
        pagesChecked, reason:'creator-comment-found' }
    if (!parsed.more) return missing(
      foundComments.length ? 'no-verified-creator-recipe-in-returned-comments' : 'comments-not-exposed',
      foundComments.length, pagesChecked)
    if (!parsed.cursor || parsed.cursor.value.length > 2048 || seenCursors.has(parsed.cursor.name + ':' + parsed.cursor.value))
      return missing('comment-pagination-unavailable', foundComments.length, pagesChecked)
    seenCursors.add(parsed.cursor.name + ':' + parsed.cursor.value)
    cursor = parsed.cursor
  }
  return missing('comment-page-limit', foundComments.length, pagesChecked)
}
