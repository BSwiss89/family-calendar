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
import { acquirePrivateGatewayWriterLock } from './private-gateway-writer-lock.mjs'
import { randomBytes } from 'node:crypto'
import {
  createEventShareTables, inviteSelectedEvents,
  listTrustedEventShareRecipients, listEventShareInvitations,
  listOutgoingEventShares, listAcceptedSharedEvents, respondToEventInvitation,
  revokeSelectedEventShare, removeReceivedEventShare, synchronizeTrustedSelectedEventShare,
} from './event-only-shares.mjs'
import { installFamilyAuth } from './family-auth.mjs'
import {
  createEventCreatorAuditTables, recordAuthenticatedEventCreator,
  listAuthenticatedEventCreators, cleanupDeletedEventCreator,
} from './event-creator-audit.mjs'
import {
  listGrantedHouseholdsForSessionUser,
  getSelectedHouseholdForVerifiedSession,
  selectHouseholdForVerifiedSession,
} from './household-memberships.mjs'
import {
  createHouseholdInvitationTables, issueHouseholdMemberInvitation,
  listHouseholdMemberInvitations, revokeHouseholdMemberInvitation,
} from './household-member-invitations.mjs'
import { installPrivateHouseholdSignup } from './private-household-signup.mjs'
import { listHouseholdMembers } from './household-member-directory.mjs'
import { revokeHouseholdMemberAccess } from './household-member-access-revocation.mjs'
import { resolveHouseholdStorage } from './household-storage.mjs'
import { installPrivateEventSourceOutbox, drainPrivateSourceOutbox } from './private-event-source-outbox.mjs'
import { PRIVATE_UPSTREAM_HEADER, requirePrivateUpstreamToken } from './private-upstream-access.mjs'
import { inspectPrivateGatewayMutation } from './private-gateway-mutation-policy.mjs'
import { listPrivateArneyCalendar } from './private-arney-calendar-lookup.mjs'
import { interpretPrivateArneyEventAction } from './private-arney-event-language.mjs'
import {
  ArneyActionError, previewPrivateArneyAction, confirmPrivateArneyAction,
} from './private-arney-confirmed-actions.mjs'
import {
  createPrivateLocalAiBudgetTables, privateLocalAiBudgetStatus,
  reservePrivateLocalAiRequest,
} from './private-local-ai-budget.mjs'
import {
  createPrivatePaidApiBudgetTables, privatePaidApiBudgetStatus,
} from './private-paid-api-budget.mjs'
import {
  createEventShareSyncJournal, markEventShareSyncPending, markEventShareSyncInFlight,
  acknowledgeEventShareSyncInFlight,
  countPendingEventShareSync, replayEventShareSyncPending,
} from './event-share-sync-journal.mjs'

