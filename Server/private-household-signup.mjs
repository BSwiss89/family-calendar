// PRIVATE loopback gateway only. This deliberately adds an unauthenticated
// invitation-redemption route BEFORE installFamilyAuth's session middleware.
// It must never be mounted on a household backend or the existing LIVE/TEST app.
// The only tenant authority is the SHA-256 digest of the one-use bearer token.
import path from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import { redeemHouseholdMemberInvitation } from './household-member-invitations.mjs'

const INVITE_TOKEN = /^[a-f0-9]{64}$/
const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS_PER_TOKEN = 5
const MAX_TRACKED_TOKENS = 512
const failures = new Map()
const GENERIC_ERROR = 'Invitation signup could not be completed. Check your link and details.'

function tokenBucket(token, now) {
  const key = INVITE_TOKEN.test(token)
    ? createHash('sha256').update(token).digest('hex') : '#invalid'
  // Never retain raw bearer secrets in memory or logs.
  let record = failures.get(key)
  if (record && now - record.started < WINDOW_MS) return { key, record }
  failures.delete(key)
  if (failures.size >= MAX_TRACKED_TOKENS) {
    for (const [otherKey, other] of failures) {
      if (now - other.started >= WINDOW_MS) failures.delete(otherKey)
    }
  }
  const bounded = failures.size < MAX_TRACKED_TOKENS ? key : '#overflow'
  record = failures.get(bounded)
  if (!record || now - record.started >= WINDOW_MS) {
    record = { started: now, count: 0 }
    failures.set(bounded, record)
  }
  return { key: bounded, record }
}

function sameSecureOrigin(request) {
  const header = request.get('origin')
  const host = request.get('host')
  if (!header || !host) return false
  try {
    const origin = new URL(header)
    return origin.protocol === 'https:' && origin.host.toLowerCase() === host.toLowerCase()
      && !origin.username && !origin.password && origin.pathname === '/'
      && !origin.search && !origin.hash
  } catch { return false }
}

function secureSignupHeaders(_request, response, next) {
  response.set('Cache-Control', 'no-store')
  response.set('Referrer-Policy', 'no-referrer')
  response.set('X-Content-Type-Options', 'nosniff')
  response.set('X-Frame-Options', 'DENY')
  response.set('Strict-Transport-Security', 'max-age=31536000')
  next()
}

export function installPrivateHouseholdSignup(app, identityDatabase, serverDirectory) {
  if (typeof serverDirectory !== 'string' || !path.isAbsolute(serverDirectory)) {
    throw new Error('Private signup needs an explicitly resolved server directory.')
  }

  const ui = path.join(serverDirectory, 'auth-ui')
  app.get('/join', secureSignupHeaders, (request, response) => {
    response.set('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    response.sendFile(path.join(ui, 'join.html'))
  })
  app.get('/auth/join.js', secureSignupHeaders, (_request, response) => {
    response.sendFile(path.join(ui, 'join.js'))
  })

  app.post('/api/households/join', secureSignupHeaders,
    express.json({ limit: '4kb', type: 'application/json' }),
    (request, response) => {
      if (!sameSecureOrigin(request)) {
        return response.status(403).json({ error: 'Secure same-origin signup required.' })
      }
      if (!request.is('application/json') ||
        !request.body || typeof request.body !== 'object' ||
        Array.isArray(request.body) ||
        Object.keys(request.body).length !== 4 ||
        !['token', 'username', 'displayName', 'password'].every(
          key => Object.prototype.hasOwnProperty.call(request.body, key))) {
        return response.status(400).json({ error: GENERIC_ERROR })
      }
      const { token, username, displayName, password } = request.body
      if (typeof token !== 'string' || typeof username !== 'string' ||
        typeof displayName !== 'string' || typeof password !== 'string' ||
        token.length !== 64 || username.length > 40 ||
        displayName.length > 80 || password.length > 200) {
        return response.status(400).json({ error: GENERIC_ERROR })
      }
      const now = Date.now()
      const { key, record } = tokenBucket(token, now)
      if (record.count >= MAX_ATTEMPTS_PER_TOKEN) {
        response.set('Retry-After', String(Math.max(1,
          Math.ceil((WINDOW_MS - (now - record.started)) / 1000))))
        return response.status(429).json({ error: 'Too many signup attempts. Try later.' })
      }
      // Count BEFORE validating token, password or username. No logged token,
      // plaintext password, household selector, privilege or automatic session.
      record.count++
      try {
        redeemHouseholdMemberInvitation(identityDatabase, {
          token, username, displayName, password, now,
        })
        failures.delete(key)
        response.status(201).json({ ok: true, next: '/login' })
      } catch (error) {
        // Never disclose whether a username, token or target household exists.
        // The store already atomically rolls back any failed redemptions.
        response.status(400).json({ error: GENERIC_ERROR })
      }
    })

  // JSON parser errors must never reflect malformed invitation URLs, raw
  // bearer secrets or passwords through Express's default HTML error page.
  app.use('/api/households/join', (error, _request, response, next) => {
    if (!error) return next()
    response.set('Cache-Control', 'no-store')
    response.set('Referrer-Policy', 'no-referrer')
    const oversized = error.type === 'entity.too.large'
    response.status(oversized ? 413 : 400).json({ error: GENERIC_ERROR })
  })
}
