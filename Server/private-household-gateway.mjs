// PRIVATE TEST HARNESS ONLY. Not a deployable public multi-household gateway.
//
// Every calendar request is gated by the central account's valid server-side
// session AND an active household membership. If one account belongs to several
// households, the user must explicitly select an authorized household via a
// CSRF-protected endpoint that saves only a per-device SERVER-side preference.
// A URL, header, cookie field or unvalidated form value can NEVER grant access.
//
// The gateway is deliberately bound to an OS-selected 127.0.0.1 port; it has
// no configurable public listener. Household backends MUST also be loopback
// only. A future production gateway needs upstream process attestation and
// deployment/backup review before exposing anything externally.
import express from 'express'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import {
  createEventShareTables, inviteSelectedEvents,
  listTrustedEventShareRecipients, listEventShareInvitations,
  listOutgoingEventShares, listAcceptedSharedEvents, respondToEventInvitation,
  revokeSelectedEventShare, synchronizeSelectedEventShare,
} from './event-only-shares.mjs'
import { installFamilyAuth } from './family-auth.mjs'
import {
  listGrantedHouseholdsForSessionUser,
  getSelectedHouseholdForVerifiedSession,
  selectHouseholdForVerifiedSession,
} from './household-memberships.mjs'
import { resolveHouseholdStorage } from './household-storage.mjs'

const BLOCKED_PORTS = new Set([3001, 13001, 13002, 13003, 11434])
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])
const REQUEST_REMOVED = new Set([
  ...HOP_HEADERS,
  'cookie', 'authorization', 'host',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host',
  'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip',
])
const RESPONSE_REMOVED = new Set([
  ...HOP_HEADERS, 'set-cookie', 'www-authenticate', 'location',
])
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

function verifiedBackendPort(port) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || BLOCKED_PORTS.has(port)) {
    throw new Error('Private household backend port must be a safe nonproduction port.')
  }
  return port
}

function validateUpstreams({ identityDatabase, serverDirectory, storageRoot, backendPorts }) {
  if (backendPorts === null || typeof backendPorts !== 'object'
      || Array.isArray(backendPorts) || Object.keys(backendPorts).length === 0) {
    throw new Error('At least one explicit household backend must be configured.')
  }
  const ports = new Map()
  for (const [householdId, port] of Object.entries(backendPorts)) {
    verifiedBackendPort(port)
    if ([...ports.values()].includes(port)) {
      throw new Error('Household backend ports must not overlap.')
    }
    // A configured target must be a physically provisioned household with an
    // existing DB and upload folder, never the legacy family SQLite file.
    resolveHouseholdStorage({ serverDirectory, storageRoot, householdId })
    const row = identityDatabase.prepare([
      'SELECT id FROM household_registry WHERE storage_id = ? AND disabled = 0',
    ].join(' ')).get(householdId)
    if (!row) throw new Error('Household backend has no active identity registry record.')
    ports.set(householdId, port)
  }
  return ports
}

function safeRequestHeaders(headers, upstreamPort) {
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    if (REQUEST_REMOVED.has(name.toLowerCase()) || value === undefined) continue
    result[name] = value
  }
  result.host = '127.0.0.1:' + upstreamPort
  return result
}

function safeResponseHeaders(headers) {
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    if (RESPONSE_REMOVED.has(name.toLowerCase()) || value === undefined) continue
    result[name] = value
  }
  // Never let a backend weaken the gateway's authenticated response caching.
  result['cache-control'] = 'no-store'
  result['x-content-type-options'] = 'nosniff'
  return result
}

