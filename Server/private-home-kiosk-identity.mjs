// DRAFT / PRIVATE LOOPBACK ONLY: PINs identify actors at an Owner-enrolled
// shared Home device. A PIN is NEVER a household login or Owner password.
// The browser's selected People avatar is display-only, not an identity.
import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { createFamilyMemberAccessTables, getVerifiedFamilyMemberAuthorization } from './family-member-access.mjs'
import { createPrivateHomePinPolicyTables } from './private-home-pin-policy.mjs'

const derive = promisify(scrypt)
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const DUMMY_SALT = Buffer.from('ee1204c98d7e86f021f6dab2a823112d', 'hex')
const PIN_RE = /^[0-9]{4}$/
const HOUSEHOLD_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const MAX_FAILURES = 5
const WINDOW_MS = 15 * 60 * 1000
const PROOF_LIFETIME_MS = 3 * 60 * 1000

function requireId(id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid verified account or session.')
  return id
}

function requireHousehold(id) {
  if (typeof id !== 'string' || !HOUSEHOLD_RE.test(id)) {
    throw new Error('Invalid household.')
  }
  return id
}

function digest(raw) {
  return createHash('sha256').update(raw).digest('hex')
}

export function createPrivateHomeActorTables(db) {
  createFamilyMemberAccessTables(db)
  createPrivateHomePinPolicyTables(db)
  db.exec([
    'CREATE TABLE IF NOT EXISTS private_home_kiosk_sessions (',
    'session_id INTEGER PRIMARY KEY REFERENCES family_sessions(id) ON DELETE CASCADE,',
    'household_id INTEGER NOT NULL REFERENCES household_registry(id) ON DELETE CASCADE,',
    'enrolled_by_user_id INTEGER NOT NULL REFERENCES family_users(id),',
    'created_at INTEGER NOT NULL, disabled_at INTEGER',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS private_home_actor_pins (',
    'household_id INTEGER NOT NULL REFERENCES household_registry(id) ON DELETE CASCADE,',
    'user_id INTEGER NOT NULL REFERENCES family_users(id) ON DELETE CASCADE,',
    'pin_hash TEXT NOT NULL, created_at INTEGER NOT NULL,',
    'updated_by_user_id INTEGER NOT NULL REFERENCES family_users(id),',
    'PRIMARY KEY(household_id,user_id)',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS private_home_pin_attempts (',
    'session_id INTEGER PRIMARY KEY REFERENCES family_sessions(id) ON DELETE CASCADE,',
    'window_started_at INTEGER NOT NULL, failed_attempts INTEGER NOT NULL',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS private_home_actor_proofs (',
    'token_hash TEXT PRIMARY KEY,',
    'session_id INTEGER NOT NULL REFERENCES family_sessions(id) ON DELETE CASCADE,',
    'household_id INTEGER NOT NULL REFERENCES household_registry(id) ON DELETE CASCADE,',
    'actor_user_id INTEGER NOT NULL REFERENCES family_users(id),',
    'expires_at INTEGER NOT NULL',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS home_proofs_session_idx',
    'ON private_home_actor_proofs(session_id,expires_at);',
  ].join(' '))
}

function householdKey(db, householdId) {
  const row = db.prepare('SELECT id FROM household_registry WHERE storage_id = ? AND disabled = 0')
    .get(requireHousehold(householdId))
  if (!row) throw new Error('Active household required.')
  return row.id
}

function requireOwner(db, householdId, userId) {
  const key = householdKey(db, householdId)
  const user = db.prepare([
    'SELECT 1 AS ok FROM household_memberships m',
    'JOIN family_users u ON u.id = m.user_id',
    'WHERE m.household_id = ? AND m.user_id = ?',
    "AND m.role = 'owner' AND m.disabled = 0",
    "AND u.disabled = 0 AND u.account_kind = 'person'",
  ].join(' ')).get(key, requireId(userId))
  if (!user) throw new Error('Active household Owner required.')
  return key
}

function isTrustedKiosk(db, householdId, sessionId, now) {
  if (!Number.isSafeInteger(sessionId) || sessionId < 1) return null
  const row = db.prepare([
    'SELECT h.id AS householdKey, k.enrolled_by_user_id AS ownerUserId',
    'FROM private_home_kiosk_sessions k',
    'JOIN household_registry h ON h.id = k.household_id',
    'JOIN family_sessions s ON s.id = k.session_id',
    'JOIN family_users u ON u.id = s.user_id',
    'JOIN household_memberships m',
    'ON m.user_id = k.enrolled_by_user_id AND m.household_id = h.id',
    'JOIN family_users owner ON owner.id = m.user_id',
    "WHERE h.storage_id = ? AND h.disabled = 0",
    'AND k.session_id = ? AND k.disabled_at IS NULL',
    'AND s.revoked_at IS NULL AND s.expires_at > ?',
    "AND s.selected_profile_kind = 'home'",
    'AND s.user_id = k.enrolled_by_user_id',
    "AND u.disabled = 0 AND u.account_kind = 'person'",
    "AND m.role = 'owner' AND m.disabled = 0 AND owner.disabled = 0",
  ].join(' ')).get(householdId, sessionId, now)
  return row ?? null
}

export function enrollPrivateHomeKiosk(db, {
  householdId, serverVerifiedOwnerUserId, serverVerifiedSessionId, now = Date.now(),
}) {
  createPrivateHomeActorTables(db)
  const key = requireOwner(db, householdId, serverVerifiedOwnerUserId)
  const sessionId = requireId(serverVerifiedSessionId)
  const session = db.prepare([
    'SELECT id FROM family_sessions WHERE id = ? AND user_id = ?',
    "AND selected_profile_kind = 'home' AND revoked_at IS NULL AND expires_at > ?",
  ].join(' ')).get(sessionId, serverVerifiedOwnerUserId, now)
  if (!session) throw new Error('Select Home on this signed-in device before enrollment.')
  db.prepare([
    'INSERT INTO private_home_kiosk_sessions',
    '(session_id,household_id,enrolled_by_user_id,created_at,disabled_at)',
    'VALUES (?,?,?,?,NULL) ON CONFLICT(session_id) DO UPDATE SET',
    'household_id=excluded.household_id,',
    'enrolled_by_user_id=excluded.enrolled_by_user_id,',
    'created_at=excluded.created_at,disabled_at=NULL',
  ].join(' ')).run(sessionId, key, serverVerifiedOwnerUserId, now)
  db.prepare('DELETE FROM private_home_actor_proofs WHERE session_id=?').run(sessionId)
  return { trustedHome: true }
}

export function disablePrivateHomeKiosk(db, {
  householdId, serverVerifiedOwnerUserId, serverVerifiedSessionId, now = Date.now(),
}) {
  createPrivateHomeActorTables(db)
  const key = requireOwner(db, householdId, serverVerifiedOwnerUserId)
  const sessionId = requireId(serverVerifiedSessionId)
  const changes = db.prepare([
    'UPDATE private_home_kiosk_sessions SET disabled_at=?',
    'WHERE household_id=? AND session_id=? AND enrolled_by_user_id=?',
    'AND disabled_at IS NULL',
  ].join(' ')).run(now, key, sessionId, serverVerifiedOwnerUserId).changes
  db.prepare('DELETE FROM private_home_actor_proofs WHERE session_id=?').run(sessionId)
  return { trustedHome: false, changed: changes === 1 }
}

export function isPrivateHomeKioskTrusted(db, {
  householdId, serverVerifiedSessionId, now = Date.now(),
}) {
  createPrivateHomeActorTables(db)
  return Boolean(isTrustedKiosk(db, requireHousehold(householdId), serverVerifiedSessionId, now))
}

// A verified Owner, authenticated by their REAL password at the HTTP layer,
// may provision or reset a PIN for a Person-linked active family account.
// Protecting member content still requires current individual action grants.
export function setPrivateHomeActorPin(db, {
  householdId, serverVerifiedOwnerUserId, targetUserId, pin, householdDatabase,
  now = Date.now(),
}) {
  if (!PIN_RE.test(pin)) throw new Error('The shared Home PIN must be exactly four digits.')
  if (!householdDatabase || typeof householdDatabase.prepare !== 'function') {
    throw new Error('Trusted household People database required.')
  }
  const salt = randomBytes(16)
  const hash = 'scrypt-home-v1:' + salt.toString('hex') + ':' +
    scryptSync(pin, salt, 64, SCRYPT_OPTIONS).toString('hex')
  createPrivateHomeActorTables(db)
  db.exec('BEGIN IMMEDIATE')
  try {
    const key = requireOwner(db, householdId, serverVerifiedOwnerUserId)
    const verified = getVerifiedFamilyMemberAuthorization(db, {
      householdId, serverVerifiedUserId: requireId(targetUserId),
      householdDatabase,
    })
    if (!verified || !Number.isSafeInteger(verified.personId) || verified.personId < 1) {
      throw new Error('A linked active family Person account is required.')
    }
    db.prepare([
      'INSERT INTO private_home_actor_pins',
      '(household_id,user_id,pin_hash,created_at,updated_by_user_id)',
      'VALUES (?,?,?,?,?) ON CONFLICT(household_id,user_id) DO UPDATE SET',
      'pin_hash=excluded.pin_hash,created_at=excluded.created_at,',
      'updated_by_user_id=excluded.updated_by_user_id',
    ].join(' ')).run(key, targetUserId, hash, now, serverVerifiedOwnerUserId)
    // Old proof tokens MUST NOT survive a PIN reset.
    db.prepare([
      'DELETE FROM private_home_actor_proofs',
      'WHERE household_id=? AND actor_user_id=?',
    ].join(' ')).run(key, targetUserId)
    db.exec('COMMIT')
    return { pinConfigured: true }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function currentPinEnabled(db, householdKey) {
  const policy = db.prepare(
    'SELECT pin_enabled FROM private_home_pin_policy WHERE household_id=?'
  ).get(householdKey)
  return !policy || policy.pin_enabled === 1
}

function validPinHash(stored) {
  const parts = typeof stored === 'string' ? stored.split(':') : []
  const valid = parts.length === 3 && parts[0] === 'scrypt-home-v1' &&
    /^[a-f0-9]{32}$/.test(parts[1] ?? '') &&
    /^[a-f0-9]{128}$/.test(parts[2] ?? '')
  return {
    valid,
    salt: valid ? Buffer.from(parts[1], 'hex') : DUMMY_SALT,
    expected: valid ? Buffer.from(parts[2], 'hex') : Buffer.alloc(64),
  }
}

export function createPrivateHomePinVerifier({ now = Date.now, maxConcurrent = 3 } = {}) {
  let checking = 0
  async function verify(db, {
    householdId, serverVerifiedSessionId, targetUserId, pin, householdDatabase,
  }) {
    createPrivateHomeActorTables(db)
    const timestamp = now()
    const kiosk = isTrustedKiosk(db, requireHousehold(householdId), serverVerifiedSessionId, timestamp)
    if (!kiosk) return { status: 'untrusted' }
    if (!currentPinEnabled(db, kiosk.householdKey)) return { status: 'disabled' }
    if (typeof pin !== 'string' || !PIN_RE.test(pin) ||
        !Number.isSafeInteger(targetUserId) || targetUserId < 1 ||
        !householdDatabase || typeof householdDatabase.prepare !== 'function') {
      return { status: 'invalid' }
    }
    const saved = db.prepare([
      'SELECT window_started_at AS started, failed_attempts AS failures',
      'FROM private_home_pin_attempts WHERE session_id=?',
    ].join(' ')).get(serverVerifiedSessionId)
    const inWindow = saved && timestamp - saved.started < WINDOW_MS
    const failures = inWindow ? saved.failures : 0
    if (failures >= MAX_FAILURES) {
      return { status: 'limited', retryAfter: Math.max(1,
        Math.ceil((WINDOW_MS - (timestamp - saved.started)) / 1000)) }
    }
    if (checking >= maxConcurrent) return { status: 'busy' }
    // Count attempts BEFORE asynchronous scrypt. All targeted accounts share
    // one kiosk-wide window, so cycling through People does not reset it.
    db.prepare([
      'INSERT INTO private_home_pin_attempts',
      '(session_id,window_started_at,failed_attempts) VALUES (?,?,?)',
      'ON CONFLICT(session_id) DO UPDATE SET',
      'window_started_at=excluded.window_started_at,',
      'failed_attempts=excluded.failed_attempts',
    ].join(' ')).run(serverVerifiedSessionId, inWindow ? saved.started : timestamp, failures + 1)
    const stored = db.prepare([
      'SELECT pin_hash FROM private_home_actor_pins WHERE household_id=? AND user_id=?',
    ].join(' ')).get(kiosk.householdKey, targetUserId)
    const { valid, salt, expected } = validPinHash(stored?.pin_hash)
    checking++
    try {
      const actual = await derive(pin, salt, 64, SCRYPT_OPTIONS)
      const match = valid && timingSafeEqual(actual, expected)
      const actor = match ? getVerifiedFamilyMemberAuthorization(db, {
        householdId, serverVerifiedUserId: targetUserId, householdDatabase,
      }) : null
      if (!match || !actor || !Number.isSafeInteger(actor.personId) ||
          actor.personId < 1 ||
          !isTrustedKiosk(db, householdId, serverVerifiedSessionId, now()) ||
          !currentPinEnabled(db, kiosk.householdKey)) return { status: 'invalid' }
      db.prepare('DELETE FROM private_home_pin_attempts WHERE session_id=?')
        .run(serverVerifiedSessionId)
      db.prepare('DELETE FROM private_home_actor_proofs WHERE session_id=?')
        .run(serverVerifiedSessionId)
      const proof = randomBytes(32).toString('hex')
      db.prepare([
        'INSERT INTO private_home_actor_proofs',
        '(token_hash,session_id,household_id,actor_user_id,expires_at)',
        'VALUES (?,?,?,?,?)',
      ].join(' ')).run(digest(proof), serverVerifiedSessionId,
        kiosk.householdKey, targetUserId, now() + PROOF_LIFETIME_MS)
      return { status: 'verified', proof, expiresInSeconds: PROOF_LIFETIME_MS / 1000,
        actorUserId: targetUserId }
    } finally {
      checking--
    }
  }

  function resolve(db, {
    householdId, serverVerifiedSessionId, proof, householdDatabase,
  }) {
    if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) return null
    if (!householdDatabase || typeof householdDatabase.prepare !== 'function') return null
    createPrivateHomeActorTables(db)
    const timestamp = now()
    const kiosk = isTrustedKiosk(db, requireHousehold(householdId), serverVerifiedSessionId, timestamp)
    if (!kiosk || !currentPinEnabled(db, kiosk.householdKey)) return null
    const row = db.prepare([
      'SELECT actor_user_id AS userId FROM private_home_actor_proofs',
      'WHERE token_hash=? AND session_id=? AND household_id=? AND expires_at>?',
    ].join(' ')).get(digest(proof), serverVerifiedSessionId, kiosk.householdKey, timestamp)
    if (!row) return null
    const actor = getVerifiedFamilyMemberAuthorization(db, {
      householdId, serverVerifiedUserId: row.userId, householdDatabase,
    })
    if (!actor || !Number.isSafeInteger(actor.personId) || actor.personId < 1) return null
    return { userId: row.userId, ...actor }
  }

  return { verify, resolve }
}
