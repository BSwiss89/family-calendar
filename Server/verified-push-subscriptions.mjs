// NOT PRODUCTION-WIRED. Verified, explicit-opt-in Web Push device registry.
// This central-identity SQLite module has no HTTP endpoints and never sends push.
// Household/person authorization MUST come from a trusted server-side resolver,
// e.g. the separately staged getLinkedHouseholdPerson (PR #70). A selected
// profile is only an additional restriction, NEVER proof of authorization.
import { createHash } from 'node:crypto'

const pushHosts = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
])

function positive(value) {
  return Number.isSafeInteger(value) && value > 0
}

function requireNow(now) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid time.')
}

function requireIdentityDb(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new Error('A trusted central identity SQLite database is required.')
  }
}

function requireResolver(resolveAccountPerson) {
  if (typeof resolveAccountPerson !== 'function') {
    throw new Error('Trusted account-to-person resolver required.')
  }
}

function verifiedPerson(resolveAccountPerson, session, expectedHouseholdId = null) {
  // The resolver must recheck active membership, personal-account kind, and the
  // trusted household's person record. It cannot use a profile from the client.
  const binding = resolveAccountPerson({
    serverVerifiedSessionId: session.id,
    serverVerifiedUserId: session.user_id,
  })
  if (binding && typeof binding.then === 'function') {
    throw new Error('Account-to-person resolver must be synchronous.')
  }
  if (!binding || !positive(binding.personId)
    || binding.userId !== session.user_id
    || typeof binding.householdId !== 'string'
    || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(binding.householdId)) {
    return null
  }
  if (expectedHouseholdId && binding.householdId !== expectedHouseholdId) return null
  if (session.selected_profile_kind !== 'person'
    || session.selected_person_id !== binding.personId) return null
  return { householdId: binding.householdId, personId: binding.personId, userId: binding.userId }
}

function sessionRow(identityDatabase, sessionId, userId, now) {
  if (!positive(sessionId) || !positive(userId)) {
    throw new Error('Verified session/user IDs required.')
  }
  return identityDatabase.prepare([
    'SELECT s.id, s.user_id, s.selected_profile_kind, s.selected_person_id',
    'FROM family_sessions s JOIN family_users u ON u.id = s.user_id',
    'WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL',
    'AND s.expires_at > ? AND u.disabled = 0',
  ].join(' ')).get(sessionId, userId, now)
}

function parseSubscription(subscription) {
  if (!subscription || typeof subscription !== 'object') {
    throw new Error('Browser PushSubscription required.')
  }
  const { endpoint, keys } = subscription
  if (typeof endpoint !== 'string' || endpoint.length > 2048) {
    throw new Error('Invalid push endpoint.')
  }
  let uri
  try { uri = new URL(endpoint) } catch { throw new Error('Invalid push endpoint.') }
  if (uri.protocol !== 'https:' || !pushHosts.has(uri.hostname.toLowerCase())
    || uri.username || uri.password || uri.port || uri.hash
    || uri.href !== endpoint || uri.pathname.length > 1800) {
    throw new Error('Untrusted push endpoint provider.')
  }
  if (!keys || typeof keys !== 'object'
    || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    throw new Error('Missing push encryption keys.')
  }
  // The Web Push browser API provides an uncompressed P-256 public key (65 B)
  // and a 16-byte authentication secret, encoded as base64url.
  const decode = (value, length) => {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return false
    const bytes = Buffer.from(value, 'base64url')
    return bytes.length === length && bytes.toString('base64url') === value
  }
  if (!decode(keys.p256dh, 65) || !decode(keys.auth, 16)) {
    throw new Error('Invalid push encryption keys.')
  }
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth,
    endpointHash: createHash('sha256').update(endpoint).digest('hex') }
}

export function createNotificationDeviceTables(identityDatabase) {
  requireIdentityDb(identityDatabase)
  identityDatabase.exec([
    'CREATE TABLE IF NOT EXISTS person_push_subscriptions (',
    'id INTEGER PRIMARY KEY,',
    'session_id INTEGER NOT NULL REFERENCES family_sessions(id) ON DELETE CASCADE,',
    'user_id INTEGER NOT NULL REFERENCES family_users(id) ON DELETE CASCADE,',
    'household_id TEXT NOT NULL, person_id INTEGER NOT NULL CHECK(person_id > 0),',
    'endpoint_hash TEXT NOT NULL UNIQUE, endpoint TEXT NOT NULL,',
    'p256dh TEXT NOT NULL, auth TEXT NOT NULL,',
    'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS person_push_subscriptions_recipient_idx',
    'ON person_push_subscriptions(household_id,person_id);',
    'CREATE INDEX IF NOT EXISTS person_push_subscriptions_session_idx',
    'ON person_push_subscriptions(session_id);',
  ].join('\n'))
}

