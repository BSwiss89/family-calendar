// PRIVATE draft: central, server-origin-only audit of accepted shared Home
// mutations. Never trust actor, username, role, or household from request body.
// This is not yet a durable recovery journal for an interrupted backend commit.
import { lookupGrantedHouseholdForSessionUser } from './household-memberships.mjs'

export function createPrivateHomeWriteAuditTables(identityDatabase) {
  identityDatabase.exec([
    'CREATE TABLE IF NOT EXISTS private_home_write_audit (',
    'id INTEGER PRIMARY KEY,',
    'household_id INTEGER NOT NULL REFERENCES household_registry(id),',
    'kiosk_session_id INTEGER NOT NULL REFERENCES family_sessions(id),',
    "actor_kind TEXT NOT NULL CHECK(actor_kind IN ('shared-home','verified-person')),",
    'actor_user_id INTEGER REFERENCES family_users(id),',
    'method TEXT NOT NULL, route TEXT NOT NULL,',
    'resource_id INTEGER, created_at INTEGER NOT NULL,',
    "CHECK((actor_kind='shared-home' AND actor_user_id IS NULL) OR",
    "(actor_kind='verified-person' AND actor_user_id IS NOT NULL))",
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS private_home_write_audit_household_idx',
    'ON private_home_write_audit(household_id,created_at);',
  ].join(' '))
}

export function recordPrivateHomeWriteAudit(identityDatabase, {
  householdId, serverVerifiedKioskUserId, serverVerifiedSessionId,
  attribution, method, route, resourceId = null, now = Date.now(),
}) {
  if (!['POST', 'PUT', 'DELETE'].includes(method) ||
      typeof route !== 'string' || !/^\/api\/[a-z0-9/_-]+$/.test(route) ||
      route.includes('//') || !Number.isSafeInteger(now) || now < 1 ||
      (resourceId !== null && (!Number.isSafeInteger(resourceId) || resourceId < 1)) ||
      !Number.isSafeInteger(serverVerifiedSessionId) || serverVerifiedSessionId < 1 ||
      !['shared-home', 'verified-person'].includes(attribution?.kind) ||
      (attribution.kind === 'shared-home' && attribution.userId !== null) ||
      (attribution.kind === 'verified-person' &&
        (!Number.isSafeInteger(attribution.userId) || attribution.userId < 1))) {
    throw new Error('Invalid trusted shared Home audit context.')
  }
  createPrivateHomeWriteAuditTables(identityDatabase)
  const household = lookupGrantedHouseholdForSessionUser(identityDatabase, {
    serverVerifiedUserId: serverVerifiedKioskUserId,
    requestedHouseholdId: householdId,
  })
  if (!household || household.role !== 'owner') {
    throw new Error('Verified active Owner kiosk membership required.')
  }
  const householdDbId = identityDatabase.prepare(
    'SELECT id FROM household_registry WHERE storage_id=? AND disabled=0'
  ).get(householdId)?.id
  if (!householdDbId) throw new Error('Active audit household required.')
  if (attribution.kind === 'verified-person') {
    const account = lookupGrantedHouseholdForSessionUser(identityDatabase, {
      serverVerifiedUserId: attribution.userId,
      requestedHouseholdId: householdId,
    })
    if (!account) throw new Error('Verified shared Home actor no longer belongs to household.')
  }
  const result = identityDatabase.prepare([
    'INSERT INTO private_home_write_audit',
    '(household_id,kiosk_session_id,actor_kind,actor_user_id,method,route,resource_id,created_at)',
    'VALUES (?,?,?,?,?,?,?,?)',
  ].join(' ')).run(householdDbId, serverVerifiedSessionId,
    attribution.kind, attribution.userId, method, route, resourceId, now)
  return Number(result.lastInsertRowid)
}
