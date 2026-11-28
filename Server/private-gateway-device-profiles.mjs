// SOURCE-ONLY private multi-household gateway adapter. The central identity DB
// owns accounts/sessions, but People rows live in each independently provisioned
// household's SQLite DB. Do NOT copy People into central identity or use the
// current browser-selected avatar to authorize an action.
import { DatabaseSync } from 'node:sqlite'
import { listGrantedHouseholdsForSessionUser } from './household-memberships.mjs'
import { getFamilyMemberAuthorization, canFamilyMemberAct } from './family-member-access.mjs'
import { resolveHouseholdStorage } from './household-storage.mjs'

const validUser = value => Number.isSafeInteger(value) && value > 0

/**
 * Returns a current Person name when it exists inside exactly the household
 * this signed-in central account belongs to. Null means unavailable/denied.
 * A stale session, disabled membership, or missing Person fails closed.
 * Callers must never treat this DISPLAY preference as the acting identity.
 *
 * Routed household IDs must come from trusted gateway server config, not
 * request headers, cookies or a household name in a request payload.
 */
export function createPrivateGatewayDevicePersonResolver({
  identityDatabase, serverDirectory, storageRoot, routedHouseholdIds,
  getRoutedHouseholdIds,
}) {
  if (!identityDatabase?.prepare ||
      typeof serverDirectory !== 'string' || !serverDirectory ||
      typeof storageRoot !== 'string' || !storageRoot ||
      (getRoutedHouseholdIds !== undefined && typeof getRoutedHouseholdIds !== 'function') ||
      (routedHouseholdIds !== undefined &&
        (!Array.isArray(routedHouseholdIds) ||
         routedHouseholdIds.some(id => typeof id !== 'string'))) ||
      (typeof getRoutedHouseholdIds !== 'function' &&
        (!Array.isArray(routedHouseholdIds) || routedHouseholdIds.length === 0))) {
    throw new Error('Trusted central identity and approved private household routes required.')
  }
  return ({ serverVerifiedUserId, personId }) => {
    if (!validUser(serverVerifiedUserId) || !validUser(personId)) return null
    // An operator may enroll the first verified tenant without restarting.
    // Re-read only server-owned routes; never trust a selected avatar or URL.
    let configuredRoutes
    try {
      configuredRoutes = typeof getRoutedHouseholdIds === 'function'
        ? getRoutedHouseholdIds() : routedHouseholdIds
    } catch { return null }
    if (!Array.isArray(configuredRoutes) ||
        configuredRoutes.some(id => typeof id !== 'string')) return null
    const routed = new Set(configuredRoutes)
    // A normal central Person account currently belongs to exactly ONE
    // household. Never fall back to another home when the grant is revoked.
    const households = listGrantedHouseholdsForSessionUser(identityDatabase, {
      serverVerifiedUserId,
    })
    if (households.length !== 1) return null
    const householdId = households[0].householdId
    if (!routed.has(householdId)) return null
    const actor = getFamilyMemberAuthorization(identityDatabase, {
      householdId, serverVerifiedUserId,
    })
    if (!canFamilyMemberAct(actor, 'calendar.view')) return null
    // For enrolled personal members, the owner's verified People link is
    // the only personal display identity. Owners retain the existing picker.
    if(actor.role!=='owner'&&actor.personId!==personId)return null
    const storage = resolveHouseholdStorage({
      serverDirectory, storageRoot, householdId,
    })
    const db = new DatabaseSync(storage.databasePath, { readOnly: true })
    try {
      const row = db.prepare('SELECT name FROM people WHERE id = ?').get(personId)
      return typeof row?.name === 'string' ? row.name : null
    } finally {
      db.close()
    }
  }
}