function proxyRequest(request, response, upstreamPort, onCompletedMutation = null) {
  if (!HTTP_METHODS.has(request.method)) {
    response.status(405).json({ error: 'Unsupported request method.' })
    return
  }

  // Request URL is a *path* on a fixed, trusted loopback backend. A malicious
  // Host/Forwarded/header/cookie cannot control the destination or its tenant.
  const relativeUrl = request.originalUrl
  if (!relativeUrl.startsWith('/') || relativeUrl.startsWith('//')
      || /[\r\n]/.test(relativeUrl)) {
    response.status(400).json({ error: 'Invalid request target.' })
    return
  }

  const upstream = http.request({
    hostname: '127.0.0.1',
    port: upstreamPort,
    path: relativeUrl,
    method: request.method,
    headers: safeRequestHeaders(request.headers, upstreamPort),
    agent: false,
    timeout: 300000,
  }, (upstreamResponse) => {
    if (response.headersSent || response.destroyed) {
      upstreamResponse.destroy()
      return
    }
    // The real backend has committed an ordinary event PUT/DELETE before
    // sending a success response. Synchronize ONLY the exact event mutated,
    // never a client-selected household or any unrelated event ID. This
    // private test hook is not yet a durable queue for crash recovery.
    if (onCompletedMutation && upstreamResponse.statusCode >= 200
        && upstreamResponse.statusCode < 300) {
      upstreamResponse.once('end', () => {
        try {
          onCompletedMutation()
        } catch (error) {
          // The source event may already be committed. We must NOT pretend
          // rolling it back is possible. Keep logging for eventual replay.
          console.error('Private event-share update hook failed:', error)
        }
      })
    }
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      safeResponseHeaders(upstreamResponse.headers),
    )
    upstreamResponse.pipe(response)
  })

  upstream.on('timeout', () => upstream.destroy(new Error('Household backend timeout.')))
  upstream.on('error', () => {
    if (!response.headersSent && !response.destroyed) {
      response.status(502).json({ error: 'Private household service is unavailable.' })
    } else {
      response.destroy()
    }
  })

  request.on('aborted', () => upstream.destroy())
  response.on('close', () => {
    if (!response.writableEnded) upstream.destroy()
  })
  request.pipe(upstream)
}

/**
 * Starts a disposable single-origin authentication/routing fixture on a
 * random localhost port. No supported public-host or fixed-port option.
 *
 * identityDatabase: CENTRAL identity+membership SQLite, not a family DB.
 * backendPorts: server-owned {"family-a": 54321}, never supplied by a browser.
 */
