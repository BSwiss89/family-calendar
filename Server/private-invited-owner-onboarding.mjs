// Private household gateway only: signed-in invited Owners can see the
// activation state of THEIR newly registered household without asking the
// system operator for a password or silently joining another family.
//
// "Configured" reflects central approval + a trusted gateway route. It is
// never a claim that a remote browser can reach a backend right now.
import path from 'node:path'

const FAMILY_ID = /^family-[0-9a-f]{24}$/

export function listMyInvitedHouseholdOnboarding(identityDatabase, {
  serverVerifiedUserId, routedHouseholdIds = [],
}) {
  if (!identityDatabase || typeof identityDatabase.prepare !== 'function' ||
      !Array.isArray(routedHouseholdIds) ||
      routedHouseholdIds.some(id => typeof id !== 'string')) {
    throw new Error('Trusted identity and gateway routing required.')
  }
  if (!Number.isSafeInteger(serverVerifiedUserId) || serverVerifiedUserId <= 0) return []
  const results = identityDatabase.prepare([
    'SELECT h.storage_id AS householdId, h.display_name AS displayName,',
    'CASE WHEN a.household_id IS NULL THEN 0 ELSE 1 END AS approved',
    'FROM independent_household_invitations i',
    'JOIN household_registry h ON h.id = i.household_id',
    'JOIN household_memberships m ON m.household_id = h.id',
    'JOIN family_users u ON u.id = m.user_id',
    'LEFT JOIN private_activated_households a ON a.household_id = h.id',
    'WHERE i.redeemed_user_id = ? AND m.user_id = ?',
    "AND m.role = 'owner' AND m.disabled = 0",
    "AND u.disabled = 0 AND u.account_kind = 'person' AND h.disabled = 0",
    'AND i.redeemed_at IS NOT NULL AND i.revoked_at IS NULL',
    'ORDER BY i.redeemed_at DESC, i.id DESC LIMIT 10',
  ].join(' ')).all(serverVerifiedUserId, serverVerifiedUserId)
  const routes = new Set(routedHouseholdIds)
  return results.filter(row => FAMILY_ID.test(row.householdId)).map(row => ({
    householdId: row.householdId,
    displayName: row.displayName,
    state: !row.approved ? 'pending-activation'
      : routes.has(row.householdId) ? 'configured-route' : 'approved-awaiting-route',
  }))
}

/**
 * Register AFTER existing required family login middleware, BEFORE any
 * family-backend catch-all. This page and its JS require the genuine session
 * that created the new Owner account; household avatars and browser IDs
 * cannot grant access. No invitation token or password is returned.
 */
export function installPrivateInvitedOwnerOnboarding(app, {
  identityDatabase, serverDirectory, getRoutedHouseholdIds,
}) {
  if (!app || typeof app.get !== 'function' || !identityDatabase ||
      typeof serverDirectory !== 'string' || !path.isAbsolute(serverDirectory) ||
      typeof getRoutedHouseholdIds !== 'function') {
    throw new Error('Private Owner onboarding requires trusted gateway context.')
  }
  const ui = path.join(serverDirectory, 'auth-ui')
  function headers(response) {
    response.set('Cache-Control', 'no-store')
    response.set('Referrer-Policy', 'no-referrer')
    response.set('X-Content-Type-Options', 'nosniff')
    response.set('X-Frame-Options', 'DENY')
    response.set('Strict-Transport-Security', 'max-age=31536000')
  }
  function stateFor(request) {
    return listMyInvitedHouseholdOnboarding(identityDatabase, {
      serverVerifiedUserId: request.familyAccount?.user_id,
      routedHouseholdIds: getRoutedHouseholdIds(),
    })
  }
  function ownerOnly(request, response, next) {
    headers(response)
    try {
      const households = stateFor(request)
      if (!households.length) {
        return response.status(403).json({ error: 'Invited household Owner required.' })
      }
      response.locals.invitedOwnerHouseholds = households
      next()
    } catch (error) {
      console.error('Invited Owner onboarding unavailable:', error?.message)
      response.status(503).json({ error: 'Household onboarding temporarily unavailable.' })
    }
  }
  const pagePolicy = (_request, response, next) => {
    response.set('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';" +
      " form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    next()
  }
  app.get('/my-household', ownerOnly, pagePolicy, (_req, response) =>
    response.sendFile(path.join(ui, 'my-household.html')))
  app.get('/auth/my-household.js', ownerOnly, pagePolicy, (_req, response) =>
    response.sendFile(path.join(ui, 'my-household.js')))
  app.get('/api/households/my-onboarding', (request, response) => {
    headers(response)
    try {
      response.json({ households: stateFor(request) })
    } catch (error) {
      console.error('Signed-in Owner status unavailable:', error?.message)
      response.status(503).json({ error: 'Household onboarding temporarily unavailable.' })
    }
  })
}
