// TEST-only bridge from the EXISTING single-calendar login/session database
// to the separate household-authorization database. No password hashes,
// session secrets or People data are copied. No new login is created.
//
// The legacy auth middleware MUST run first and set request.familyAccount
// from a valid HttpOnly cookie. This bridge independently rechecks the
// session and the central account mapping on every protected request.
// An unprovisioned/mismatched central account FAILS CLOSED.
import {
  getVerifiedFamilyMemberAuthorization, canFamilyMemberAct,
} from './family-member-access.mjs'
import { requiredFamilyMemberActions } from './family-member-route-enforcement.mjs'

const HOUSEHOLD_ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

export function verifyExistingTestLoginFamilyActor({
  loginDatabase, identityDatabase, householdId, authenticatedSession,
}) {
  if (!loginDatabase || !identityDatabase || loginDatabase === identityDatabase ||
      typeof loginDatabase.prepare !== 'function' ||
      typeof identityDatabase.prepare !== 'function' ||
      typeof householdId !== 'string' || !HOUSEHOLD_ID.test(householdId)) {
    throw new Error('Separate trusted login and identity databases are required.')
  }
  const sessionId = authenticatedSession?.id
  const userId = authenticatedSession?.user_id
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 ||
      !Number.isSafeInteger(userId) || userId <= 0 ||
      typeof authenticatedSession.username !== 'string') return null

  // Keep the existing TEST cookie and remembered sessions. Never replace
  // or reconstruct them from a client-provided role, username or People ID.
  const current = loginDatabase.prepare([
    'SELECT u.id AS userId, u.username, u.account_kind AS accountKind',
    'FROM family_sessions s JOIN family_users u ON u.id = s.user_id',
    'WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL',
    "AND s.expires_at > ? AND u.disabled = 0 AND u.account_kind = 'person'",
  ].join(' ')).get(sessionId, userId, Date.now())
  if (!current || current.username !== authenticatedSession.username) return null

  // Central access records are explicit OFFLINE administrative mappings,
  // not an automatic second account or a copy of the login password.
  const mapped = identityDatabase.prepare([
    'SELECT id FROM family_users WHERE id = ? AND username = ?',
    "AND disabled = 0 AND account_kind = 'person'",
  ].join(' ')).get(current.userId, current.username)
  if (!mapped) return null

  // A removed People profile can never authorize an assigned task.
  return getVerifiedFamilyMemberAuthorization(identityDatabase, {
    householdId, serverVerifiedUserId: current.userId,
    householdDatabase: loginDatabase,
  })
}

export function installExistingTestLoginFamilyPermissions(app, {
  loginDatabase, identityDatabase, householdId,
}) {
  if (!app || typeof app.use !== 'function' ||
      !loginDatabase || !identityDatabase || loginDatabase === identityDatabase ||
      typeof householdId !== 'string' || !HOUSEHOLD_ID.test(householdId)) {
    throw new Error('TEST family access needs authenticated app and separate trusted databases.')
  }

  // Called ONLY after installFamilyAuth(required). Its earlier routes handle
  // login, logout, current devices and selecting a cosmetic Home/Person view.
  // No routine PIN is required on an authenticated personal phone.
  app.get('/api/auth/my-family-access', (request, response) => {
    try {
      const actor = verifyExistingTestLoginFamilyActor({
        loginDatabase, identityDatabase, householdId,
        authenticatedSession: request.familyAccount,
      })
      response.set('Cache-Control', 'no-store')
      if (!actor) {
        return response.status(403).json({ error: 'Family access is not provisioned for this account.' })
      }
      return response.json({
        memberType: actor.role, linkedPersonId: actor.personId,
        allowedActions: actor.permissions,
      })
    } catch (error) {
      console.error('TEST family account lookup unavailable:', error?.message)
      return response.status(503).json({ error: 'Family access temporarily unavailable.' })
    }
  })

  app.use((request, response, next) => {
    const lower = request.path.toLowerCase()
    if (lower === '/api/health' && ['GET', 'HEAD'].includes(request.method)) return next()
    // The existing auth installer has already handled every supported
    // login, status, device and logout route above this middleware.
    // A NEW auth route introduced after this guard must not bypass review.
    if (lower.startsWith('/api/auth/')) {
      response.set('Cache-Control', 'no-store')
      return response.status(403).json({ error: 'Unreviewed account action.' })
    }
    // Uploads can contain private People photos; never expose them to an
    // account without current calendar-view authority. The legacy session
    // middleware already protects non-API browser navigation and assets.
    const upload = lower === '/uploads' || lower.startsWith('/uploads/')
    if (!upload && !lower.startsWith('/api/')) return next()
    let actor
    try {
      actor = verifyExistingTestLoginFamilyActor({
        loginDatabase, identityDatabase, householdId,
        authenticatedSession: request.familyAccount,
      })
    } catch (error) {
      console.error('TEST family access policy unavailable:', error?.message)
      return response.status(503).json({ error: 'Family access temporarily unavailable.' })
    }
    let allowed = false
    if (actor) {
      if (upload) {
        allowed = ['GET', 'HEAD'].includes(request.method) &&
          canFamilyMemberAct(actor, 'calendar.view')
      } else {
        const required = requiredFamilyMemberActions(request.method, request.originalUrl)
        // Unknown API routes, alternate casing and unreviewed Arney writes
        // are DENIED, including for Owner, until individually audited.
        allowed = Array.isArray(required) && required.every(action =>
          canFamilyMemberAct(actor, action))
      }
    }
    if (!allowed) {
      response.set('Cache-Control', 'no-store')
      return response.status(403).json({
        error: 'This family account cannot use that action.',
      })
    }
    next()
  })
}
