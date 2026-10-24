import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import path from 'node:path'

const derive = promisify(scrypt)
// Match the secure production two-site cookie names. The localhost-only
// draft gateway uses a separate explicit cookie identity so its future
// HTTPS origin cannot overwrite either LIVE or TEST browser sessions.
export function familySessionCookieNameForPort(port) {
  return String(port) === '13002' ? '__Host-fc_test_session'
    : String(port) === '3001' ? '__Host-fc_live_session'
      : '__Host-fc_session'
}
const COOKIE_NAME = familySessionCookieNameForPort(process.env.FAMILY_CALENDAR_PORT)
const SESSION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILURES = 10
const LOGIN_MAX_IDENTITIES = 512
const LOGIN_MAX_ACTIVE_CHECKS = 4
const loginFailures = new Map()
let activeLoginChecks = 0
const DUMMY_SALT = Buffer.from('2397717ca3b79d96e021601c529470bd', 'hex')
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedUsername(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{3,40}$/.test(value)
    ? value.toLowerCase()
    : null
}

export function hashFamilyPassword(password) {
  if (typeof password !== 'string' || password.length < 14 || password.length > 200) {
    throw new Error('Family account passwords must be 14–200 characters long.')
  }
  const salt = randomBytes(16)
  const digest = scryptSync(password, salt, 64, SCRYPT_OPTIONS)
  return 'scrypt-v1:' + salt.toString('hex') + ':' + digest.toString('hex')
}

export async function verifyFamilyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 200) return false
  const parts = typeof stored === 'string' ? stored.split(':') : []
  const valid = parts.length === 3 && parts[0] === 'scrypt-v1'
    && /^[a-f0-9]{32}$/.test(parts[1] ?? '')
    && /^[a-f0-9]{128}$/.test(parts[2] ?? '')
  const salt = valid ? Buffer.from(parts[1], 'hex') : DUMMY_SALT
  const expected = valid ? Buffer.from(parts[2], 'hex') : Buffer.alloc(64)
  const actual = await derive(password, salt, 64, SCRYPT_OPTIONS)
  return valid && timingSafeEqual(actual, expected)
}

