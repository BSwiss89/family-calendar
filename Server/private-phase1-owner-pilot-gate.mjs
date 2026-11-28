// SOURCE-ONLY PHASE 1 pilot gate for the PRIVATE LOOPBACK gateway.
// This is a deliberately smaller surface than the full multi-household UI.
// Phase 1 tests invited household Owners and isolated events/lists/People.
// No Child/Adult APIs, photo uploads, AI writes, PIN/kiosk changes or unknown
// routes are accepted. Never enable from browser headers, query or cookies.
const OWNER_GET = new Set([
  '/api/health', '/api/households', '/api/households/my-onboarding',
  '/api/auth/landing',
  '/api/events', '/api/people', '/api/lists',
  '/api/shopping-stores', '/api/event-creators',
])
const OPERATOR_GET = new Set([
  '/api/health', '/api/admin/household-overview',
  '/api/admin/activation-readiness',
  '/api/households/independent-administration',
  '/api/admin/recovery/requests',
  '/api/auth/landing',
])
// Reviewed ordinary Owner features; no AI, device enrollment, notification,
// sharing or membership management expansion. Separate from the pilot default.
const DASHBOARD_GET=new Set(['/api/recipes','/api/meal-plans','/api/meal-plan-items','/api/emoji-markers','/api/family-daily-note'])
const DASHBOARD_POST=new Set(['/api/people','/api/recipes','/api/shopping-stores','/api/emoji-markers'])
const DASHBOARD_ASSETS=new Set(['/favicon.svg','/manifest.webmanifest','/apple-touch-icon.png','/calendar-icon-192.png','/calendar-icon-512.png','/calendar-icon.svg'])
const OWNER_POST = new Set([
  '/api/events', '/api/lists',
])
const OPERATOR_POST = new Set([
  '/api/households/independent-invitations',
])
const PATH_RE = /^\/[a-z0-9/_\-.]+$/
const MEDIA_PATH_RE = /^\/(?:uploads|api\/(?:capture|arney|ai))(?:\/|$)/

function canonicalRoute(method, originalUrl) {
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(method) ||
      typeof originalUrl !== 'string' || !originalUrl.startsWith('/') ||
      originalUrl.includes('\\') || originalUrl.includes('//')) return null
  const [pathname, ...query] = originalUrl.split('?')
  // Vite asset chunk hashes may legitimately contain uppercase letters.
  // Permit that spelling ONLY under the static /assets/ namespace, never
  // on API or uploaded-media paths (Express may otherwise normalize aliases).
  const staticAsset = /^\/assets\/[A-Za-z0-9._/-]+$/.test(pathname)
  const imageAsset = /^\/uploads\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(pathname)
  if ((pathname !== '/' && !PATH_RE.test(pathname) && !staticAsset && !imageAsset) ||
      pathname.includes('%') ||
      pathname.split('/').some(segment => segment === '.' || segment === '..') ||
      (pathname !== '/' && pathname.endsWith('/')) ||
      (query.length && !['GET', 'HEAD'].includes(method))) return null
  return pathname
}

/**
 * Explicit approved Owner or operator surface. GET is not automatically
 * safe: uploaded images, AI/image proxies and household settings can disclose
 * content and must be individually reviewed.
 */
