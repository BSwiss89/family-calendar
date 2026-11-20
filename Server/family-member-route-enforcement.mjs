// PRIVATE-LOOPBACK pilot: server-owned action classification for a *verified*
// signed-in account. This file is NOT authorization by People avatar or UI.
// Unknown HTTP API routes FAIL CLOSED until reviewed and classified.
import { canFamilyMemberAct, getFamilyMemberAuthorization } from './family-member-access.mjs'

const VIEWS = new Map([
  ['/api/events', 'calendar.view'],
  ['/api/people', 'calendar.view'],
  ['/api/lists', 'lists.view'],
  ['/api/shopping-stores', 'lists.view'],
  ['/api/recipes', 'recipes.view'],
  ['/api/meal-plans', 'recipes.view'],
  ['/api/meal-plan-items', 'recipes.view'],
  ['/api/capture-inbox', 'recipes.view'],
  ['/api/event-creators', 'calendar.view'],
  ['/api/shared-events/recipients', 'calendar.view'],
  ['/api/shared-events/invitations', 'calendar.view'],
  ['/api/shared-events/sent', 'calendar.view'],
  ['/api/shared-events/accepted', 'calendar.view'],
  ['/api/ai/calendar-lookup', 'calendar.view'],
  ['/api/ai-budget', 'settings.manage'],
])

const READ_ONLY_POSTS = new Map([
  ['/api/ai/intent', 'calendar.view'],
  ['/api/ai/event-action-interpret', 'calendar.view'],
  ['/api/ai/event-action-preview', 'calendar.view'],
  ['/api/ai/recipe-search', 'recipes.view'],
  ['/api/arney/social-recipe-preview', 'recipes.view'],
  ['/api/arney/social-recipe-video-preview', 'recipes.view'],
  ['/api/arney/public-recipe-image', 'recipes.view'],
])

function validPath(method, originalUrl) {
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null
  if (typeof originalUrl !== 'string' || !originalUrl.startsWith('/api/')) return null
  const path = originalUrl.split('?')[0]
  if (!/^\/api\/[a-z0-9/_-]+$/.test(path) || path.includes('//')) return null
  // Do not accept Express aliases or encoded/trailing-slash path variants.
  if (!['GET', 'HEAD'].includes(method) && originalUrl.includes('?')) return null
  return path
}