export function createFamilyAuthTables(database) {
  database.exec([
    'CREATE TABLE IF NOT EXISTS family_users (',
    'id INTEGER PRIMARY KEY,',
    'username TEXT NOT NULL UNIQUE,',
    'display_name TEXT NOT NULL,',
    'password_hash TEXT NOT NULL,',
    "account_kind TEXT NOT NULL DEFAULT 'person' CHECK(account_kind IN ('person','hub')),",
    'disabled INTEGER NOT NULL DEFAULT 0',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS family_sessions (',
    'id INTEGER PRIMARY KEY,',
    'user_id INTEGER NOT NULL REFERENCES family_users(id) ON DELETE CASCADE,',
    'token_hash TEXT NOT NULL UNIQUE,',
    'device_label TEXT NOT NULL,',
    'created_at INTEGER NOT NULL,',
    'last_seen_at INTEGER NOT NULL,',
    'expires_at INTEGER NOT NULL,',
    'revoked_at INTEGER',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS family_sessions_user_idx ON family_sessions(user_id);',
    'CREATE INDEX IF NOT EXISTS family_sessions_expiry_idx ON family_sessions(expires_at);',
  ].join('\n'))
  // Old central identity databases created before hub-account roles should
  // retain all logins and sessions, never be dropped/rebuilt for this change.
  const columns = database.prepare('PRAGMA table_info(family_users)').all()
  if (!columns.some(column => column.name === 'account_kind')) {
    database.exec("ALTER TABLE family_users ADD COLUMN account_kind TEXT NOT NULL DEFAULT 'person' CHECK(account_kind IN ('person','hub'))")
  }
}

export function setFamilyAccount(database, username, displayName, password, { accountKind = 'person' } = {}) {
  if (!['person', 'hub'].includes(accountKind)) {
    throw new Error('A family account must represent a person or a household hub.')
  }
  const name = normalizedUsername(username)
  if (!name) throw new Error('Username must be 3–40 letters, digits, dots, dashes, or underscores.')
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 80) {
    throw new Error('A display name of 1–80 characters is required.')
  }
  createFamilyAuthTables(database)
  const passwordHash = hashFamilyPassword(password)
  database.exec('BEGIN')
  try {
    const existing = database.prepare('SELECT id FROM family_users WHERE username = ?').get(name)
    if (existing) {
      database.prepare('UPDATE family_users SET display_name = ?, password_hash = ?, account_kind = ?, disabled = 0 WHERE id = ?')
        .run(displayName.trim(), passwordHash, accountKind, existing.id)
      // A password reset revokes all trusted devices.
      database.prepare('DELETE FROM family_sessions WHERE user_id = ?').run(existing.id)
    } else {
      database.prepare('INSERT INTO family_users(username, display_name, password_hash, account_kind) VALUES (?, ?, ?, ?)')
        .run(name, displayName.trim(), passwordHash, accountKind)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function cookieValue(request, cookieName = COOKIE_NAME) {
  const raw = request.headers.cookie
  if (typeof raw !== 'string') return null
  for (const part of raw.split(';')) {
    const split = part.indexOf('=')
    if (split === -1 || part.slice(0, split).trim() !== cookieName) continue
    const token = part.slice(split + 1).trim()
    return /^[a-f0-9]{64}$/.test(token) ? token : null
  }
  return null
}

function secureCookie(response, token, cookieName = COOKIE_NAME) {
  response.cookie(cookieName, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  })
}

function clearCookie(response, cookieName = COOKIE_NAME) {
  response.clearCookie(cookieName, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
  })
}

function isSameSecureOrigin(request) {
  const header = request.get('origin')
  const host = request.get('host')
  if (!header || !host) return false
  try {
    const origin = new URL(header)
    return origin.protocol === 'https:'
      && origin.host.toLowerCase() === host.toLowerCase()
      && origin.username === '' && origin.password === ''
  } catch {
    return false
  }
}

function securityHeaders(response) {
  response.set('Cache-Control', 'no-store')
  response.set('X-Content-Type-Options', 'nosniff')
  response.set('Strict-Transport-Security', 'max-age=31536000')
  response.set('Referrer-Policy', 'no-referrer')
  response.set('X-Frame-Options', 'DENY')
}

function getSession(database, request, response, touch = true, cookieName = COOKIE_NAME) {
  const token = cookieValue(request, cookieName)
  if (!token) return null
  const now = Date.now()
  const session = database.prepare([
    'SELECT s.id, s.user_id, s.device_label, s.last_seen_at, u.username, u.display_name, u.account_kind',
    'FROM family_sessions s JOIN family_users u ON u.id = s.user_id',
    'WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled = 0',
  ].join(' ')).get(sha256(token), now)
  if (!session) return null
  if (touch && now - session.last_seen_at > TOUCH_INTERVAL_MS) {
    database.prepare('UPDATE family_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(now, now + SESSION_MAX_AGE_MS, session.id)
    secureCookie(response, token, cookieName)
  }
  return session
}

function failuresFor(identity, now) {
  const existing = loginFailures.get(identity)
  if (existing && now - existing.started <= LOGIN_WINDOW_MS) {
    return { key: identity, record: existing }
  }

  loginFailures.delete(identity)

  // Keep arbitrary usernames from growing the in-memory map forever.
  if (loginFailures.size >= LOGIN_MAX_IDENTITIES) {
    for (const [key, record] of loginFailures) {
      if (now - record.started > LOGIN_WINDOW_MS) {
        loginFailures.delete(key)
      }
    }
  }

  // Under a large flood, new identities share a bounded overflow bucket.
  // Established identities retain their independent limits.
  const key = loginFailures.size >= LOGIN_MAX_IDENTITIES
    ? 'overflow'
    : identity

  let record = loginFailures.get(key)
  if (!record || now - record.started > LOGIN_WINDOW_MS) {
    record = { started: now, count: 0 }
    loginFailures.set(key, record)
  }

  return { key, record }
}

function safeDeviceLabel(value) {
  if (typeof value !== 'string') return 'Family device'
  const label = value.trim().replace(/[\x00-\x1f\x7f]/g, '')
  return label.slice(0, 60) || 'Family device'
}

export function installFamilyAuth(app, database, directory, mode = process.env.FAMILY_CALENDAR_AUTH_MODE ?? 'disabled',
  { cookieName = COOKIE_NAME } = {}) {
  // Deliberately restrict the override to the private authenticated gateway.
  // Other sites always use their own port-specific secure cookie name.
  if (cookieName !== COOKIE_NAME && cookieName !== '__Host-fc_gateway_session') {
    throw new Error('Unapproved session cookie name.')
  }
  if (!['required', 'disabled'].includes(mode)) {
    throw new Error('FAMILY_CALENDAR_AUTH_MODE must be required or disabled.')
  }
  if (mode === 'disabled') {
    app.get('/api/auth/status', (_request, response) => response.json({ enabled: false }))
    return
  }
  createFamilyAuthTables(database)
  const privateSession = (request, response) => getSession(database, request, response, true, cookieName)
  const uiFolder = path.join(directory, 'auth-ui')

  app.use((_request, response, next) => {
    securityHeaders(response)
    next()
  })

  const sendUi = (file) => (_request, response) => {
    response.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    response.sendFile(path.join(uiFolder, file))
  }
  app.get('/login', (request, response) => {
    if (privateSession(request, response)) return response.redirect(303, '/')
    sendUi('login.html')(request, response)
  })
  app.get('/auth/login.js', sendUi('login.js'))
  app.get('/auth/account.js', sendUi('account.js'))
  app.get('/auth/styles.css', sendUi('styles.css'))

  app.get('/api/auth/status', (request, response) => {
    const session = privateSession(request, response)
    response.json({
      enabled: true,
      authenticated: Boolean(session),
      ...(session ? {
        displayName: session.display_name, username: session.username,
        accountKind: session.account_kind,
      } : {}),
    })
  })

  app.post('/api/auth/login', async (request, response) => {
    if (!isSameSecureOrigin(request)) {
      return response.status(403).json({ error: 'Secure same-origin login required.' })
    }

    const username = normalizedUsername(request.body?.username)
    const password = request.body?.password
    // Never trust user-supplied forwarded-IP headers for login throttling.
    // Use the same identity bucket regardless of whether the account exists.
    const identity = 'login:' + sha256(username ?? '#invalid')
    const now = Date.now()
    const { key, record: failures } = failuresFor(identity, now)

    if (failures.count >= LOGIN_MAX_FAILURES) {
      response.set('Retry-After', String(Math.max(
        1, Math.ceil((LOGIN_WINDOW_MS - (now - failures.started)) / 1000)
      )))
      return response.status(429).json({ error: 'Too many attempts. Try again later.' })
    }

    if (activeLoginChecks >= LOGIN_MAX_ACTIVE_CHECKS) {
      response.set('Retry-After', '1')
      return response.status(503).json({ error: 'Login is temporarily busy.' })
    }

    // Count before awaiting password hashing to prevent parallel bypasses.
    failures.count++

    if (!username || typeof password !== 'string' ||
        password.length < 1 || password.length > 200) {
      return response.status(401).json({ error: 'Incorrect username or password.' })
    }

    activeLoginChecks++
    try {
      const user = database.prepare(
        'SELECT id, username, display_name, password_hash FROM family_users WHERE username = ? AND disabled = 0'
      ).get(username)

      const valid = await verifyFamilyPassword(password, user?.password_hash)
      if (!user || !valid) {
        return response.status(401).json({ error: 'Incorrect username or password.' })
      }

      loginFailures.delete(key)

      const token = randomBytes(32).toString('hex')
      const expires = Date.now() + SESSION_MAX_AGE_MS

      database.prepare([
        'INSERT INTO family_sessions(user_id, token_hash, device_label, created_at, last_seen_at, expires_at)',
        'VALUES (?, ?, ?, ?, ?, ?)',
      ].join(' ')).run(
        user.id, sha256(token), safeDeviceLabel(request.body?.deviceLabel),
        now, now, expires
      )

      secureCookie(response, token, cookieName)
      response.json({ ok: true, displayName: user.display_name })
    } catch (error) {
      console.error(
        'Family authentication unavailable:',
        error instanceof Error ? error.message : 'unknown error'
      )
      response.status(503).json({ error: 'Login is temporarily unavailable.' })
    } finally {
      activeLoginChecks--
    }
  })

  app.use((request, response, next) => {
    // Health returns only generic process status. No other route is exempt.
    if (request.path === '/api/health' && (request.method === 'GET' || request.method === 'HEAD')) return next()
    const session = privateSession(request, response)
    if (!session) {
      if (request.path.startsWith('/api/')) return response.status(401).json({ error: 'Sign in required.' })
      if (request.method === 'GET' || request.method === 'HEAD') return response.redirect(303, '/login')
      return response.status(401).json({ error: 'Sign in required.' })
    }
    if (!['GET', 'HEAD'].includes(request.method) && !isSameSecureOrigin(request)) {
      return response.status(403).json({ error: 'Secure same-origin request required.' })
    }
    request.familyAccount = session
    next()
  })

  app.get('/account', sendUi('account.html'))

  app.post('/api/auth/logout', (request, response) => {
    database.prepare('UPDATE family_sessions SET revoked_at = ? WHERE id = ?')
      .run(Date.now(), request.familyAccount.id)
    clearCookie(response, cookieName)
    response.json({ ok: true })
  })

  app.get('/api/auth/devices', (request, response) => {
    const sessions = database.prepare([
      'SELECT id, device_label, created_at, last_seen_at, expires_at FROM family_sessions',
      'WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?',
      'ORDER BY last_seen_at DESC',
    ].join(' ')).all(request.familyAccount.user_id, Date.now())
    response.json({
      devices: sessions.map((session) => ({
        id: session.id,
        label: session.device_label,
        createdAt: session.created_at,
        lastSeenAt: session.last_seen_at,
        current: session.id === request.familyAccount.id,
      })),
    })
  })

  app.post('/api/auth/devices/:id/revoke', (request, response) => {
    const id = Number(request.params.id)
    if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: 'Invalid device.' })
    const result = database.prepare([
      'UPDATE family_sessions SET revoked_at = ?',
      'WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    ].join(' ')).run(Date.now(), id, request.familyAccount.user_id)
    if (result.changes !== 1) return response.status(404).json({ error: 'Device not found.' })
    if (id === request.familyAccount.id) clearCookie(response, cookieName)
    response.json({ ok: true })
  })
}
