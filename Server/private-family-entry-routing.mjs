// SOURCE-ONLY independent-household gateway entry routing. A verified
// central account sees its own invitation activation state; the system
// operator instead enters the separate metadata-only dashboard. No browser
// query/body/profile determines the destination, and no endpoint activates
// a household, copies data, starts a service, or grants membership.
import { listMyInvitedHouseholdOnboarding } from './private-invited-owner-onboarding.mjs'

const PATHS = new Set(['/', '/my-household', '/system-admin'])

export function resolvePrivateFamilyLanding(identityDatabase, {
  serverVerifiedUserId, trustedAdministratorUserIds = [],
  routedHouseholdIds = [],
}) {
  if (!identityDatabase?.prepare ||
      !Array.isArray(trustedAdministratorUserIds) ||
      !Array.isArray(routedHouseholdIds) ||
      routedHouseholdIds.some(value => typeof value !== 'string')) {
    throw new Error('Trusted private login routing is required.')
  }
  if (!Number.isSafeInteger(serverVerifiedUserId) || serverVerifiedUserId <= 0) {
    return null
  }
  // Session auth already checks expiry/revocation; also recheck the current
  // account before the server announces even a metadata-only destination.
  const account = identityDatabase.prepare([
    'SELECT id FROM family_users',
    "WHERE id = ? AND disabled = 0 AND account_kind = 'person'",
  ].join(' ')).get(serverVerifiedUserId)
  if (!account) return null

  if (trustedAdministratorUserIds.includes(serverVerifiedUserId)) {
    return '/system-admin'
  }
  const invitations = listMyInvitedHouseholdOnboarding(identityDatabase, {
    serverVerifiedUserId, routedHouseholdIds,
  })
  if (invitations.length && invitations.some(home => home.state !== 'configured-route')) {
    return '/my-household'
  }
  return '/'
}

export function installPrivateFamilyEntryRouting(app, {
  identityDatabase, trustedAdministratorUserIds, getRoutedHouseholdIds,
}) {
  if (typeof app?.get !== 'function' || !identityDatabase?.prepare ||
      !Array.isArray(trustedAdministratorUserIds) ||
      typeof getRoutedHouseholdIds !== 'function') {
    throw new Error('Authenticated private gateway is required for entry routing.')
  }
  function resolve(request) {
    return resolvePrivateFamilyLanding(identityDatabase, {
      serverVerifiedUserId: request.familyAccount?.user_id,
      trustedAdministratorUserIds,
      routedHouseholdIds: getRoutedHouseholdIds(),
    })
  }
  const headers = response => {
    response.set('Cache-Control', 'no-store')
    response.set('X-Content-Type-Options', 'nosniff')
    response.set('Referrer-Policy', 'no-referrer')
  }
  app.get('/api/auth/landing', (request, response) => {
    headers(response)
    try {
      const destination = resolve(request)
      if (!destination || !PATHS.has(destination)) {
        return response.status(403).json({ error: 'Account access unavailable.' })
      }
      response.json({ destination })
    } catch (error) {
      console.error('Private family landing unavailable:', error?.message)
      response.status(503).json({ error: 'Account routing temporarily unavailable.' })
    }
  })
  // This route is BEFORE the generic backend proxy. Pending invited Owners
  // cannot accidentally load a partially activated calendar, and operators
  // do not have to impersonate a household to reach their separate UI.
  app.get('/', (request, response, next) => {
    headers(response)
    try {
      const destination = resolve(request)
      if (!destination || !PATHS.has(destination)) {
        return response.status(403).send('Account access unavailable.')
      }
      if (destination !== '/') return response.redirect(303, destination)
      next()
    } catch (error) {
      console.error('Private family entry unavailable:', error?.message)
      response.status(503).send('Account routing temporarily unavailable.')
    }
  })
}
