// Private Phase 1 Owner pilot presentation on the EXISTING authenticated
// gateway. This is not a third site, an activation API or an Owner override.
// A ready Owner sees only their own isolated event/list/People preview.
// The system operator keeps the separate metadata-only /system-admin page.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ui = path.join(path.dirname(fileURLToPath(import.meta.url)), 'auth-ui')
const ROUTE = '/phase1'
const SCRIPT = '/auth/phase1-pilot.js'
const STYLE = '/auth/phase1-pilot.css'
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

export function getReadyPrivatePhase1Owner(identityDatabase, {
  serverVerifiedUserId, trustedAdministratorUserIds, routedHouseholdIds,
}) {
  if (!identityDatabase?.prepare || !Array.isArray(trustedAdministratorUserIds) ||
      !Array.isArray(routedHouseholdIds) ||
      !Number.isSafeInteger(serverVerifiedUserId) || serverVerifiedUserId < 1 ||
      trustedAdministratorUserIds.includes(serverVerifiedUserId)) return null
  const rows = identityDatabase.prepare([
    'SELECT h.storage_id AS householdId, h.display_name AS displayName,',
    'm.role AS role',
    'FROM household_memberships m',
    'JOIN household_registry h ON h.id=m.household_id',
    'JOIN family_users u ON u.id=m.user_id',
    'WHERE m.user_id=? AND m.disabled=0 AND h.disabled=0',
    "AND u.disabled=0 AND u.account_kind='person'",
  ].join(' ')).all(serverVerifiedUserId)
  if (rows.length !== 1 || rows[0].role !== 'owner' ||
      !routedHouseholdIds.includes(rows[0].householdId)) return null
  return { householdId: rows[0].householdId, displayName: rows[0].displayName }
}

export function installPrivatePhase1OwnerPilotUi(app, {
  identityDatabase, trustedAdministratorUserIds, getRoutedHouseholdIds,
  redirectToPilot = true,
}) {
  if (typeof app?.get !== 'function' || !identityDatabase?.prepare ||
      !Array.isArray(trustedAdministratorUserIds) ||
      typeof getRoutedHouseholdIds !== 'function') {
    throw new Error('Phase 1 UI requires a verified private gateway.')
  }

  function ready(request) {
    return getReadyPrivatePhase1Owner(identityDatabase, {
      serverVerifiedUserId: request.familyAccount?.user_id,
      trustedAdministratorUserIds,
      routedHouseholdIds: getRoutedHouseholdIds(),
    })
  }

  function secureHeaders(response) {
    response.set('Cache-Control', 'no-store')
    response.set('Content-Security-Policy', CSP)
    response.set('Referrer-Policy', 'no-referrer')
    response.set('X-Content-Type-Options', 'nosniff')
  }

  // First visit after login: the private Owner goes to the narrow pilot UI
  // instead of the full SPA that assumes Phase 2/3/4 APIs are active.
  // Pending invited Owners and the operator retain their existing landing.
  app.get('/', (request, response, next) => {
    if (!redirectToPilot || request.originalUrl !== '/') return next()
    if (!ready(request)) return next()
    secureHeaders(response)
    return response.redirect(303, ROUTE)
  })

  for (const [url, file] of [
    [ROUTE, 'phase1-pilot.html'],
    [SCRIPT, 'phase1-pilot.js'],
    [STYLE, 'phase1-pilot.css'],
  ]) {
    app.get(url, (request, response) => {
      if (request.originalUrl !== url) {
        return response.status(404).send('Not found.')
      }
      if (!ready(request)) {
        return response.status(403).send('Phase 1 pilot household unavailable.')
      }
      secureHeaders(response)
      return response.sendFile(path.join(ui, file))
    })
  }
}