export function classifyPrivatePhase1PilotRoute(method, originalUrl, role, {ownerDashboard=false}={}) {
  const pathname = canonicalRoute(method, originalUrl)
  if (!pathname || !['owner', 'operator'].includes(role)) return 'denied'
  // Browser shell/static JS is public presentation only. The route must
  // still pass authenticated central sessions and backend tenant selection.
  if (method === 'GET' || method === 'HEAD') {
    if (role === 'operator' && OPERATOR_GET.has(pathname)) return 'allowed'
    if (role === 'owner' && OWNER_GET.has(pathname)) return 'allowed'
    if(role==='owner'&&ownerDashboard){
      if(DASHBOARD_GET.has(pathname)||/^\/api\/daily-notes\/[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(pathname))return 'allowed'
      if(/^\/uploads\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(pathname)&&pathname.startsWith('/uploads/'))return 'allowed'
      if(pathname==='/'||DASHBOARD_ASSETS.has(pathname)||/^\/assets\/[A-Za-z0-9._-]+\.(?:js|css|png|jpg|jpeg|webp|svg|woff2?)$/.test(pathname))return 'presentation-only'
      if(['/my-household','/auth/my-household.js','/phase1','/auth/phase1-pilot.js','/auth/phase1-pilot.css','/system-admin','/system-admin/app.js','/system-admin/styles.css'].includes(pathname))return 'presentation-only'
      return 'denied'
    }
    if (pathname.startsWith('/api/') || pathname === '/api' ||
        MEDIA_PATH_RE.test(pathname)) return 'denied'
    // Login and operator pages/assets retain their own server role checks.
    // No backend upload path or unreviewed API response passes this gate.
    return 'presentation-only'
  }
  if (role === 'operator') {
    if (method === 'POST' && OPERATOR_POST.has(pathname)) return 'allowed'
    if (method === 'POST' && /^\/api\/admin\/households\/family-[a-f0-9]{24}\/activate$/.test(pathname)) return 'allowed'
    if (method === 'POST' && /^\/api\/admin\/recovery\/requests\/[1-9][0-9]*\/(?:issue|deny|reissue|revoke)$/.test(pathname)) return 'allowed'
    if (method === 'POST' &&
        /^\/api\/households\/independent-invitations\/[1-9][0-9]*\/revoke$/.test(pathname)) {
      return 'allowed'
    }
    return 'denied'
  }
  if (role !== 'owner') return 'denied'
  if(ownerDashboard){
    if(method==='POST'&&(DASHBOARD_POST.has(pathname)||/^\/api\/lists\/[1-9][0-9]*\/organize$/.test(pathname)||/^\/api\/emoji-markers\/[1-9][0-9]*\/(exceptions|change-occurrence|truncate)$/.test(pathname)))return 'allowed'
    if(method==='PUT'&&(/^\/api\/(?:people|recipes|shopping-stores|emoji-markers)\/[1-9][0-9]*$/.test(pathname)||pathname==='/api/people/reorder'||pathname==='/api/family-daily-note'||/^\/api\/daily-notes\/[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(pathname)||/^\/api\/lists\/[1-9][0-9]*\/(?:reorder|icon|store-sorting)$/.test(pathname)||/^\/api\/meal-plans\/[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(pathname)||/^\/api\/meal-plan-items\/[0-9]{4}-[0-9]{2}-[0-9]{2}\/[a-z]+$/.test(pathname)))return 'allowed'
    if(method==='DELETE'&&(/^\/api\/(?:people|recipes|emoji-markers)\/[1-9][0-9]*$/.test(pathname)||/^\/api\/lists\/[1-9][0-9]*\/completed$/.test(pathname)||/^\/api\/meal-plans\/[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(pathname)||/^\/api\/meal-plan-items\/[0-9]{4}-[0-9]{2}-[0-9]{2}\/[a-z]+$/.test(pathname)))return 'allowed'
  }
  if (method === 'POST') {
    if (OWNER_POST.has(pathname) ||
        /^\/api\/lists\/[1-9][0-9]*\/items$/.test(pathname)) return 'allowed'
  }
  if (method === 'PUT') {
    if (/^\/api\/events\/[1-9][0-9]*$/.test(pathname) ||
        /^\/api\/list-items\/[1-9][0-9]*$/.test(pathname)) return 'allowed'
  }
  if (method === 'DELETE') {
    if (/^\/api\/events\/[1-9][0-9]*$/.test(pathname) ||
        /^\/api\/lists\/[1-9][0-9]*$/.test(pathname) ||
        /^\/api\/list-items\/[1-9][0-9]*$/.test(pathname)) return 'allowed'
  }
  return 'denied'
}

/**
 * Runs strictly AFTER signed login/session/CSRF middleware and BEFORE all
 * downstream Owner/administrator routes or the otherwise permissive backend
 * proxy. Login/signup were already independently authenticated/validated.
 * Call only from a trusted, explicitly opted-in private-gateway startup.
 */
export function installPrivatePhase1OwnerPilotGate(app, {
  identityDatabase, trustedAdministratorUserIds, ownerDashboard=false,
}) {
  if (!identityDatabase?.prepare || !Array.isArray(trustedAdministratorUserIds) ||
      !trustedAdministratorUserIds.length ||
      trustedAdministratorUserIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error('Phase 1 gate requires a server-owned trusted operator allowlist.')
  }
  app.use((request, response, next) => {
    // Auth middleware intentionally leaves generic health public.
    if (['GET', 'HEAD'].includes(request.method) &&
        request.originalUrl === '/api/health') return next()
    const userId = request.familyAccount?.user_id
    if (!Number.isSafeInteger(userId) || userId < 1) {
      return response.status(401).json({ error: 'Verified family login required.' })
    }
    // The system operator receives only enrollment/metadata routes, never
    // another household's private API through a guessed household ID.
    const isOperator = trustedAdministratorUserIds.includes(userId) &&
      Boolean(identityDatabase.prepare([
        'SELECT 1 FROM family_users',
        "WHERE id=? AND disabled=0 AND account_kind='person'",
      ].join(' ')).get(userId))
    // Determine Owner from one current server-side household membership,
    // never a browser-supplied tenant selector, role, or People avatar.
    let role = isOperator ? 'operator' : null
    if (!role) {
      const memberships = identityDatabase.prepare([
        'SELECT m.role, h.storage_id FROM household_memberships m',
        'JOIN household_registry h ON h.id=m.household_id',
        'JOIN family_users u ON u.id=m.user_id',
        "WHERE m.user_id=? AND m.disabled=0 AND h.disabled=0",
        "AND u.disabled=0 AND u.account_kind='person'",
      ].join(' ')).all(userId)
      if (memberships.length === 1 && memberships[0].role === 'owner') {
        role = 'owner'
      }
    }
    const decision = classifyPrivatePhase1PilotRoute(
      request.method, request.originalUrl, role, {ownerDashboard},
    )
    if (decision === 'allowed' || decision === 'presentation-only') return next()
    response.set('Cache-Control', 'no-store')
    return response.status(404).json({ error: 'Not available in Phase 1 family pilot.' })
  })
}
