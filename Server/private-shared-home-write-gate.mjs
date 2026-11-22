// PRIVATE LOOPBACK multi-household pilot. An Owner-enrolled shared Home is
// NOT an unrestricted Owner session, even though its underlying cookie was
// issued during Owner device enrollment. A selected People avatar is NEVER an
// actor. This middleware must run before ALL household/Arney/proxy routes.
//
// Keep the supported kiosk mutation surface deliberately small until the
// remaining calendar, AI, task, photo and file APIs have separate reviews.
import { DatabaseSync } from 'node:sqlite'
import { canFamilyMemberAct } from './family-member-access.mjs'
import { requiredFamilyMemberActions } from './family-member-route-enforcement.mjs'
import { isPrivateHomeKioskTrusted } from './private-home-kiosk-identity.mjs'
import { readPrivateHomePinPolicy } from './private-home-pin-policy.mjs'
import { resolveHouseholdStorage } from './household-storage.mjs'

const SHARED_HOME_ACTIONS = new Set([
  'events.create', 'events.edit', 'lists.edit',
])

// Only these routes currently have reviewed synchronous household backend
// mutations. No unreviewed AI/voice/recipe/recurrence/administrative write can
// become a kiosk Owner write merely because Express recognizes that path.
function allowedKioskMutation(method, originalUrl) {
  if (typeof originalUrl !== 'string' || !originalUrl.startsWith('/api/') ||
      originalUrl.includes('?') || originalUrl.includes('%') ||
      originalUrl.includes('\\') || originalUrl.includes('//')) return false
  if (method === 'POST') {
    return originalUrl === '/api/events' ||
      originalUrl === '/api/lists' ||
      /^\/api\/lists\/[1-9][0-9]*\/items$/.test(originalUrl)
  }
  if (method === 'PUT') {
    return /^\/api\/events\/[1-9][0-9]*$/.test(originalUrl) ||
      /^\/api\/list-items\/[1-9][0-9]*$/.test(originalUrl) ||
      /^\/api\/lists\/[1-9][0-9]*\/(icon|reorder|store-sorting)$/.test(originalUrl) ||
      /^\/api\/shopping-stores\/[1-9][0-9]*$/.test(originalUrl)
  }
  if (method === 'DELETE') {
    return /^\/api\/events\/[1-9][0-9]*$/.test(originalUrl) ||
      /^\/api\/lists\/[1-9][0-9]*(\/completed)?$/.test(originalUrl) ||
      /^\/api\/list-items\/[1-9][0-9]*$/.test(originalUrl)
  }
  return false
}

const READ_ONLY_POSTS = new Set([
  '/api/ai/event-action-interpret', '/api/ai/event-action-preview',
  '/api/ai/intent', '/api/arney/local-transcription',
])

function currentEnrollment(db, sessionId) {
  if (!Number.isSafeInteger(sessionId) || sessionId < 1) return null
  return db.prepare([
    'SELECT h.storage_id AS householdId FROM private_home_kiosk_sessions k',
    'JOIN household_registry h ON h.id=k.household_id',
    'WHERE k.session_id=? AND k.disabled_at IS NULL',
  ].join(' ')).get(sessionId) ?? null
}