// Accept a subscription only from a server-authenticated session with an
// active personal account link and an explicitly selected matching person.
// The caller must require an HTTPS-origin, CSRF-protected user gesture.
// No anonymous/Hub/Home enrollment or user-supplied personId is accepted.
export function registerVerifiedPushSubscription(identityDatabase, {
  serverVerifiedSessionId, serverVerifiedUserId,
  resolveAccountPerson, subscription, explicitOptIn, now = Date.now(),
}) {
  requireIdentityDb(identityDatabase)
  requireResolver(resolveAccountPerson)
  requireNow(now)
  if (explicitOptIn !== true) throw new Error('Explicit push notification opt-in required.')
  const session = sessionRow(identityDatabase, serverVerifiedSessionId, serverVerifiedUserId, now)
  if (!session) throw new Error('Active authenticated device session required.')
  const bound = verifiedPerson(resolveAccountPerson, session)
  if (!bound) throw new Error('Verified personal-account assignment required; Home profiles cannot subscribe.')
  const item = parseSubscription(subscription)
  const old = identityDatabase.prepare([
    'SELECT session_id AS sessionId, user_id AS userId,',
    'household_id AS householdId, person_id AS personId',
    'FROM person_push_subscriptions WHERE endpoint_hash = ?',
  ].join(' ')).get(item.endpointHash)
  if (old && (old.sessionId !== session.id || old.userId !== session.user_id
    || old.householdId !== bound.householdId || old.personId !== bound.personId)) {
    throw new Error('Push endpoint already bound to a different authenticated device.')
  }
  identityDatabase.prepare([
    'INSERT INTO person_push_subscriptions(',
    'session_id,user_id,household_id,person_id,endpoint_hash,endpoint,',
    'p256dh,auth,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    'ON CONFLICT(endpoint_hash) DO UPDATE SET',
    'p256dh=excluded.p256dh, auth=excluded.auth, updated_at=excluded.updated_at',
  ].join(' ')).run(session.id,session.user_id,bound.householdId,bound.personId,
    item.endpointHash,item.endpoint,item.p256dh,item.auth,now,now)
  return { registered: true, personId: bound.personId, householdId: bound.householdId }
}

// A logged-in device may remove only its own endpoint, even when its selected
// display changed to Home. It cannot remove other sessions' subscriptions.
export function unregisterVerifiedPushSubscription(identityDatabase, {
  serverVerifiedSessionId, serverVerifiedUserId, endpoint, now = Date.now(),
}) {
  requireIdentityDb(identityDatabase)
  requireNow(now)
  if (!sessionRow(identityDatabase,serverVerifiedSessionId,serverVerifiedUserId,now)) {
    throw new Error('Active authenticated device session required.')
  }
  if (typeof endpoint !== 'string') throw new Error('Push endpoint required.')
  const hash = createHash('sha256').update(endpoint).digest('hex')
  return identityDatabase.prepare([
    'DELETE FROM person_push_subscriptions',
    'WHERE endpoint_hash = ? AND session_id = ? AND user_id = ?',
  ].join(' ')).run(hash,serverVerifiedSessionId,serverVerifiedUserId).changes === 1
}

// For a trusted INTERNAL dispatcher only. Never expose this return value via
// an HTTP response: endpoints and keys are sensitive. Revalidate the session,
// Home-vs-person selection, and active household account-person link AT SEND TIME.
// The caller also must verify event recipients and the intended household.
export function listAuthorizedPushTargets(identityDatabase, {
  trustedHouseholdId, trustedPersonId, resolveAccountPerson,
  now = Date.now(), limit = 100,
}) {
  requireIdentityDb(identityDatabase)
  requireResolver(resolveAccountPerson)
  requireNow(now)
  if (typeof trustedHouseholdId !== 'string'
    || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(trustedHouseholdId)
    || !positive(trustedPersonId) || !Number.isSafeInteger(limit)
    || limit < 1 || limit > 1000) throw new Error('Trusted recipient scope required.')
  const rows = identityDatabase.prepare([
    'SELECT d.session_id AS sessionId,d.user_id AS userId,',
    'd.household_id AS householdId,d.person_id AS personId,',
    'd.endpoint,d.p256dh,d.auth,',
    's.selected_profile_kind,s.selected_person_id,s.id,s.user_id',
    'FROM person_push_subscriptions d',
    'JOIN family_sessions s ON s.id = d.session_id AND s.user_id = d.user_id',
    'JOIN family_users u ON u.id = s.user_id',
    'WHERE d.household_id = ? AND d.person_id = ?',
    'AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled = 0',
    'ORDER BY d.id LIMIT ?',
  ].join(' ')).all(trustedHouseholdId,trustedPersonId,now,limit)
  return rows.filter(row => {
    const bound = verifiedPerson(resolveAccountPerson,row,trustedHouseholdId)
    return bound && bound.personId === trustedPersonId
  }).map(({endpoint,p256dh,auth,sessionId}) => ({endpoint,p256dh,auth,sessionId}))
}