export async function startPrivateHouseholdGateway({
  identityDatabase,
  serverDirectory,
  storageRoot,
  backendPorts,
}) {
  const portByHousehold = validateUpstreams({
    identityDatabase, serverDirectory, storageRoot, backendPorts,
  })
  // Central share records are separate from either family's calendar DB.
  // No migrations to live/preview data occur; this gateway is test-only.
  createEventShareTables(identityDatabase)
  const app = express()
  app.disable('x-powered-by')
  // Login is the only endpoint that needs parsed JSON. All calendar request
  // bodies, including multipart uploads, must stream through unchanged.
  app.use('/api/auth/login', express.json({ limit: '32kb' }))
  installFamilyAuth(app, identityDatabase, serverDirectory, 'required')

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok' })
  })

  // The auth module owns the /api/auth namespace. Never fall through to a
  // household backend that may have authentication disabled in test mode.
  app.use('/api/auth', (_request, response) => {
    response.status(404).json({ error: 'Not found.' })
  })

  // Only the authenticated gateway owns household discovery and selection.
  // No household name, role or member information is available without a
  // valid session. Never proxy these URLs to an unauthenticated backend.
  app.get('/api/households', (request, response) => {
    const verified = request.familyAccount
    const households = listGrantedHouseholdsForSessionUser(identityDatabase, {
      serverVerifiedUserId: verified.user_id,
    })
    const selected = households.length === 1
      ? households[0]
      : getSelectedHouseholdForVerifiedSession(identityDatabase, {
        serverVerifiedSessionId: verified.id,
        serverVerifiedUserId: verified.user_id,
      })
    response.json({
      households,
      selectedHouseholdId: selected?.householdId ?? null,
    })
  })

  app.post('/api/households/select', express.json({ limit: '8kb' }), (request, response) => {
    const selected = selectHouseholdForVerifiedSession(identityDatabase, {
      serverVerifiedSessionId: request.familyAccount.id,
      serverVerifiedUserId: request.familyAccount.user_id,
      requestedHouseholdId: request.body?.householdId,
    })
    if (!selected) {
      response.status(403).json({ error: 'That household is not available to your account.' })
      return
    }
    response.json({
      selectedHouseholdId: selected.householdId,
      displayName: selected.displayName,
    })
  })

  app.use('/api/households', (_request, response) => {
    response.status(404).json({ error: 'Not found.' })
  })

  // Resolve all tenant context from a verified central session. Never use a
  // household slug supplied in the browser's request to choose the backend.
  function trustedHousehold(request, response) {
    const grants = listGrantedHouseholdsForSessionUser(identityDatabase, {
      serverVerifiedUserId: request.familyAccount?.user_id,
    })
    if (grants.length === 0) {
      response.status(403).json({ error: 'No household access granted.' })
      return null
    }
    const target = grants.length === 1
      ? grants[0]
      : getSelectedHouseholdForVerifiedSession(identityDatabase, {
        serverVerifiedSessionId: request.familyAccount.id,
        serverVerifiedUserId: request.familyAccount.user_id,
      })
    if (!target) {
      response.status(409).json({ error: 'Select an authorized household to continue.' })
      return null
    }
    if (!portByHousehold.has(target.householdId)) {
      response.status(503).json({ error: 'Household service unavailable.' })
      return null
    }
    return target
  }

  // Event sharing is an overlay of explicitly granted EVENT snapshots.
  // These routes are registered only in the local private test gateway,
  // before the unauthenticated per-family backend's catch-all proxy.
  // Unrecognized /api/shared-events paths are ALWAYS blocked.
  app.get('/api/shared-events/recipients', (request, response) => {
    const household = trustedHousehold(request, response)
    if (!household) return
    response.set('Cache-Control', 'no-store')
    response.json({
      recipients: listTrustedEventShareRecipients(identityDatabase, {
        serverVerifiedUserId: request.familyAccount.user_id,
        sourceHouseholdId: household.householdId,
      }),
    })
  })
  app.get('/api/shared-events/invitations', (request, response) => {
    const household = trustedHousehold(request, response)
    if (!household) return
    response.set('Cache-Control', 'no-store')
    response.json({
      invitations: listEventShareInvitations(identityDatabase, {
        serverVerifiedUserId: request.familyAccount.user_id,
        recipientHouseholdId: household.householdId,
      }),
    })
  })
  app.get('/api/shared-events/sent', (request, response) => {
    const household = trustedHousehold(request, response)
    if (!household) return
    response.set('Cache-Control', 'no-store')
    response.json({
      shares: listOutgoingEventShares(identityDatabase, {
        serverVerifiedUserId: request.familyAccount.user_id,
        sourceHouseholdId: household.householdId,
      }),
    })
  })
  app.get('/api/shared-events/accepted', (request, response) => {
    const household = trustedHousehold(request, response)
    if (!household) return
    response.set('Cache-Control', 'no-store')
    response.json({
      events: listAcceptedSharedEvents(identityDatabase, {
        serverVerifiedUserId: request.familyAccount.user_id,
        recipientHouseholdId: household.householdId,
      }),
    })
  })

  const parseShareJson = express.json({ limit: '12kb', strict: true })
  app.post('/api/shared-events/invite', parseShareJson, (request, response) => {
    const household = trustedHousehold(request, response)
    if (!household) return
    const { eventIds, recipientHouseholdIds } = request.body ?? {}
    let sourceDb = null
    try {
      // Resolve a server-trusted on-disk path, not an attacker-provided path.
      const storage = resolveHouseholdStorage({
        serverDirectory, storageRoot, householdId: household.householdId,
      })
      sourceDb = new DatabaseSync(storage.databasePath, { readOnly: true })
      const created = inviteSelectedEvents(identityDatabase, {
        serverVerifiedUserId: request.familyAccount.user_id,
        sourceHouseholdId: household.householdId,
        sourceDatabase: sourceDb,
        eventIds, recipientHouseholdIds,
      })
      response.status(201).json({ invitations: created })
    } catch (error) {
      // Never leak source DB details, event IDs, internal paths or existence.
      const conflict = error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
        || String(error?.message ?? '').includes('UNIQUE constraint')
      response.status(conflict ? 409 : 400).json({
        error: conflict ? 'One or more event invitations already exist.' :
          'Could not share the selected events with the specified recipients.',
      })
    } finally {
      sourceDb?.close()
    }
  })
  app.post('/api/shared-events/:shareId/respond', parseShareJson, (request, response) => {
    const household = trustedHousehold(request, response)
    if (!household) return
    const shareId = Number(request.params.shareId)
    if (!Number.isSafeInteger(shareId) || shareId <= 0) {
      return response.status(404).json({ error: 'Event invitation unavailable.' })
    }
    try {
      const result = respondToEventInvitation(identityDatabase, {
        serverVerifiedUserId: request.familyAccount.user_id,
        recipientHouseholdId: household.householdId,
        shareId,
        decision: request.body?.decision,
      })
      response.json(result)
    } catch {
      response.status(404).json({ error: 'Event invitation unavailable.' })
    }
  })
  app.post('/api/shared-events/:shareId/revoke', (request, response) => {
    const household = trustedHousehold(request, response)
    if (!household) return
    const shareId = Number(request.params.shareId)
    if (!Number.isSafeInteger(shareId) || shareId <= 0) {
      return response.status(404).json({ error: 'Event share unavailable.' })
    }
    try {
      response.json(revokeSelectedEventShare(identityDatabase, {
        serverVerifiedUserId: request.familyAccount.user_id,
        sourceHouseholdId: household.householdId,
        shareId,
      }))
    } catch {
      response.status(404).json({ error: 'Event share unavailable.' })
    }
  })
  app.use('/api/shared-events', (_request, response) => {
    response.status(404).json({ error: 'Not found.' })
  })

  app.use((request, response) => {
    // installFamilyAuth has already validated the central session and CSRF.
    const household = trustedHousehold(request, response)
    if (!household) return
    const eventMutation = /^\/api\/events\/([1-9][0-9]*)(?:\?[^#]*)?$/.exec(
      request.originalUrl,
    )
    const shouldSync = eventMutation && ['PUT', 'DELETE'].includes(request.method)
    const sourceEventId = shouldSync ? Number(eventMutation[1]) : null
    const safeEventId = Number.isSafeInteger(sourceEventId) && sourceEventId > 0
    const sync = shouldSync && safeEventId
      ? () => {
        const path = resolveHouseholdStorage({
          serverDirectory,
          storageRoot,
          householdId: household.householdId,
        }).databasePath
        const sourceDatabase = new DatabaseSync(path, { readOnly: true })
        try {
          synchronizeSelectedEventShare(identityDatabase, {
            serverVerifiedUserId: request.familyAccount.user_id,
            sourceHouseholdId: household.householdId,
            sourceEventId,
            sourceDatabase,
          })
        } finally {
          sourceDatabase.close()
        }
      }
      : null
    proxyRequest(request, response, portByHousehold.get(household.householdId), sync)
  })

  const server = http.createServer(app)
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    server.close()
    throw error
  }

  const address = server.address()
  if (typeof address !== 'object' || address?.address !== '127.0.0.1'
      || BLOCKED_PORTS.has(address.port)) {
    server.close()
    throw new Error('Gateway failed private listener validation.')
  }
  return {
    base: 'http://127.0.0.1:' + address.port,
    port: address.port,
    close: () => new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())),
  }
}
