// PRIVATE-LOOPBACK ONLY: signed Owner enrollment + session-bound PIN proof API.
// The PIN proves a linked Person on a server-enrolled kiosk, never Owner
// administrative authority and never merely a selected Home avatar.
import express from 'express'
import { DatabaseSync } from 'node:sqlite'
import { getFamilyMemberAuthorization } from './family-member-access.mjs'
import { resolveHouseholdStorage } from './household-storage.mjs'
import {
  createPrivateHomeActorTables, enrollPrivateHomeKiosk,
  disablePrivateHomeKiosk, isPrivateHomeKioskTrusted,
  setPrivateHomeActorPin, createPrivateHomePinVerifier,
} from './private-home-kiosk-identity.mjs'

function exactObject(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every(key => Object.hasOwn(value, key))
}

export function installPrivateHomeKioskIdentity(app, {
  identityDatabase, serverDirectory, storageRoot, trustedHousehold,
  ownerPasswordStepUp,
}) {
  if (!identityDatabase || typeof trustedHousehold !== 'function' ||
      !ownerPasswordStepUp || typeof ownerPasswordStepUp.verify !== 'function') {
    throw new Error('Private Home kiosk requires central session, routing and password verification.')
  }
  createPrivateHomeActorTables(identityDatabase)
  const verifier = createPrivateHomePinVerifier()
  const parse = express.json({ limit: '4kb', strict: true })
  const prefix = '/api/households'

  function householdFor(request, response) {
    const household = trustedHousehold(request, response)
    if (!household) return null
    return household
  }

  async function verifiedOwner(request, response, action) {
    const household = householdFor(request, response)
    if (!household) return
    const userId = request.familyAccount?.user_id
    const actor = getFamilyMemberAuthorization(identityDatabase, {
      householdId: household.householdId, serverVerifiedUserId: userId,
    })
    if (actor?.role !== 'owner') {
      return response.status(403).json({ error: 'Household Owner required.' })
    }
    let stepUp
    try {
      stepUp = await ownerPasswordStepUp.verify(identityDatabase, {
        serverVerifiedUserId: userId, password: request.body?.ownerPassword,
      })
    } catch (error) {
      console.error('Private Home Owner verification unavailable:', error?.message)
      return response.status(503).json({ error: 'Owner verification unavailable.' })
    }
    if (stepUp.status === 'limited') {
      response.set('Retry-After', String(stepUp.retryAfter))
      return response.status(429).json({ error: 'Too many password attempts. Try later.' })
    }
    if (stepUp.status === 'busy') {
      response.set('Retry-After', '1')
      return response.status(503).json({ error: 'Owner verification is busy.' })
    }
    if (stepUp.status !== 'verified') {
      return response.status(403).json({ error: 'Owner verification failed.' })
    }
    try {
      return await action(household.householdId, userId, request.familyAccount.id)
    } catch (error) {
      if (/Active household Owner required|Select Home on this signed-in device/.test(
        error?.message ?? ''
      )) return response.status(403).json({ error: 'Owner Home device permission required.' })
      if (/linked active family Person|exactly four digits/.test(error?.message ?? '')) {
        return response.status(400).json({ error: 'Link the Person and choose a valid four-digit PIN.' })
      }
      console.error('Private Home identity setting unavailable:', error?.message)
      return response.status(503).json({ error: 'Home identity setting temporarily unavailable.' })
    }
  }

  app.get(prefix + '/home-device', (request, response) => {
    if (request.originalUrl !== prefix + '/home-device') {
      return response.status(404).json({ error: 'Not found.' })
    }
    const household = householdFor(request, response)
    if (!household) return
    response.set('Cache-Control', 'no-store')
    return response.json({
      trustedHome: isPrivateHomeKioskTrusted(identityDatabase, {
        householdId: household.householdId,
        serverVerifiedSessionId: request.familyAccount.id,
      }),
    })
  })

  app.post(prefix + '/home-device/enroll', parse, (request, response) => {
    if (request.originalUrl !== prefix + '/home-device/enroll' ||
        !exactObject(request.body, ['ownerPassword']) ||
        typeof request.body.ownerPassword !== 'string') {
      return response.status(400).json({ error: 'Owner password required.' })
    }
    return verifiedOwner(request, response, (householdId, ownerUserId, sessionId) =>
      response.json(enrollPrivateHomeKiosk(identityDatabase, {
        householdId, serverVerifiedOwnerUserId: ownerUserId,
        serverVerifiedSessionId: sessionId,
      })))
  })

  app.post(prefix + '/home-device/revoke', parse, (request, response) => {
    if (request.originalUrl !== prefix + '/home-device/revoke' ||
        !exactObject(request.body, ['ownerPassword']) ||
        typeof request.body.ownerPassword !== 'string') {
      return response.status(400).json({ error: 'Owner password required.' })
    }
    return verifiedOwner(request, response, (householdId, ownerUserId, sessionId) => {
      const result = disablePrivateHomeKiosk(identityDatabase, {
        householdId, serverVerifiedOwnerUserId: ownerUserId,
        serverVerifiedSessionId: sessionId,
      })
      if (result.changed) {
        response.clearCookie('__Host-fc_gateway_session', {
          httpOnly: true, secure: true, sameSite: 'strict', path: '/',
        })
      }
      return response.json(result)
    })
  })

  app.post(prefix + '/home-pins/:memberId', parse, (request, response) => {
    const url = prefix + '/home-pins/' + request.params.memberId
    if (request.originalUrl !== url || !/^[1-9][0-9]{0,14}$/.test(request.params.memberId) ||
        !Number.isSafeInteger(Number(request.params.memberId)) ||
        !exactObject(request.body, ['pin', 'ownerPassword']) ||
        typeof request.body.pin !== 'string' ||
        typeof request.body.ownerPassword !== 'string' ||
        !/^[0-9]{4}$/.test(request.body.pin)) {
      return response.status(400).json({ error: 'Four-digit PIN and Owner password required.' })
    }
    return verifiedOwner(request, response, (householdId, ownerUserId) => {
      const storage = resolveHouseholdStorage({ serverDirectory, storageRoot, householdId })
      const calendarDb = new DatabaseSync(storage.databasePath, { readOnly: true })
      try {
        return response.json(setPrivateHomeActorPin(identityDatabase, {
          householdId, serverVerifiedOwnerUserId: ownerUserId,
          targetUserId: Number(request.params.memberId), pin: request.body.pin,
          householdDatabase: calendarDb,
        }))
      } finally {
        calendarDb.close()
      }
    })
  })

  // A challenge can only succeed on the exact, Owner-enrolled Home session.
  // A correctly typed PIN for a different family, stale Person or disabled
  // account never returns a verified actor. The proof is bound to this signed
  // session and expires quickly; it cannot be used to change Owner settings.
  app.post(prefix + '/home-actor/verify', parse, async (request, response) => {
    if (request.originalUrl !== prefix + '/home-actor/verify' ||
        !exactObject(request.body, ['memberId', 'pin']) ||
        !Number.isSafeInteger(request.body.memberId) ||
        request.body.memberId < 1 ||
        typeof request.body.pin !== 'string' ||
        !/^[0-9]{4}$/.test(request.body.pin)) {
      return response.status(400).json({ error: 'Choose a member and a four-digit PIN.' })
    }
    const household = householdFor(request, response)
    if (!household) return
    const storage = resolveHouseholdStorage({
      serverDirectory, storageRoot, householdId: household.householdId,
    })
    const calendarDb = new DatabaseSync(storage.databasePath, { readOnly: true })
    try {
      const result = await verifier.verify(identityDatabase, {
        householdId: household.householdId,
        serverVerifiedSessionId: request.familyAccount.id,
        targetUserId: request.body.memberId, pin: request.body.pin,
        householdDatabase: calendarDb,
      })
      response.set('Cache-Control', 'no-store')
      if (result.status === 'verified') {
        return response.json({
          verified: true, proof: result.proof,
          actorUserId: result.actorUserId,
          expiresInSeconds: result.expiresInSeconds,
        })
      }
      if (result.status === 'limited') {
        response.set('Retry-After', String(result.retryAfter))
        return response.status(429).json({ error: 'Too many PIN attempts. Try later.' })
      }
      if (result.status === 'busy') {
        response.set('Retry-After', '1')
        return response.status(503).json({ error: 'PIN verification temporarily busy.' })
      }
      if (result.status === 'disabled') {
        return response.status(409).json({ error: 'Shared Home PIN is disabled.' })
      }
      return response.status(403).json({ error: 'PIN or Home device verification failed.' })
    } catch (error) {
      console.error('Private Home PIN verification unavailable:', error?.message)
      return response.status(503).json({ error: 'PIN verification unavailable.' })
    } finally {
      calendarDb.close()
    }
  })

  return { resolveHomeActorProof: (context) => verifier.resolve(identityDatabase, context) }
}
