// Private loopback gateway SYSTEM administrator metadata only.
// Operator identity is a real server-verified central session, never a
// household Owner role, selected People avatar or request-supplied ID.
// No household event, recipe, shopping, People photo or device secrets leak.
import path from 'node:path'
import { inspectPrivateHouseholdActivationReadiness } from './private-household-activation-readiness.mjs'
import {
  listIndependentHouseholdAdministration,
} from './independent-household-invitations.mjs'

function ownerMetadata(db, householdId) {
  // Show only non-sensitive subscription/account counts, never raw records.
  const result = db.prepare([
    'SELECT',
    'COUNT(DISTINCT CASE WHEN m.disabled = 0 AND u.disabled = 0',
    "AND u.account_kind = 'person' THEN u.id END) AS memberCount,",
    "COUNT(DISTINCT CASE WHEN m.role = 'owner' AND m.disabled = 0",
    "AND u.disabled = 0 AND u.account_kind = 'person' THEN u.id END) AS ownerCount,",
    "MAX(CASE WHEN m.role = 'owner' AND m.disabled = 0",
    "AND u.disabled = 0 AND u.account_kind = 'person'",
    'THEN u.display_name END) AS ownerDisplayName,',
    "MAX(CASE WHEN m.role = 'owner' AND m.disabled = 0",
    "AND u.disabled = 0 AND u.account_kind = 'person'",
    'THEN u.username END) AS ownerUsername',
    'FROM household_registry h',
    'LEFT JOIN household_memberships m ON m.household_id = h.id',
    'LEFT JOIN family_users u ON u.id = m.user_id',
    'WHERE h.storage_id = ? AND h.disabled = 0',
  ].join(' ')).get(householdId)
  return {
    memberCount: Number(result?.memberCount || 0),
    ownerCount: Number(result?.ownerCount || 0),
    ownerDisplayName: result?.ownerDisplayName || null,
    ownerUsername: Number(result?.ownerCount)===1 ? result.ownerUsername : null,
  }
}

export function listPrivateOperatorHouseholdOverview(db, {
  serverVerifiedAdministratorUserId, trustedAdministratorUserIds,
  routedHouseholdIds = [], now = Date.now(),
}) {
  if (!db || !Array.isArray(routedHouseholdIds) ||
      routedHouseholdIds.some(x => typeof x !== 'string')) {
    throw new Error('Trusted private household routing inventory required.')
  }
  const data = listIndependentHouseholdAdministration(db, {
    serverVerifiedAdministratorUserId, trustedAdministratorUserIds, now,
  })
  const routed = new Set(routedHouseholdIds)
  return {
    invitations: data.invitations,
    households: data.households.map(home => ({
      householdId: home.householdId,
      displayName: home.displayName,
      state: !home.approved ? 'pending-activation'
        : routed.has(home.householdId) ? 'configured-route'
          : 'approved-unrouted',
      ...ownerMetadata(db, home.householdId),
    })),
    // This is configured routing, not actual HTTP/online status.
    availabilityNote: 'Configured routes are not live health or online-user checks.',
  }
}

function isTrustedAdmin(db, serverVerifiedId, allowlist) {
  return Number.isSafeInteger(serverVerifiedId) && serverVerifiedId > 0 &&
    Array.isArray(allowlist) && allowlist.includes(serverVerifiedId) &&
    !!db.prepare([
      'SELECT id FROM family_users',
      "WHERE id = ? AND disabled = 0 AND account_kind = 'person'",
    ].join(' ')).get(serverVerifiedId)
}

export function installPrivateSystemAdministrator(app, {
  identityDatabase, serverDirectory, trustedAdministratorUserIds,
  routedHouseholdIds = [],
  getRoutedHouseholdIds = () => routedHouseholdIds,
  storageRoot = null,
}) {
  if (!app || !identityDatabase ||
      typeof serverDirectory !== 'string' || !path.isAbsolute(serverDirectory) ||
      !Array.isArray(trustedAdministratorUserIds) ||
      typeof getRoutedHouseholdIds !== 'function' ||
      (storageRoot !== null &&
        (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)))) {
    throw new Error('System dashboard needs private authenticated gateway configuration.')
  }

  // Register after installFamilyAuth's required session middleware.
  // Even assets are withheld from all ordinary Owners, Adults and Children.
  function operatorOnly(request, response, next) {
    response.set('Cache-Control', 'no-store')
    response.set('X-Content-Type-Options', 'nosniff')
    response.set('Referrer-Policy', 'no-referrer')
    response.set('X-Frame-Options', 'DENY')
    response.set('Strict-Transport-Security', 'max-age=31536000')
    if (!isTrustedAdmin(identityDatabase, request.familyAccount?.user_id,
      trustedAdministratorUserIds)) {
      return response.status(403).json({ error: 'System administrator access required.' })
    }
    next()
  }
  const ui = path.join(serverDirectory, 'auth-ui')
  const pagePolicy = (_request, response, next) => {
    response.set('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';" +
      " form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    next()
  }
  app.get('/system-admin', operatorOnly, pagePolicy, (_req, res) =>
    res.sendFile(path.join(ui, 'system-admin.html')))
  app.get('/system-admin/app.js', operatorOnly, pagePolicy, (_req, res) =>
    res.sendFile(path.join(ui, 'system-admin.js')))
  app.get('/system-admin/styles.css', operatorOnly, pagePolicy, (_req, res) =>
    res.sendFile(path.join(ui, 'system-admin.css')))

  app.get('/api/admin/household-overview', operatorOnly, (request, response) => {
    try {
      const overview = listPrivateOperatorHouseholdOverview(identityDatabase, {
        serverVerifiedAdministratorUserId: request.familyAccount.user_id,
        trustedAdministratorUserIds,
        // A newly enrolled family can be routed AFTER gateway startup.
        // Never cache the original boot-time route list for operator views.
        routedHouseholdIds: getRoutedHouseholdIds(),
      })
      response.json(overview)
    } catch (error) {
      console.error('Private system dashboard metadata unavailable:', error?.message)
      response.status(503).json({ error: 'System household overview unavailable.' })
    }
  })

  // Optional read-only preflight: no browser endpoint may approve a backend,
  // start a Node process, modify another tenant or clear a crash hold.
  if (storageRoot !== null) {
    app.get('/api/admin/activation-readiness', operatorOnly, (request, response) => {
      try {
        const routes = getRoutedHouseholdIds()
        const overview = listPrivateOperatorHouseholdOverview(identityDatabase, {
          serverVerifiedAdministratorUserId: request.familyAccount.user_id,
          trustedAdministratorUserIds,
          routedHouseholdIds: routes,
        })
        const active = new Set(routes)
        const checks = overview.households.map(household => ({
          householdId: household.householdId,
          ...inspectPrivateHouseholdActivationReadiness({
            identityDatabase, serverDirectory, storageRoot,
            householdId: household.householdId,
            configuredRoute: active.has(household.householdId),
          }),
        }))
        response.json({
          kind: 'read-only-private-activation-preflight-v1',
          canActivateFromBrowser: false,
          checks,
          note: 'Storage review is not backend attestation, a completed backup, activation permission or online status.',
        })
      } catch (error) {
        console.error('Private activation readiness unavailable:', error?.message)
        response.status(503).json({ error: 'Private activation inspection unavailable.' })
      }
    })
  }
}
