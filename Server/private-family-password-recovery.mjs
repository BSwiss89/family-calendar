// PRIVATE LOOPBACK GATEWAY ONLY. No automatic recovery email delivery.
// Anonymous recovery requests do not disclose whether any user exists.
// Operator must authenticate, be allowlisted, prove password again and
// attest to independently verifying identity before a bearer link is issued.
import path from 'node:path'
import { createHash } from 'node:crypto'
import express from 'express'
import {
  requestFamilyPasswordRecovery, listPendingFamilyPasswordRecovery,
  issueFamilyPasswordResetLink, denyFamilyPasswordRecovery,
  listFamilyPasswordRecoveryHistory, reissueFamilyPasswordResetLink, revokeFamilyPasswordResetLink,
  completeFamilyPasswordReset, readOptionalRecoveryContact,
  saveUnverifiedRecoveryContact,
} from './family-password-recovery.mjs'
import { createOwnerPasswordStepUp } from './family-owner-step-up.mjs'

const USERNAME = /^[a-zA-Z0-9._-]{3,40}$/
const GENERIC = 'If that account is eligible, a recovery request has been sent for administrator review.'
const TOKEN_ERROR = 'The reset link is invalid, has expired, or was already used.'
const REQUEST_WINDOW_MS = 15 * 60 * 1000
const MAX_REQUESTS = 5

function sameSecureOrigin(req) {
  try {
    const origin = new URL(req.get('origin') || '')
    return origin.protocol === 'https:' &&
      origin.host.toLowerCase() === (req.get('host') || '').toLowerCase() &&
      origin.pathname === '/' && !origin.search && !origin.hash &&
      !origin.username && !origin.password
  } catch { return false }
}
function safeHeaders(_req, res, next) {
  res.set('Cache-Control', 'no-store')
  res.set('Referrer-Policy', 'no-referrer')
  res.set('X-Frame-Options', 'DENY')
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Strict-Transport-Security', 'max-age=31536000')
  next()
}
function securePage(_req, res, next) {
  res.set('Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
  next()
}
function parseBody() {
  return express.json({ type: 'application/json', limit: '4kb', strict: true })
}
function exactObject(object, fields) {
  return object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).length === fields.length &&
    fields.every(key => Object.hasOwn(object, key))
}
function idFromParam(input) {
  return typeof input === 'string' && /^[1-9][0-9]{0,14}$/.test(input) &&
    Number.isSafeInteger(Number(input)) ? Number(input) : null
}
function safeParserError(error, _req, res, next) {
  if (!error) return next()
  res.set('Cache-Control', 'no-store')
  res.status(error.type === 'entity.too.large' ? 413 : 400)
    .json({ error: 'Invalid request.' })
}