function decision(db, {
  householdId, sessionId, method, originalUrl,
  proof, householdDatabase, resolveHomeActorProof,
}) {
  const enrollment = currentEnrollment(db, sessionId)
  if (!enrollment) return { status: 'ordinary-session' }
  if (householdId !== enrollment.householdId ||
      !isPrivateHomeKioskTrusted(db, {
        householdId, serverVerifiedSessionId: sessionId,
      })) return { status: 'untrusted-home' }

  // Express may accept uppercase/trailing/encoded URL aliases. The kiosk
  // must not use one to bypass an exact permission classification.
  if (typeof originalUrl !== 'string' || !originalUrl.startsWith('/api/') ||
      !/^\/api\/[a-z0-9/_-]+$/.test(originalUrl.split('?')[0]) ||
      originalUrl.split('?')[0].includes('//') ||
      originalUrl.split('?')[0].endsWith('/')) {
    return { status: 'unreviewed-home-route' }
  }
  // Auth and administration are not routine Home actions. These PIN setup
  // routes were registered BEFORE the gate and require Owner password.
  if (/^\/api\/households(\/|$)/.test(originalUrl) &&
      !(method === 'GET' && originalUrl === '/api/households')) {
    return { status: 'unreviewed-home-route' }
  }
  if (['GET', 'HEAD'].includes(method)) {
    if (originalUrl === '/api/health' || originalUrl === '/api/event-creators' ||
        originalUrl === '/api/households') return { status: 'allowed-read' }
    return requiredFamilyMemberActions(method, originalUrl)
      ? { status: 'allowed-read' } : { status: 'unreviewed-home-route' }
  }
  if (method === 'POST' && READ_ONLY_POSTS.has(originalUrl)) {
    return { status: 'allowed-read' }
  }
  if (!allowedKioskMutation(method, originalUrl)) {
    return { status: 'unreviewed-home-route' }
  }

  const actions = requiredFamilyMemberActions(method, originalUrl)
  if (!actions?.length) return { status: 'unreviewed-home-route' }

  const policy = readPrivateHomePinPolicy(db, {
    householdId, serverVerifiedOwnerUserId:
      db.prepare('SELECT enrolled_by_user_id AS ownerId FROM private_home_kiosk_sessions WHERE session_id=?')
        .get(sessionId)?.ownerId,
  })
  if (!policy.pinEnabled) {
    if (!actions.every(action => SHARED_HOME_ACTIONS.has(action))) {
      return { status: 'permission-denied' }
    }
    return {
      status: 'allowed-write',
      attribution: { kind: 'shared-home', userId: null, personId: null },
      actions,
    }
  }
  if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) {
    return { status: 'pin-required' }
  }
  const actor = resolveHomeActorProof({
    householdId, serverVerifiedSessionId: sessionId, proof, householdDatabase,
  })
  if (!actor) return { status: 'pin-required' }
  if (!actions.every(action => canFamilyMemberAct(actor, action))) {
    return { status: 'permission-denied' }
  }
  return {
    status: 'allowed-write',
    attribution: {
      kind: 'verified-person', userId: actor.userId,
      personId: actor.personId, role: actor.role,
    },
    actions,
  }
}

export { decision as authorizePrivateHomeRequest }

export function installPrivateSharedHomeWriteGate(app, {
  identityDatabase, trustedHousehold, resolveHomeActorProof,
  serverDirectory, storageRoot,
}) {
  if (!identityDatabase || typeof trustedHousehold !== 'function' ||
      typeof resolveHomeActorProof !== 'function') {
    throw new Error('Verified household, session and Home actor proof resolver required.')
  }
  app.use((request, response, next) => {
    const sessionId = request.familyAccount?.id
    const enrollment = currentEnrollment(identityDatabase, sessionId)
    if (!enrollment) return next()
    if (!request.path.toLowerCase().startsWith('/api/')) return next()
    // This includes Owner-only /api/households routes and all unreviewed
    // writes: do NOT inherit the Owner cookie's authority on a shared display.
    const household = trustedHousehold(request, response)
    if (!household) return
    const isMutation = !['GET', 'HEAD'].includes(request.method)
    let calendarDb
    try {
      if (isMutation && allowedKioskMutation(request.method, request.originalUrl)) {
        const storage = resolveHouseholdStorage({
          serverDirectory, storageRoot, householdId: household.householdId,
        })
        calendarDb = new DatabaseSync(storage.databasePath, { readOnly: true })
      }
      const result = decision(identityDatabase, {
        householdId: household.householdId,
        sessionId, method: request.method, originalUrl: request.originalUrl,
        proof: request.get('x-fc-home-actor-proof'),
        householdDatabase: calendarDb, resolveHomeActorProof,
      })
      response.set('Cache-Control', 'no-store')
      if (result.status === 'allowed-write') {
        // Server-owned metadata ONLY, never derived from request.body.role,
        // request.body.actor or a selected People avatar.
        response.locals.privateHomeActor = result.attribution
        return next()
      }
      if (result.status === 'allowed-read') return next()
      if (result.status === 'pin-required') {
        return response.status(428).json({
          error: 'Verify your four-digit PIN on this shared calendar before making this change.',
          pinRequired: true,
        })
      }
      if (result.status === 'permission-denied') {
        return response.status(403).json({
          error: 'This person or shared Home cannot perform that calendar action.',
        })
      }
      return response.status(403).json({
        error: 'This shared calendar cannot access that protected action.',
      })
    } catch (error) {
      console.error('Shared Home authorization unavailable:', error?.message)
      response.set('Cache-Control', 'no-store')
      return response.status(503).json({ error: 'Home security temporarily unavailable.' })
    } finally {
      calendarDb?.close()
    }
  })
}