const BLOCKED_PORTS = new Set([3001, 13001, 13002, 13003, 11434])
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])
const REQUEST_REMOVED = new Set([
  ...HOP_HEADERS,
  'cookie', 'authorization', 'host', PRIVATE_UPSTREAM_HEADER,
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

// Fail closed before installing any login gateway routes or serving tenant data.
// This detects wiring a trusted token+port to the wrong household, but does NOT
// attest OS process identity or make the test gateway production-ready.
async function verifyPrivateBackendBindings(portByHousehold, tokensByHousehold) {
  for (const [householdId, port] of portByHousehold) {
    try {
      const response = await fetch('http://127.0.0.1:' + port +
        '/api/internal/household-binding', {
        method: 'GET', redirect: 'manual', cache: 'no-store',
        headers: {
          Accept: 'application/json',
          [PRIVATE_UPSTREAM_HEADER]: tokensByHousehold.get(householdId),
        },
        signal: AbortSignal.timeout(2500),
      })
      if (response.status !== 200 ||
          !(response.headers.get('content-type') ?? '').toLowerCase()
            .includes('application/json')) {
        throw new Error('Private backend did not return a trusted identity response.')
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Missing backend identity response.')
      const chunks = []
      let total = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > 1024) throw new Error('Oversized backend identity response.')
          chunks.push(Buffer.from(value))
        }
      } finally {
        reader.releaseLock()
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (data === null || typeof data !== 'object' ||
          data.mode !== 'household' || data.householdId !== householdId) {
        throw new Error('Household backend identity mismatch.')
      }
    } catch {
      throw new Error('Private gateway refused unverified household backend: ' + householdId)
    }
  }
}

function safeRequestHeaders(headers, upstreamPort, upstreamToken) {
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    if (REQUEST_REMOVED.has(name.toLowerCase()) || value === undefined) continue
    result[name] = value
  }
  result.host = '127.0.0.1:' + upstreamPort
  // NEVER forward a browser-supplied version of this capability. Only the
  // trusted per-household config may set it, after membership resolution.
  result[PRIVATE_UPSTREAM_HEADER] = requirePrivateUpstreamToken(upstreamToken)
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

function proxyRequest(
  request, response, upstreamPort,
  onCompletedMutation = null, onBackendResult = null,
  upstreamToken,
) {
  let backendResultReported = false
  let upstreamResponseRef = null
  function backendResult(confirmed) {
    if (backendResultReported) return
    backendResultReported = true
    try { onBackendResult?.(confirmed) } catch (error) {
      // Never claim acknowledgement for a failed central DB update.
      console.error('Unable to complete event mutation recovery record:', error)
    }
  }
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
    headers: safeRequestHeaders(request.headers, upstreamPort, upstreamToken),
    agent: false,
    timeout: 300000,
  }, (upstreamResponse) => {
    upstreamResponseRef = upstreamResponse
    // The backend's fully completed reply, not the browser's connection,
    // establishes that its synchronous event handler finished.
    upstreamResponse.once('error', () => backendResult(false))
    upstreamResponse.once('close', () => {
      if (!upstreamResponse.complete) backendResult(false)
    })
    if (response.headersSent || response.destroyed) {
      // Browser already disconnected. Continue consuming the response so
      // the backend can complete, rather than prematurely erasing its intent.
      if (onBackendResult) {
        upstreamResponse.once('end', () => backendResult(true))
        upstreamResponse.resume()
      } else {
        upstreamResponse.destroy()
      }
      return
    }
    // The real backend has committed an ordinary event PUT/DELETE before
    // sending a success response. Synchronize ONLY the exact event mutated,
    // never a client-selected household or any unrelated event ID. This
    // private test hook is not yet a durable queue for crash recovery.
    if (onCompletedMutation && upstreamResponse.statusCode >= 200
        && upstreamResponse.statusCode < 300) {
      const captured = []
      let received = 0
      let tooLarge = false
      // Only small 201 POST /api/events responses need their server-created
      // ID to write unspoofable actor attribution. Always stream the original
      // bytes to the client unchanged; never accept a client-provided creator.
      if (request.method === 'POST' && upstreamResponse.statusCode === 201) {
        upstreamResponse.on('data', chunk => {
          received += chunk.length
          if (received > 16384) {
            tooLarge = true
            captured.length = 0
          } else if (!tooLarge) {
            captured.push(chunk)
          }
        })
      }
      upstreamResponse.once('end', () => {
        try {
          onCompletedMutation(!tooLarge && captured.length
            ? Buffer.concat(captured).toString('utf8') : null)
        } catch (error) {
          // A backend commit cannot be rolled back by a central DB failure.
          // Durable reconciliation is required before public deployment.
          console.error('Private event mutation identity/sync hook failed:', error)
        }
      })
    }
    // Register AFTER any optional per-response audit callback so audit
    // failures do not prevent durable share acknowledgement.
    upstreamResponse.once('end', () => backendResult(true))
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      safeResponseHeaders(upstreamResponse.headers),
    )
    upstreamResponse.pipe(response)
  })

  upstream.on('timeout', () => upstream.destroy(new Error('Household backend timeout.')))
  upstream.on('error', () => {
    // Upstream errors can occur after the backend committed but before its
    // reply arrived. Never ACK an ambiguous mutation.
    backendResult(false)
    if (!response.headersSent && !response.destroyed) {
      response.status(502).json({ error: 'Private household service is unavailable.' })
    } else {
      response.destroy()
    }
  })

  request.on('aborted', () => {
    // Incomplete request body: backend outcome is unknowable.
    backendResult(false)
    upstream.destroy()
  })
  response.on('close', () => {
    if (response.writableEnded) return
    if (onBackendResult && upstream.writableFinished) {
      // The full mutation request has reached the backend transport.
      // A client closing its tab must not cancel our attempt to obtain the
      // backend's authoritative completion response.
      upstreamResponseRef?.unpipe(response)
      upstreamResponseRef?.resume()
    } else {
      backendResult(false)
      upstream.destroy()
    }
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
  backendTokens,
}) {
  const portByHousehold = validateUpstreams({
    identityDatabase, serverDirectory, storageRoot, backendPorts,
  })
  if (!backendTokens || typeof backendTokens !== 'object' ||
      Array.isArray(backendTokens) ||
      Object.keys(backendTokens).length !== portByHousehold.size) {
    throw new Error('Private gateway requires one trusted secret per household.')
  }
  const tokensByHousehold = new Map()
  const usedTokens = new Set()
  for (const householdId of portByHousehold.keys()) {
    const token = requirePrivateUpstreamToken(backendTokens[householdId])
    if (usedTokens.has(token)) throw new Error('Private household secrets must be distinct.')
    usedTokens.add(token)
    tokensByHousehold.set(householdId, token)
  }
  // Verify the binding to the actual loopback service BEFORE mutating
  // central identity/share tables or opening a client listener.
  await verifyPrivateBackendBindings(portByHousehold, tokensByHousehold)
  // Only one private test gateway may mutate central/share SQLite and read
  // household source outboxes at a time. Acquire BEFORE creating any tables.
  const writerLock = acquirePrivateGatewayWriterLock(storageRoot)
  try {
  // Invitation state is central-only, never stored in household calendars.
  createHouseholdInvitationTables(identityDatabase)
  // Central share records are separate from either family's calendar DB.
  // No migrations to live/preview data occur; this gateway is test-only.
  createEventShareTables(identityDatabase)
  createEventShareSyncJournal(identityDatabase)
  createPrivateLocalAiBudgetTables(identityDatabase)
  createPrivatePaidApiBudgetTables(identityDatabase)

  // Private-gateway-only reconciliation. Storage is resolved from trusted
  // server configuration; no user-provided path or membership is trusted.
  // A pending change is applied and acknowledged in one CENTRAL transaction.
  function reconcilePendingShares() {
    let total = 0
    for (const householdId of portByHousehold.keys()) {
      if (!countPendingEventShareSync(identityDatabase, {
        sourceHouseholdId: householdId,
      })) continue
      const storage = resolveHouseholdStorage({
        serverDirectory, storageRoot, householdId,
      })
      const trustedSource = new DatabaseSync(storage.databasePath, { readOnly: true })
      try {
        // Each bounded batch commits its changes and acknowledgements
        // atomically. A backlog larger than the batch size must not make
        // a restarted gateway permanently unavailable.
        let remaining
        do {
          const result = replayEventShareSyncPending(identityDatabase, {
            sourceHouseholdId: householdId,
            apply: ({ sourceEventId }) => synchronizeTrustedSelectedEventShare(
              identityDatabase, {
                sourceHouseholdId: householdId,
                sourceEventId,
                sourceDatabase: trustedSource,
              }),
          })
          if (result.remaining > 0 && result.replayed === 0) {
            throw new Error('Event share recovery made no progress.')
          }
          total += result.replayed
          remaining = result.remaining
        } while (remaining > 0)
      } finally {
        trustedSource.close()
      }
    }
    // Never silently serve snapshots when unrecognized/inactive household
    // work remains. The private harness must fail closed for review.
    if (countPendingEventShareSync(identityDatabase) !== 0) {
      throw new Error('Unresolved household sharing reconciliation work.')
    }

    // The source database also records ALL event changes in the same SQLite
    // transaction as the backend mutation (including AI and batch routes).
    // Deliver each change into the central grants DB BEFORE acknowledging its
    // source-local revision. A crash after central COMMIT but before source
    // ACK simply retries an idempotent synchronization next time.
    for (const householdId of portByHousehold.keys()) {
      const storage = resolveHouseholdStorage({
        serverDirectory, storageRoot, householdId,
      })
      const source = new DatabaseSync(storage.databasePath)
      try {
        const hasEvents = source.prepare([
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'",
        ].join(' ')).get()
        const registry = identityDatabase.prepare(
          'SELECT id FROM household_registry WHERE storage_id = ?'
        ).get(householdId)
        const activeGrants = identityDatabase.prepare([
          'SELECT COUNT(*) AS n FROM event_share_grants',
          "WHERE source_household_id = ? AND status IN ('pending','accepted')",
        ].join(' ')).get(registry.id).n
        if (!hasEvents) {
          if (activeGrants) throw new Error('Source events missing for active shares.')
          continue
        }
        const hasOutbox = source.prepare([
          "SELECT 1 FROM sqlite_master WHERE type='table'",
          "AND name='event_source_share_outbox'",
        ].join(' ')).get()
        if (!hasOutbox && activeGrants) {
          throw new Error('Existing active shares have no source change outbox.')
        }
        if (!hasOutbox) installPrivateEventSourceOutbox(source)
        let remaining
        let passes = 0
        do {
          if (++passes > 200) {
            throw new Error('Source event change backlog not yet caught up.')
          }
          const result = drainPrivateSourceOutbox(source, {
            limit: 100,
            apply: ({ sourceEventId }) => {
              // The single event's central snapshot transaction completes
              // before clearing its source outbox revision.
              identityDatabase.exec('BEGIN IMMEDIATE')
              try {
                synchronizeTrustedSelectedEventShare(identityDatabase, {
                  sourceHouseholdId: householdId,
                  sourceEventId,
                  sourceDatabase: source,
                })
                identityDatabase.exec('COMMIT')
              } catch (error) {
                identityDatabase.exec('ROLLBACK')
                throw error
              }
            },
          })
          if (result.remaining && result.acknowledged === 0) {
            throw new Error('Source event reconciliation made no progress.')
          }
          total += result.acknowledged
          remaining = result.remaining
        } while (remaining > 0)
      } finally {
        source.close()
      }
    }
    return total
  }

  // Block reads while event mutations may still be committing in another
  // backend process. Multiple edits to the same source remain coalesced in
  // the revisioned central journal, and replay waits for the final response.
  const arneyActionTokenKey = randomBytes(32)
  const activeEventMutations = new Map()
  const activeLocalAi = new Set()
  function ensureReconciled(response) {
    if (activeEventMutations.size !== 0) {
      response.status(503).json({ error: 'Shared events are updating. Try again.' })
      return false
    }
    try {
      reconcilePendingShares()
      return true
    } catch (error) {
      console.error('Private share reconciliation unavailable:', error)
      response.status(503).json({ error: 'Shared events temporarily unavailable.' })
      return false
    }
  }

  // Drain any persisted pending intents before accepting browser traffic.
  // If a source DB is unavailable, startup fails instead of serving stale data.
  reconcilePendingShares()
  const app = express()
  app.disable('x-powered-by')
  // Login is the only endpoint that needs parsed JSON. All calendar request
  // bodies, including multipart uploads, must stream through unchanged.
  app.use('/api/auth/login', express.json({ limit: '32kb' }))
  // Only this exact anonymous join flow precedes required session protection.
  installPrivateHouseholdSignup(app, identityDatabase, serverDirectory)
  installFamilyAuth(app, identityDatabase, serverDirectory, 'required', {
    cookieName: '__Host-fc_gateway_session',
  })
  createEventCreatorAuditTables(identityDatabase)

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

  // Private-only owner invitation endpoints. Tenant identity comes strictly
  // from the verified central session, never client-supplied fields.
  function ownerOnlyMembershipAction(request, response, action) {
    const selected = trustedHousehold(request, response)
    if (!selected) return
    try {
      return action(selected.householdId)
    } catch (error) {
      if (error?.message === 'Active household owner permission required.') {
        response.status(403).json({ error: 'Household owner permission required.' })
      } else if (typeof error?.message === 'string'
        && error.message.startsWith('Too many invitations')) {
        response.status(429).json({ error: 'Invitation limit reached. Try later.' })
      } else {
        console.error('Household member operation unavailable:', error?.message)
        response.status(503).json({ error: 'Household membership service unavailable.' })
      }
    }
  }

  function decimalPathId(raw) {
    if (typeof raw !== 'string' || !/^[1-9][0-9]{0,14}$/.test(raw)) return null
    const id = Number(raw)
    return Number.isSafeInteger(id) ? id : null
  }

  // Active human accounts in this one verified household; owner access only.
  app.get('/api/households/members', (request, response) =>
    ownerOnlyMembershipAction(request, response, householdId => {
      response.set('Cache-Control', 'no-store')
      response.json({ members: listHouseholdMembers(identityDatabase, {
        householdId,
        serverVerifiedOwnerUserId: request.familyAccount.user_id,
      }) })
    }))

  app.get('/api/households/member-invitations', (request, response) =>
    ownerOnlyMembershipAction(request, response, householdId => {
      response.set('Cache-Control', 'no-store')
      response.json({ invitations: listHouseholdMemberInvitations(identityDatabase, {
        householdId,
        serverVerifiedOwnerUserId: request.familyAccount.user_id,
      }) })
    }))

  app.post('/api/households/member-invitations', (request, response) =>
    ownerOnlyMembershipAction(request, response, householdId => {
      const invitation = issueHouseholdMemberInvitation(identityDatabase, {
        householdId,
        serverVerifiedIssuerUserId: request.familyAccount.user_id,
      })
      // The one-time bearer secret is returned only to the issuing owner.
      // No secret is persisted in plaintext, returned by GET or logged.
      response.set('Cache-Control', 'no-store')
      response.status(201).json({
        ...invitation,
        // The bearer secret stays in the URL fragment, never the HTTP query.
        joinUrl: 'https://' + request.get('host') + '/join#token=' + invitation.token,
      })
    }))

  app.post('/api/households/member-invitations/:id/revoke', (request, response) => {
    const invitationId = decimalPathId(request.params.id)
    if (!invitationId) return response.status(400).json({ error: 'Invalid invitation.' })
    return ownerOnlyMembershipAction(request, response, householdId => {
      const revoked = revokeHouseholdMemberInvitation(identityDatabase, {
        householdId,
        serverVerifiedOwnerUserId: request.familyAccount.user_id,
        invitationId,
      })
      response.status(revoked ? 200 : 404).json(revoked
        ? { ok: true } : { error: 'Pending invitation not found.' })
    })
  })

  // Disable one verified member's access, without modifying their account or data.
  app.post('/api/households/members/:id/remove', (request, response) => {
    const targetUserId = decimalPathId(request.params.id)
    if (!targetUserId) return response.status(400).json({ error: 'Invalid member.' })
    return ownerOnlyMembershipAction(request, response, householdId => {
      const removed = revokeHouseholdMemberAccess(identityDatabase, {
        householdId,
        serverVerifiedOwnerUserId: request.familyAccount.user_id,
        targetUserId,
      })
      response.status(removed ? 200 : 404).json(removed
        ? { ok: true } : { error: 'Active member not found.' })
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

  // Authenticated read-only usage visibility. Setting or resetting limits is
  // NOT exposed to a family browser; only a trusted offline administrator may
  // opt the private test household in via central SQLite configuration.
  app.get('/api/ai-budget', (request, response) => {
    const household = trustedHousehold(request, response)
    if (!household) return
    response.set('Cache-Control', 'no-store')
    response.json({
      local: privateLocalAiBudgetStatus(identityDatabase, {
        householdId: household.householdId,
      }),
      paid: privatePaidApiBudgetStatus(identityDatabase, {
        householdId: household.householdId,
      }),
      paidCloudEnabled: false,
    })
  })

  // Block every browser write/alias under this gateway-owned budget route.
  app.use('/api/ai-budget', (_request, response) => {
    response.status(404).json({ error: 'Not found.' })
  })

  // Safe, read-only Arney calendar lookup: NO Ollama request and NO event
  // mutation. The date window is tightly bounded, and only the selected
  // family's events plus its explicitly accepted sharing overlays are read.
  app.get('/api/ai/calendar-lookup', (request, response) => {
    const household = trustedHousehold(request, response)
    if (!household) return
    if (Object.keys(request.query).some(key => key !== 'from' && key !== 'to') ||
        typeof request.query.from !== 'string' ||
        typeof request.query.to !== 'string') {
      return response.status(400).json({ error: 'Valid calendar date range required.' })
    }
    if (!ensureReconciled(response)) return
    let sourceDb
    try {
      const resolved = resolveHouseholdStorage({
        serverDirectory, storageRoot, householdId: household.householdId,
      })
      sourceDb = new DatabaseSync(resolved.databasePath, { readOnly: true })
      const result = listPrivateArneyCalendar({
        identityDatabase, sourceDatabase: sourceDb,
        serverVerifiedUserId: request.familyAccount.user_id,
        householdId: household.householdId,
        fromDate: request.query.from, toDate: request.query.to,
      })
      response.set('Cache-Control', 'no-store')
      response.json(result)
    } catch (error) {
      if (String(error?.message).includes('lookup result limit')) {
        response.status(413).json({ error: 'Calendar lookup has too many events for one request.' })
      } else if (String(error?.message).includes('calendar dates') ||
                 String(error?.message).includes('lookup range')) {
        response.status(400).json({ error: 'Invalid calendar lookup dates or range.' })
      } else {
        console.error('Private Arney calendar read unavailable:', error)
        response.status(503).json({ error: 'Calendar lookup temporarily unavailable.' })
      }
    } finally { sourceDb?.close() }
  })
  app.use('/api/ai/calendar-lookup', (_request, response) => {
    response.status(404).json({ error: 'Not found.' })
  })

  // Conservative speech/text entrypoint. No model and NO writing here.
  // The same signed preview is produced as by the structured event endpoint;
  // only a completely matched, unique own-household event is eligible.
  app.post('/api/ai/event-action-interpret', express.json({ limit: '4kb' }),
    (request, response) => {
      const household = trustedHousehold(request, response)
      if (!household) return
      if (request.originalUrl !== '/api/ai/event-action-interpret') {
        return response.status(404).json({ error: 'Not found.' })
      }
      if (!request.body || typeof request.body !== 'object' ||
          Array.isArray(request.body) ||
          Object.keys(request.body).some(key => key !== 'text')) {
        return response.status(400).json({ error: 'A text command is required.' })
      }
      if (!ensureReconciled(response)) return
      let sourceDb
      try {
        const storage = resolveHouseholdStorage({
          serverDirectory, storageRoot, householdId: household.householdId,
        })
        sourceDb = new DatabaseSync(storage.databasePath, { readOnly: true })
        const result = interpretPrivateArneyEventAction({
          identityDatabase, sourceDb, tokenKey: arneyActionTokenKey,
          verifiedUserId: request.familyAccount.user_id,
          verifiedSessionId: request.familyAccount.id,
          householdId: household.householdId, text: request.body.text,
        })
        response.set('Cache-Control', 'no-store')
        response.json(result)
      } catch (error) {
        if (error instanceof ArneyActionError) {
          response.status(error.status).json({ error: error.message })
        } else {
          console.error('Private Arney language interpretation unavailable:', error)
          response.status(503).json({ error: 'Calendar command temporarily unavailable.' })
        }
      } finally { sourceDb?.close() }
    })
  app.use('/api/ai/event-action-interpret', (_request, response) => {
    response.status(404).json({ error: 'Not found.' })
  })

  // Private gateway owns structured Arney previews and confirmed changes.
  // The legacy /api/ai/*-confirmed backend handlers remain BLOCKED. A signed
  // five-minute preview is bound to this exact account, session, household,
  // source-event UID and entire event snapshot, then independently confirmed.
  function handlePrivateArneyAction(request, response, operation) {
    const household = trustedHousehold(request, response)
    if (!household) return
    if (!ensureReconciled(response)) return
    let sourceDb
    let changed = false
    try {
      const storage = resolveHouseholdStorage({
        serverDirectory, storageRoot, householdId: household.householdId,
      })
      sourceDb = new DatabaseSync(storage.databasePath)
      const args = {
        sourceDb, tokenKey: arneyActionTokenKey,
        verifiedUserId: request.familyAccount.user_id,
        verifiedSessionId: request.familyAccount.id,
        householdId: household.householdId,
        request: request.body,
      }
      const result = operation === 'preview'
        ? previewPrivateArneyAction(args)
        : confirmPrivateArneyAction({
          ...args,
          beforeWrite: ({ sourceEventId }) => {
            // Durable CENTRAL pending intent BEFORE SQLite's source update.
            // The source-local outbox then records the same change atomically.
            markEventShareSyncPending(identityDatabase, {
              sourceHouseholdId: household.householdId, sourceEventId,
            })
          },
        })
      changed = operation === 'confirm'
      if (changed) reconcilePendingShares()
      response.set('Cache-Control', 'no-store')
      response.json(result)
    } catch (error) {
      if (changed) {
        // The source COMMIT cannot be undone. The pending central journal and
        // source-local outbox survive and MUST be replayed before sharing.
        console.error('Committed private Arney action awaits sync:', error)
        response.status(503).json({
          error: 'Event may have changed; shared synchronization unavailable. Refresh before retrying.',
        })
      } else if (error instanceof ArneyActionError) {
        response.status(error.status).json({ error: error.message })
      } else {
        console.error('Private Arney event action unavailable:', error)
        response.status(503).json({ error: 'Event action temporarily unavailable.' })
      }
    } finally { sourceDb?.close() }
  }
  app.post('/api/ai/event-action-preview', express.json({ limit: '4kb' }),
    (request, response) => handlePrivateArneyAction(request, response, 'preview'))
  app.post('/api/ai/event-action-confirm', express.json({ limit: '4kb' }),
    (request, response) => handlePrivateArneyAction(request, response, 'confirm'))
  for (const route of ['/api/ai/event-action-preview', '/api/ai/event-action-confirm']) {
    app.use(route, (_request, response) =>
      response.status(404).json({ error: 'Not found.' }))
  }

  // Only authorship of events in this verified household is exposed.
  // This does not fetch any other family's members, events or event creators.
  app.get('/api/event-creators', (request, response) => {
    const household = trustedHousehold(request, response)
    if (!household) return
    let sourceDb
    try {
      const resolved = resolveHouseholdStorage({
        serverDirectory, storageRoot, householdId: household.householdId,
      })
      sourceDb = new DatabaseSync(resolved.databasePath, { readOnly: true })
      response.set('Cache-Control', 'no-store')
      response.json({
        creators: listAuthenticatedEventCreators(identityDatabase, {
          verifiedUserId: request.familyAccount.user_id,
          verifiedHouseholdId: household.householdId,
          trustedSourceDb: sourceDb,
        }),
      })
    } catch {
      response.status(503).json({ error: 'Event creator information unavailable.' })
    } finally {
      sourceDb?.close()
    }
  })
  app.use('/api/event-creators', (_request, response) => {
    response.status(404).json({ error: 'Not found.' })
  })

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
    if (!ensureReconciled(response)) return
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
    if (!ensureReconciled(response)) return
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
    if (!ensureReconciled(response)) return
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
    if (!ensureReconciled(response)) return
    const { eventIds, recipientHouseholdIds, allowResend = false } = request.body ?? {}
    if (typeof allowResend !== 'boolean') {
      return response.status(400).json({ error: 'Invalid resend confirmation.' })
    }
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
        eventIds, recipientHouseholdIds, allowResend,
      })
      response.status(201).json({ invitations: created })
    } catch (error) {
      // Never leak source DB details, event IDs, internal paths or existence.
      const message = String(error?.message ?? '')
      const alreadyWaiting = message.includes('already waiting')
      const alreadyOnCalendar = message.includes('already on the receiving calendar')
      const previouslySent = message.includes('previously sent')
      const conflict = alreadyWaiting || alreadyOnCalendar || previouslySent ||
        error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || message.includes('UNIQUE constraint')
      response.status(conflict ? 409 : 400).json({
        error: alreadyWaiting ? 'An invitation is already waiting for this family.' :
          alreadyOnCalendar ? 'This event is already on their calendar.' :
          previouslySent ? 'An invitation was sent before. Confirm to resend it.' :
          conflict ? 'This invitation is already pending or accepted.' :
          'Could not share the selected events with the specified recipients.',
      })
    } finally {
      sourceDb?.close()
    }
  })
  app.post('/api/shared-events/:shareId/respond', parseShareJson, (request, response) => {
    const household = trustedHousehold(request, response)
    if (!household) return
    if (!ensureReconciled(response)) return
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
  // Recipient-side removal affects ONLY the accepted shared snapshot.
  // Never forward this action to /api/events or a sending-family backend.
  app.delete('/api/shared-events/:shareId/received', (request, response) => {
    const household = trustedHousehold(request, response)
    if (!household) return
    const shareId = Number(request.params.shareId)
    if (!Number.isSafeInteger(shareId) || shareId <= 0) {
      return response.status(404).json({ error: 'Accepted shared event unavailable.' })
    }
    try {
      response.set('Cache-Control', 'no-store')
      response.json(removeReceivedEventShare(identityDatabase, {
        serverVerifiedUserId: request.familyAccount.user_id,
        recipientHouseholdId: household.householdId,
        shareId,
      }))
    } catch {
      response.status(404).json({ error: 'Accepted shared event unavailable.' })
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

  // Never let a browser proxy to the test-only backend identity endpoint.
  // Its credential comes only from server-side trusted gateway configuration.
  app.use('/api/internal', (_request, response) => {
    response.status(404).json({ error: 'Not found.' })
  })

  app.use(async (request, response) => {
    // installFamilyAuth has already validated the central session and CSRF.
    const household = trustedHousehold(request, response)
    if (!household) return
    const policy = inspectPrivateGatewayMutation(
      request.method, request.originalUrl,
    )
    if (!policy.allowed) {
      return response.status(409).json({
        error: 'This event operation is not yet supported in the private family-sharing preview.',
      })
    }
    // A gateway can remain up while a backend process restarts on the same
    // port. Startup-only binding checks are not enough: fail closed BEFORE
    // forwarding a request, charging AI quota or journaling a calendar edit.
    // This tests accidental tenant/port misbinding, not OS process attestation.
    try {
      await verifyPrivateBackendBindings(
        new Map([[household.householdId, portByHousehold.get(household.householdId)]]),
        tokensByHousehold,
      )
    } catch {
      response.set('Cache-Control', 'no-store')
      return response.status(503).json({ error: 'Household service temporarily unavailable.' })
    }
    // Use exactly the same policy decision as the write-ahead journal. A
    // different route regex could let a backend mutation bypass sharing sync.
    if (policy.localAiIntent === true) {
      // Only one in-flight Ollama request is allowed across the entire
      // private gateway. A lost backend response remains quarantined instead
      // of immediately admitting additional GPU work.
      if (activeLocalAi.size !== 0) {
        return response.status(429).json({ error: 'Local AI is currently busy.' })
      }
      const quota = reservePrivateLocalAiRequest(identityDatabase, {
        householdId: household.householdId,
      })
      if (!quota.allowed) {
        return response.status(429).json({
          error: 'Household local AI monthly request limit reached.',
          remainingRequests: 0,
        })
      }
      activeLocalAi.add(household.householdId)
      response.locals.localAiSettled = (backendConfirmed) => {
        if (backendConfirmed) activeLocalAi.delete(household.householdId)
        // Unknown outcomes fail closed until the test gateway restarts.
      }
    }
    const sourceEventId = policy.sourceEventId ?? null
    const shouldSync = sourceEventId !== null
    const safeEventId = shouldSync
    const isCreate = policy.isCreate === true
    // Persist source-event intent BEFORE forwarding the request. Once the
    // household backend commits, a process death cannot lose this marker.
    // Even a failed backend request is safe to reconcile against final truth.
    if (shouldSync && safeEventId) {
      try {
        markEventShareSyncInFlight(identityDatabase, {
          sourceHouseholdId: household.householdId, sourceEventId,
        })
      } catch (error) {
        console.error('Unable to journal private shared event mutation:', error)
        return response.status(503).json({ error: 'Event update unavailable.' })
      }
      const key = household.householdId + ':' + sourceEventId
      activeEventMutations.set(key, (activeEventMutations.get(key) ?? 0) + 1)
      let finished = false
      function settle(backendConfirmed) {
        if (finished) return
        finished = true
        if (backendConfirmed) {
          try {
            acknowledgeEventShareSyncInFlight(identityDatabase, {
              sourceHouseholdId: household.householdId, sourceEventId,
            })
          } catch (error) {
            console.error('Unable to acknowledge completed source event:', error)
          }
        }
        // On uncertain outcomes the persisted in-flight counter remains
        // positive. All shared-event reads then fail closed until a fenced
        // offline reconciliation strategy exists.
        const pending = activeEventMutations.get(key) ?? 1
        if (pending <= 1) activeEventMutations.delete(key)
        else activeEventMutations.set(key, pending - 1)
        if (activeEventMutations.size !== 0) return
        try { reconcilePendingShares() } catch (error) {
          console.error('Private event share retry pending:', error)
        }
      }
      response.locals.eventMutationSettled = settle
    }

    const mutationHook = (shouldSync && safeEventId) || isCreate
      ? (backendResponseBody) => {
        const resolved = resolveHouseholdStorage({
          serverDirectory,
          storageRoot,
          householdId: household.householdId,
        })
        const sourceDatabase = new DatabaseSync(resolved.databasePath, { readOnly: true })
        try {
          if (isCreate && typeof backendResponseBody === 'string') {
            let created
            try { created = JSON.parse(backendResponseBody) } catch { created = null }
            if (Number.isSafeInteger(created?.id) && created.id > 0) {
              recordAuthenticatedEventCreator(identityDatabase, {
                verifiedUserId: request.familyAccount.user_id,
                verifiedHouseholdId: household.householdId,
                eventId: created.id,
                trustedSourceDb: sourceDatabase,
              })
            }
          } else if (shouldSync && safeEventId) {
            // Snapshot reconciliation happens after the response settles,
            // including rejected/aborted requests. The journal is durable.
            if (request.method === 'DELETE') {
              cleanupDeletedEventCreator(identityDatabase, {
                verifiedUserId: request.familyAccount.user_id,
                verifiedHouseholdId: household.householdId,
                eventId: sourceEventId,
                trustedSourceDb: sourceDatabase,
              })
            }
          }
        } finally {
          sourceDatabase.close()
        }
      }
      : null
    proxyRequest(request, response,
      portByHousehold.get(household.householdId),
      mutationHook, response.locals.eventMutationSettled ??
        response.locals.localAiSettled ?? null,
      tokensByHousehold.get(household.householdId))
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
    close: () => new Promise((resolve, reject) => {
      server.close(error => {
        if (error) return reject(error)
        try {
          writerLock.release()
          resolve()
        } catch (releaseError) { reject(releaseError) }
      })
    }),
  }
  } catch (error) {
    // Startup failure cannot strand a healthy writer lock. If ownership
    // changed, keep the lock quarantined rather than deleting it by force.
    try { writerLock.release() } catch (releaseError) {
      throw new AggregateError([error, releaseError],
        'Private gateway startup and writer-lock cleanup both failed.')
    }
    throw error
  }
}
