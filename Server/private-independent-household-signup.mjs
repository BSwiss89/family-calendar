// Anonymous owner registration for a NEW household. PRIVATE gateway ONLY.
// Does not modify LIVE/TEST, activate a backend, or issue a session.
import path from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import { redeemIndependentHouseholdInvitation } from './independent-household-invitations.mjs'

const TOKEN = /^[a-f0-9]{64}$/
const LIMIT = 5, WINDOW = 15 * 60 * 1000
const attempts = new Map()
const GENERIC = 'New-family registration could not be completed. Check your link and details.'
function sameSecureOrigin(req) {
  try {
    const url = new URL(req.get('origin') || '')
    return url.protocol === 'https:' && url.host.toLowerCase() === (req.get('host') || '').toLowerCase()
      && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
  } catch { return false }
}
function headers(_req, res, next) {
  res.set('Cache-Control', 'no-store')
  res.set('Referrer-Policy', 'no-referrer')
  res.set('X-Frame-Options', 'DENY')
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Strict-Transport-Security', 'max-age=31536000')
  next()
}
function bucket(token, now) {
  const key = TOKEN.test(token) ? createHash('sha256').update(token).digest('hex') : '#invalid'
  for (const [id, entry] of attempts) if (now - entry.start >= WINDOW) attempts.delete(id)
  const selected = attempts.has(key) || attempts.size < 512 ? key : '#overflow'
  let entry = attempts.get(selected)
  if (!entry) { entry = { start: now, count: 0 }; attempts.set(selected, entry) }
  return entry
}
export function installPrivateIndependentHouseholdSignup(app, {
  identityDatabase, serverDirectory, storageRoot, trustedAdministratorUserIds = [],
}) {
  if (typeof serverDirectory !== 'string' || !path.isAbsolute(serverDirectory) ||
      typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    throw new Error('Private independent-family signup requires explicit absolute storage paths.')
  }
  const ui = path.join(serverDirectory, 'auth-ui')
  app.get('/start-family', headers, (_req, res) => {
    res.set('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    res.sendFile(path.join(ui, 'start-family.html'))
  })
  app.get('/auth/start-family.js', headers, (_req, res) =>
    res.sendFile(path.join(ui, 'start-family.js')))
  app.post('/api/households/create-from-invitation', headers,
    express.json({ limit: '4kb', type: 'application/json' }), (req, res) => {
      if (!sameSecureOrigin(req)) return res.status(403).json({ error: 'Secure same-origin registration required.' })
      const body = req.body
      if (!req.is('application/json') || !body || typeof body !== 'object' ||
          Array.isArray(body) || Object.keys(body).length !== 5 ||
          !['token','username','displayName','password','householdName']
            .every(k => Object.prototype.hasOwnProperty.call(body, k)) ||
          typeof body.token !== 'string' || body.token.length !== 64 ||
          typeof body.username !== 'string' || body.username.length > 40 ||
          typeof body.displayName !== 'string' || body.displayName.length > 80 ||
          typeof body.password !== 'string' || body.password.length > 200 ||
          typeof body.householdName !== 'string' || body.householdName.length > 80) {
        return res.status(400).json({ error: GENERIC })
      }
      const now = Date.now()
      const attempt = bucket(body.token, now)
      if (attempt.count >= LIMIT) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((WINDOW - (now - attempt.start)) / 1000))))
        return res.status(429).json({ error: 'Too many attempts. Try later.' })
      }
      attempt.count++
      try {
        redeemIndependentHouseholdInvitation(identityDatabase, {
          ...body, trustedAdministratorUserIds, serverDirectory, storageRoot, now,
        })
        return res.status(201).json({ ok: true, next: '/login', activation: 'pending' })
      } catch {
        return res.status(400).json({ error: GENERIC })
      }
    })
  app.use('/api/households/create-from-invitation', (err, _req, res, next) => {
    if (!err) return next()
    res.set('Cache-Control','no-store')
    res.set('Referrer-Policy','no-referrer')
    res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: GENERIC })
  })
}