export function installPrivateRecoveryPublic(app, {
  identityDatabase, serverDirectory, now = Date.now,
}) {
  if (!identityDatabase || typeof serverDirectory !== 'string' ||
      !path.isAbsolute(serverDirectory) || typeof now !== 'function') {
    throw new Error('Private recovery requires trusted central identity and UI path.')
  }
  const ui = path.join(serverDirectory, 'auth-ui')
  const attempts = new Map()
  app.get('/forgot-password', safeHeaders, securePage, (_req, res) =>
    res.sendFile(path.join(ui, 'forgot-password.html')))
  app.get('/reset-password', safeHeaders, securePage, (_req, res) =>
    res.sendFile(path.join(ui, 'reset-password.html')))
  app.get('/auth/forgot-password.js', safeHeaders, securePage, (_req, res) =>
    res.sendFile(path.join(ui, 'forgot-password.js')))
  app.get('/auth/reset-password.js', safeHeaders, securePage, (_req, res) =>
    res.sendFile(path.join(ui, 'reset-password.js')))
  app.get('/api/auth/recovery/availability', safeHeaders, (_req, res) =>
    res.json({ supported: true, mode: 'administrator-assisted' }))
  app.post('/api/auth/recovery/request', safeHeaders, parseBody(), (req, res) => {
    if (!sameSecureOrigin(req)) return res.status(403).json({ error: 'Secure recovery request required.' })
    if (!exactObject(req.body, ['username']) ||
        typeof req.body.username !== 'string' || req.body.username.length > 40) {
      return res.status(400).json({ error: 'Enter a valid account username.' })
    }
    const normalized = USERNAME.test(req.body.username)
      ? req.body.username.toLowerCase() : '#invalid'
    const key = createHash('sha256').update(normalized).digest('hex')
    const timestamp = now()
    for (const [id, entry] of attempts) if (timestamp - entry.start >= REQUEST_WINDOW_MS) attempts.delete(id)
    const chosen = attempts.has(key) || attempts.size < 512 ? key : '#overflow'
    const entry = attempts.get(chosen) ?? { start: timestamp, count: 0 }
    attempts.set(chosen, entry)
    if (entry.count >= MAX_REQUESTS) {
      res.set('Retry-After', String(Math.max(1,
        Math.ceil((REQUEST_WINDOW_MS - (timestamp - entry.start)) / 1000))))
      return res.status(429).json({ error: 'Too many requests. Try later.' })
    }
    entry.count++
    try {
      requestFamilyPasswordRecovery(identityDatabase, {
        username: normalized, now: timestamp,
      })
      return res.status(202).json({ message: GENERIC })
    } catch (error) {
      console.error('Private recovery request unavailable:', error?.message)
      return res.status(503).json({ error: 'Account recovery temporarily unavailable.' })
    }
  })
  app.post('/api/auth/recovery/complete', safeHeaders, parseBody(), (req, res) => {
    if (!sameSecureOrigin(req)) return res.status(403).json({ error: 'Secure password reset required.' })
    if (!exactObject(req.body, ['token', 'newPassword']) ||
        typeof req.body.token !== 'string' || req.body.token.length !== 64 ||
        typeof req.body.newPassword !== 'string' ||
        req.body.newPassword.length < 8 || req.body.newPassword.length > 200) {
      return res.status(400).json({ error: TOKEN_ERROR })
    }
    try {
      completeFamilyPasswordReset(identityDatabase, {
        token: req.body.token, newPassword: req.body.newPassword, now: now(),
      })
      return res.json({ ok: true, next: '/login' })
    } catch (error) {
      if (String(error?.message).includes('Invalid or expired')) {
        return res.status(400).json({ error: TOKEN_ERROR })
      }
      console.error('Private password reset unavailable:', error?.message)
      return res.status(503).json({ error: 'Password reset temporarily unavailable.' })
    }
  })
  app.use('/api/auth/recovery/request', safeParserError)
  app.use('/api/auth/recovery/complete', safeParserError)
}

