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

function proxyRequest(request, response, upstreamPort) {
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

  app.use((request, response) => {
    // installFamilyAuth has already validated the session and CSRF Origin.
    // Re-query memberships for EVERY request so changes take effect instantly.
    const grants = listGrantedHouseholdsForSessionUser(identityDatabase, {
      serverVerifiedUserId: request.familyAccount?.user_id,
    })
    if (grants.length === 0) {
      response.status(403).json({ error: 'No household access granted.' })
      return
    }
    const target = grants.length === 1
      ? grants[0]
      : getSelectedHouseholdForVerifiedSession(identityDatabase, {
        serverVerifiedSessionId: request.familyAccount.id,
        serverVerifiedUserId: request.familyAccount.user_id,
      })
    if (!target) {
      // No implicit "first household" and no untrusted selection override.
      response.status(409).json({ error: 'Select an authorized household to continue.' })
      return
    }
    const backendPort = portByHousehold.get(target.householdId)
    if (!backendPort) {
      response.status(503).json({ error: 'Household service unavailable.' })
      return
    }
    proxyRequest(request, response, backendPort)
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