/** Returns a list of permissions, or null to deny an unknown API route. */
export function requiredFamilyMemberActions(method, originalUrl) {
  const route = validPath(method, originalUrl)
  if (!route) return null
  if (method === 'GET' || method === 'HEAD') {
    const direct = VIEWS.get(route)
    if (direct) return [direct]
    if (/^\/api\/daily-notes\/[0-9-]+$/.test(route)) return ['calendar.view']
    return null
  }
  if (method === 'POST') {
    if (READ_ONLY_POSTS.has(route)) return [READ_ONLY_POSTS.get(route)]
    if (route === '/api/events') return ['events.create']
    if (route === '/api/ai/event-action-confirm') {
      // Confirmed Arney edit-or-delete is opaque until after the signed
      // preview is verified; require BOTH, never edit as a delete bypass.
      return ['events.edit', 'events.delete']
    }
    if (route === '/api/shared-events/invite') return ['events.create']
    if (/^\/api\/shared-events\/[1-9][0-9]*\/respond$/.test(route)) return ['events.edit']
    if (/^\/api\/shared-events\/[1-9][0-9]*\/revoke$/.test(route)) return ['events.delete']
    if (route === '/api/lists' || /^\/api\/lists\/[1-9][0-9]*\/(items|organize|sort-stores)$/.test(route) ||
      route === '/api/shopping-stores') return ['lists.edit']
    if (route === '/api/recipes') return ['recipes.edit']
    if (route === '/api/people') return ['settings.manage']
    return null
  }
  if (method === 'PUT' || method === 'PATCH') {
    if (method === 'PUT' && /^\/api\/events\/[1-9][0-9]*$/.test(route)) return ['events.edit']
    if (method === 'PUT' && (/^\/api\/lists\/[1-9][0-9]*\/(reorder|icon|store-sorting)$/.test(route) ||
      /^\/api\/list-items\/[1-9][0-9]*$/.test(route) ||
      /^\/api\/shopping-stores\/[1-9][0-9]*$/.test(route))) return ['lists.edit']
    if (method === 'PUT' && (/^\/api\/recipes\/[1-9][0-9]*$/.test(route) ||
      /^\/api\/meal-plans\/[0-9-]+$/.test(route) ||
      /^\/api\/meal-plan-items\/[0-9-]+\/[a-z]+$/.test(route))) return ['recipes.edit']
    if (method === 'PUT' && (route === '/api/people/reorder' ||
      /^\/api\/people\/[1-9][0-9]*$/.test(route) ||
      /^\/api\/daily-notes\/[0-9-]+$/.test(route))) return ['settings.manage']
    return null
  }
  if (method === 'DELETE') {
    if (/^\/api\/events\/[1-9][0-9]*$/.test(route) ||
      /^\/api\/shared-events\/[1-9][0-9]*\/received$/.test(route)) return ['events.delete']
    if (/^\/api\/lists\/[1-9][0-9]*(\/completed)?$/.test(route) ||
      /^\/api\/list-items\/[1-9][0-9]*$/.test(route)) return ['lists.edit']
    if (/^\/api\/recipes\/[1-9][0-9]*$/.test(route) ||
      /^\/api\/meal-plans\/[0-9-]+$/.test(route) ||
      /^\/api\/meal-plan-items\/[0-9-]+\/[a-z]+$/.test(route)) return ['recipes.edit']
    if (/^\/api\/people\/[1-9][0-9]*$/.test(route)) return ['settings.manage']
    return null
  }
  return null
}

/** Reject requests without a server-verified session and current membership. */
export function authorizeFamilyMemberApiRequest(identityDatabase, {
  serverVerifiedUserId, householdId, method, originalUrl,
}) {
  const member = getFamilyMemberAuthorization(identityDatabase, {
    householdId, serverVerifiedUserId,
  })
  if (!member) return { allowed: false, reason: 'unconfigured-or-revoked' }
  const required = requiredFamilyMemberActions(method, originalUrl)
  if (!required) return { allowed: false, reason: 'unreviewed-route' }
  if (!required.every(action => canFamilyMemberAct(member, action))) {
    return { allowed: false, reason: 'permission-denied' }
  }
  return { allowed: true, memberType: member.role }
}

/**
 * One opt-in middleware before BOTH gateway-owned Arney/shared routes and
 * the catch-all backend proxy. Never trust actor, role, Person selection,
 * action label or household from request JSON, headers or browser storage.
 */
export function installPrivateMemberRouteEnforcement(app, {
  identityDatabase, trustedHousehold,
}) {
  if (!identityDatabase || typeof trustedHousehold !== 'function') {
    throw new Error('Trusted central identity and household resolver required.')
  }
  app.use((request, response, next) => {
    if (!request.path.startsWith('/api/')) return next()
    // The auth module and household administration own their own guarded
    // routes and remain accessible to Owner and a minimally enrolled member.
    if (request.path === '/api/health' ||
        request.path.startsWith('/api/auth/') ||
        request.path === '/api/households' ||
        request.path.startsWith('/api/households/')) return next()
    const household = trustedHousehold(request, response)
    if (!household) return
    let decision
    try {
      decision = authorizeFamilyMemberApiRequest(identityDatabase, {
        serverVerifiedUserId: request.familyAccount?.user_id,
        householdId: household.householdId,
        method: request.method,
        originalUrl: request.originalUrl,
      })
    } catch (error) {
      console.error('Family member route policy unavailable:', error?.message)
      return response.status(503).json({ error: 'Family permissions temporarily unavailable.' })
    }
    if (!decision.allowed) {
      response.set('Cache-Control', 'no-store')
      return response.status(403).json({ error: 'This account cannot use that calendar action.' })
    }
    next()
  })
}