export function installPrivateRecoveryOperator(app, {
  identityDatabase, trustedAdministratorUserIds = [],
  passwordStepUp = createOwnerPasswordStepUp(), now = Date.now,
}) {
  if (!identityDatabase || !Array.isArray(trustedAdministratorUserIds) ||
      typeof now !== 'function' || !passwordStepUp?.verify) {
    throw new Error('Private recovery operator requires trusted configuration.')
  }
  function pending(req, res) {
    try {
      return listPendingFamilyPasswordRecovery(identityDatabase, {
        serverVerifiedAdministratorUserId: req.familyAccount?.user_id,
        trustedAdministratorUserIds, now: now(),
      })
    } catch (error) {
      res.status(error?.message === 'Trusted system administrator required.' ?
        403 : 503).json({ error: 'System recovery administration unavailable.' })
      return null
    }
  }

  app.get('/api/admin/recovery/requests', safeHeaders, (req, res) => {
    const requests = pending(req, res)
    if (requests === null) return
    try {
      res.json({ requests, history: listFamilyPasswordRecoveryHistory(identityDatabase, {
        serverVerifiedAdministratorUserId:req.familyAccount?.user_id, trustedAdministratorUserIds, now:now(),
      }) })
    } catch { res.status(503).json({error:'System recovery administration unavailable.'}) }
  })

  function verifiedAdminAction(req, res, handler, needsIdentityCheck = true) {
    if (!sameSecureOrigin(req)) {
      return res.status(403).json({ error: 'Secure same-origin recovery action required.' })
    }
    const requests = pending(req, res)
    if (requests === null) return
    const expected = needsIdentityCheck ? ['verifiedOutOfBand'] : ['confirmAction']
    if (!exactObject(req.body, expected) ||
        (needsIdentityCheck ? req.body.verifiedOutOfBand !== true : req.body.confirmAction !== true)) {
      return res.status(400).json({ error: 'Confirm the required identity check or recovery action.' })
    }
    return handler()
  }

  app.post('/api/admin/recovery/requests/:id/issue',
    safeHeaders, parseBody(), async (req, res) => {
      const requestId = idFromParam(req.params.id)
      if (!requestId) return res.status(400).json({ error: 'Invalid recovery request.' })
      return verifiedAdminAction(req, res, () => {
        try {
          const issued = issueFamilyPasswordResetLink(identityDatabase, {
            serverVerifiedAdministratorUserId: req.familyAccount.user_id,
            trustedAdministratorUserIds,
            recoveryRequestId: requestId, verifiedOutOfBand: true, now: now(),
          })
          // Secret is returned once to this operator in a fragment: the
          // webserver will never receive it in GET paths, query or logs.
          return res.json({
            expiresAt: issued.expiresAt,
            resetUrl: 'https://' + req.get('host') + '/reset-password#token=' + issued.token,
          })
        } catch (error) {
          return res.status(String(error?.message).includes('no longer pending') ? 409 : 503)
            .json({ error: 'Recovery link could not be issued.' })
        }
      })
    })
  app.post('/api/admin/recovery/requests/:id/deny',
    safeHeaders, parseBody(), async (req, res) => {
      const requestId = idFromParam(req.params.id)
      if (!requestId) return res.status(400).json({ error: 'Invalid recovery request.' })
      return verifiedAdminAction(req, res, () => {
        try {
          const denied = denyFamilyPasswordRecovery(identityDatabase, {
            serverVerifiedAdministratorUserId: req.familyAccount.user_id,
            trustedAdministratorUserIds, recoveryRequestId: requestId, now: now(),
          })
          return res.status(denied ? 200 : 409).json(denied ?
            { ok: true } : { error: 'Recovery request no longer pending.' })
        } catch {
          return res.status(503).json({ error: 'Recovery denial unavailable.' })
        }
      }, false)
    })
  app.post('/api/admin/recovery/requests/:id/reissue', safeHeaders, parseBody(), async (req,res)=>{
    const requestId=idFromParam(req.params.id)
    if(!requestId)return res.status(400).json({error:'Invalid recovery request.'})
    return verifiedAdminAction(req,res,()=>{
      try {
        const issued=reissueFamilyPasswordResetLink(identityDatabase,{
          serverVerifiedAdministratorUserId:req.familyAccount.user_id,trustedAdministratorUserIds,
          recoveryRequestId:requestId,verifiedOutOfBand:true,now:now(),
        })
        return res.json({expiresAt:issued.expiresAt,resetUrl:'https://'+req.get('host')+'/reset-password#token='+issued.token})
      } catch(error) {
        return res.status(String(error?.message).includes('no longer eligible')?409:503).json({error:'Recovery link could not be reissued. Refresh the dashboard.'})
      }
    })
  })
  app.post('/api/admin/recovery/requests/:id/revoke',safeHeaders,parseBody(),async(req,res)=>{
    const requestId=idFromParam(req.params.id)
    if(!requestId)return res.status(400).json({error:'Invalid recovery request.'})
    return verifiedAdminAction(req,res,()=>{
      try{
        const revoked=revokeFamilyPasswordResetLink(identityDatabase,{
          serverVerifiedAdministratorUserId:req.familyAccount.user_id,trustedAdministratorUserIds,recoveryRequestId:requestId,now:now(),
        })
        return res.status(revoked?200:409).json(revoked?{ok:true}:{error:'Recovery link no longer issued.'})
      }catch{return res.status(503).json({error:'Recovery revocation unavailable.'})}
    },false)
  })
  app.use('/api/admin/recovery/requests', safeParserError)

  // Optional email address is NOT a recovery factor until an independent
  // email verification feature exists. Each change is password-reverified.
  app.get('/api/auth/recovery-contact', safeHeaders, (req, res) => {
    const result = readOptionalRecoveryContact(identityDatabase, {
      serverVerifiedUserId: req.familyAccount?.user_id,
    })
    if (!result) return res.status(403).json({ error: 'Person account required.' })
    return res.json(result)
  })
  app.post('/api/auth/recovery-contact', safeHeaders, parseBody(), async (req, res) => {
    if (!exactObject(req.body, ['email', 'currentPassword']) ||
        typeof req.body.currentPassword !== 'string') {
      return res.status(400).json({ error: 'Email and current password required.' })
    }
    let checked
    try {
      checked = await passwordStepUp.verify(identityDatabase, {
        serverVerifiedUserId: req.familyAccount?.user_id,
        password: req.body.currentPassword,
      })
    } catch {
      return res.status(503).json({ error: 'Account verification unavailable.' })
    }
    if (checked.status === 'limited') {
      res.set('Retry-After', String(checked.retryAfter))
      return res.status(429).json({ error: 'Too many attempts. Try later.' })
    }
    if (checked.status !== 'verified') {
      return res.status(403).json({ error: 'Current password verification required.' })
    }
    try {
      return res.json(saveUnverifiedRecoveryContact(identityDatabase, {
        serverVerifiedUserId: req.familyAccount.user_id,
        email: req.body.email, now: now(),
      }))
    } catch (error) {
      return res.status(String(error?.message).includes('Invalid recovery email') ? 400 : 503)
        .json({ error: 'Could not save recovery contact.' })
    }
  })
  app.use('/api/auth/recovery-contact', safeParserError)
}
