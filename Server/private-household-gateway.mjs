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
import { createPrivateGatewayDevicePersonResolver } from './private-gateway-device-profiles.mjs'
import { resolvePrivateFamilyLanding, installPrivateFamilyEntryRouting } from './private-family-entry-routing.mjs'
import {
  createEventCreatorAuditTables, recordAuthenticatedEventCreator,
  recordSharedHomeEventCreator, listAuthenticatedEventCreators, cleanupDeletedEventCreator,
} from './event-creator-audit.mjs'
import {
  listGrantedHouseholdsForSessionUser,
  getSelectedHouseholdForVerifiedSession,
  selectHouseholdForVerifiedSession,
  getSoleActiveHouseholdOwner,
} from './household-memberships.mjs'
import {
  createHouseholdInvitationTables, issueHouseholdMemberInvitation,
  listHouseholdMemberInvitations, revokeHouseholdMemberInvitation,
} from './household-member-invitations.mjs'
import { installPrivateHouseholdSignup } from './private-household-signup.mjs'
import { installPrivateIndependentHouseholdSignup } from './private-independent-household-signup.mjs'
import { createIndependentHouseholdInvitationTables, issueIndependentHouseholdInvitation,
  revokeIndependentHouseholdInvitation, listIndependentHouseholdAdministration,
} from './independent-household-invitations.mjs'
import { listHouseholdMembers } from './household-member-directory.mjs'
import { createFamilyMemberAccessTables, getFamilyMemberAuthorization, getVerifiedFamilyMemberAuthorization,
  setFamilyMemberType, setFamilyMemberPersonLink, setFamilyMemberPermission, FAMILY_ACTIONS,
} from './family-member-access.mjs'
import { createOwnerPasswordStepUp } from './family-owner-step-up.mjs'
import { createFamilyPasswordRecoveryTables } from './family-password-recovery.mjs'
import { installPrivateRecoveryPublic, installPrivateRecoveryOperator } from './private-family-password-recovery.mjs'
import { installPrivateSystemAdministrator } from './private-system-administration.mjs'
import { installPrivateInvitedOwnerOnboarding } from './private-invited-owner-onboarding.mjs'
import { installPrivateMemberRouteEnforcement } from './family-member-route-enforcement.mjs'
import { revokeHouseholdMemberAccess } from './household-member-access-revocation.mjs'
import { readPrivateHomePinPolicy, setPrivateHomePinPolicy } from './private-home-pin-policy.mjs'
import { installPrivateHomeKioskIdentity } from './private-home-kiosk-api.mjs'
import { installPrivateSharedHomeWriteGate } from './private-shared-home-write-gate.mjs'
import { installPrivatePhase1OwnerPilotGate } from './private-phase1-owner-pilot-gate.mjs'
import { installPrivatePhase1OwnerPilotUi } from './private-phase1-owner-pilot-ui.mjs'
import { createPrivateHomeWriteAuditTables, recordPrivateHomeWriteAudit } from './private-home-write-audit.mjs'
import { resolveHouseholdStorage } from './household-storage.mjs'
import { createPrivateActivationRecords, approvePrivateHouseholdActivation,
  assertApprovedPrivateHousehold } from './private-household-activation-records.mjs'
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

const BLOCKED_PORTS = new Set([443, 8443, 3001, 13001, 13002, 13003, 11434])
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])
const REQUEST_REMOVED = new Set([
  ...HOP_HEADERS,
  'cookie', 'authorization', 'host', PRIVATE_UPSTREAM_HEADER,
  'forwarded', 'x-forwarded-for', 'x-forwarded-host',
  // A proof is a session-bound secret. NEVER forward it to the legacy backend.
  'x-fc-home-actor-proof',
  'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip',
])
const RESPONSE_REMOVED = new Set([
  ...HOP_HEADERS, 'set-cookie', 'www-authenticate', 'location', PRIVATE_UPSTREAM_HEADER,
])
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

function verifiedBackendPort(port) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || BLOCKED_PORTS.has(port)) {
    throw new Error('Private household backend port must be a safe nonproduction port.')
  }
  return port
}

// Trusted startup-only bridge for a later guarded Windows TEST portproxy cutover.
// The old disposable harness remains random-port/loopback by default. A pinned
// port can only be requested in the explicitly restricted Phase 1 Owner mode.
// This NEVER starts a public listener or changes OS routing/firewall rules.
export function resolvePrivatePhase1GatewayLoopbackPort({
  port = null, phase1OwnerPilotOnly = false, backendPorts = [],
} = {}) {
  if (port == null) return 0
  if (phase1OwnerPilotOnly !== true ||
      !Number.isSafeInteger(port) || port < 1024 || port > 65535 ||
      BLOCKED_PORTS.has(port) || !Array.isArray(backendPorts) ||
      backendPorts.includes(port)) {
    throw new Error('Trusted Phase 1 gateway listener port must be a distinct nonproduction loopback port.')
  }
  return port
}

function validateUpstreams({ identityDatabase, serverDirectory, storageRoot, backendPorts,
  allowEmptyBootstrap = false }) {
  if (backendPorts === null || typeof backendPorts !== 'object'
      || Array.isArray(backendPorts) ||
      (Object.keys(backendPorts).length === 0 && !allowEmptyBootstrap)) {
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
    if (!getSoleActiveHouseholdOwner(identityDatabase, householdId)) {
      throw new Error('Private backend requires exactly one active Person Owner.')
    }
    ports.set(householdId, port)
  }
  return ports
}

// Fail closed before installing any login gateway routes or serving tenant data.
// This detects wiring a trusted token+port to the wrong household, but does NOT
// attest OS process identity or make the test gateway production-ready.
// An occasional abandoned keep-alive socket or brief Windows CI scheduling
// stall must not strand a healthy private gateway during a restart. Only a
// fetch-level transport failure is retryable; every HTTP/identity/protocol
// failure immediately fails closed. No client listener exists during checks.
async function verifyBindingOnce(householdId, port, upstreamToken) {
  let response
  try {
    response = await fetch('http://127.0.0.1:' + port +
      '/api/internal/household-binding', {
      method: 'GET', redirect: 'manual', cache: 'no-store',
      headers: {
        Accept: 'application/json',
        [PRIVATE_UPSTREAM_HEADER]: upstreamToken,
      },
      signal: AbortSignal.timeout(2500),
    })
  } catch (cause) {
    // Only failures before receiving any HTTP response can be transient.
    // Never retry authentication rejection or another household's identity.
    const retryable = new Error('Private backend binding transport unavailable.', { cause })
    retryable.retryableTransport = true
    throw retryable
  }
  if (response.status !== 200 ||
      !(response.headers.get('content-type') ?? '').toLowerCase()
        .includes('application/json')) {
    await response.body?.cancel()
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
}

// Exported for direct, disposable loopback-only regression testing; this does
// not create an HTTP route or relax the gateway's normal authorization.
export async function verifyPhase1BackendDirectDenial(port, upstreamToken) {
  verifiedBackendPort(port)
  requirePrivateUpstreamToken(upstreamToken)
  // Deliberately wrong, never the real secret. A single flipped nibble
  // guarantees inequality without printing or persisting either capability.
  const wrong = (upstreamToken[0] === '0' ? '1' : '0') + upstreamToken.slice(1)
  for (const headers of [{}, {[PRIVATE_UPSTREAM_HEADER]: wrong}]) {
    const response = await fetch('http://127.0.0.1:' + port +
      '/api/internal/household-binding', {
      method: 'GET', redirect: 'manual', cache: 'no-store', headers,
      signal: AbortSignal.timeout(2500),
    })
    await response.body?.cancel()
    if (response.status !== 403) {
      throw new Error('Phase 1 backend did not deny direct untrusted access.')
    }
  }
}

export async function verifyPrivateBackendBindings(portByHousehold, tokensByHousehold, {requireDirectDenial = false} = {}) {
  for (const [householdId, port] of portByHousehold) {
    let verified = false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await verifyBindingOnce(householdId, port, tokensByHousehold.get(householdId))
        verified = true
        break
      } catch (error) {
        // A wrong identity, auth rejection, bad JSON and broken stream are
        // terminal, never retried. Exhausted transport attempts also reject.
        if (error?.retryableTransport !== true || attempt === 2) {
          throw new Error('Private gateway refused unverified household backend: ' +
            householdId, { cause: error })
        }
        await new Promise(resolve => setTimeout(resolve, 125))
      }
    }
    if (!verified) {
      throw new Error('Private gateway refused unverified household backend: ' +
        householdId)
    }
    if (requireDirectDenial) await verifyPhase1BackendDirectDenial(port, tokensByHousehold.get(householdId))
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
 * random localhost port by default. An explicit Phase 1 pinned port requires
 * trusted startup configuration and is still loopback only; no public listener.
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
  // Empty by default; only trusted server configuration can permit issuance.
  independentHouseholdAdministratorUserIds = [],
  // Private disposable preview only. Never enable via request header or URL.
  enforceFamilyMemberPermissions = false,
  // Source-only, trusted startup switch for an intentionally NARROW first TEST
  // pilot. It cannot be toggled by login, URL or owner settings.
  phase1OwnerPilotOnly = false,
  // Trusted, opt-in fixed localhost port for future guarded TEST portproxy only.
  // Does not modify routes or allow public listening; default 0 stays ephemeral.
  trustedPhase1GatewayPort = null,
  // Explicit OFF-by-default first-family control-plane bootstrap (loopback only).
  allowEmptyGatewayBootstrap = false,
  // Optional trusted supervisor admission; never derived from a request.
  supervisorAdmissionCheck = null,
  activateReviewedHousehold = null,
}) {
  if (supervisorAdmissionCheck !== null &&
      (!phase1OwnerPilotOnly || typeof supervisorAdmissionCheck !== 'function')) {
    throw new Error('Supervisor admission is restricted to the trusted Phase 1 runtime.')
  }
  if (activateReviewedHousehold !== null && (!phase1OwnerPilotOnly || supervisorAdmissionCheck === null || typeof activateReviewedHousehold !== 'function')) throw Error('Browser activation requires the reviewed supervisor.')
  function admittedBySupervisor() {
    if (supervisorAdmissionCheck === null) return true
    try { return supervisorAdmissionCheck() === true } catch { return false }
  }
  function denySupervisorAdmission(response) {
    return response.set('Cache-Control','no-store').status(503).json({error:'Private calendar service temporarily unavailable.'})
  }
  if (typeof enforceFamilyMemberPermissions !== 'boolean') {
    throw new Error('Private family permission enforcement must be a trusted boolean setting.')
  }
  if (typeof phase1OwnerPilotOnly !== 'boolean' ||
      (phase1OwnerPilotOnly && !enforceFamilyMemberPermissions) ||
      (phase1OwnerPilotOnly && independentHouseholdAdministratorUserIds.length === 0)) {
    throw new Error('Phase 1 Owner pilot requires explicit trusted operator and strict member enforcement.')
  }
  if (!Array.isArray(independentHouseholdAdministratorUserIds) ||
      independentHouseholdAdministratorUserIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error('Invalid private administrator allowlist.')
  }
  if (typeof allowEmptyGatewayBootstrap !== 'boolean' ||
      (allowEmptyGatewayBootstrap && independentHouseholdAdministratorUserIds.length === 0)) {
    throw new Error('Private empty-backend bootstrap needs an explicit trusted administrator.')
  }
  const portByHousehold = validateUpstreams({
    identityDatabase, serverDirectory, storageRoot, backendPorts,
    allowEmptyBootstrap: allowEmptyGatewayBootstrap,
  })
  // Resolve before any gateway lock, SQLite mutation or listening socket.
  const gatewayLoopbackPort = resolvePrivatePhase1GatewayLoopbackPort({
    port: trustedPhase1GatewayPort, phase1OwnerPilotOnly,
    backendPorts: [...portByHousehold.values()],
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
  await verifyPrivateBackendBindings(portByHousehold, tokensByHousehold, {requireDirectDenial: phase1OwnerPilotOnly})
  // Only one private test gateway may mutate central/share SQLite and read
  // household source outboxes at a time. Acquire BEFORE creating any tables.
  const writerLock = acquirePrivateGatewayWriterLock(storageRoot)
  try {
  // Invitation state is central-only, never stored in household calendars.
  createHouseholdInvitationTables(identityDatabase)
  // Central identity only; no migrations to any family's calendar database.
  createFamilyMemberAccessTables(identityDatabase)
  createIndependentHouseholdInvitationTables(identityDatabase)
  createFamilyPasswordRecoveryTables(identityDatabase)
  createPrivateActivationRecords(identityDatabase)
  // The trusted host may only rebind a generated independent household that
  // was explicitly approved after its previous identity-checked activation.
  // Being in the registry or having a backend started is insufficient.
  for (const householdId of portByHousehold.keys()) {
    assertApprovedPrivateHousehold(identityDatabase, householdId)
  }
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
  const ownerPasswordStepUp = createOwnerPasswordStepUp()
  const app = express()
  app.disable('x-powered-by')
  // Must precede login, health, all central writes and household routing.
  app.use((_request,response,next) => {
    if (!admittedBySupervisor()) return denySupervisorAdmission(response)
    next()
  })
  // Only login and signed-in device-profile selection need parsed JSON.
  // Calendar requests (including multipart uploads) still stream unchanged.
  app.use('/api/auth/login', express.json({ limit: '32kb' }))
  app.use('/api/auth/device-profile', express.json({ limit: '8kb', strict: true }))
  // Secure public request and one-time reset claim before required login.
  installPrivateRecoveryPublic(app, { identityDatabase, serverDirectory })
  // Only this exact anonymous join flow precedes required session protection.
  installPrivateHouseholdSignup(app, identityDatabase, serverDirectory)
  installPrivateIndependentHouseholdSignup(app, {
    identityDatabase, serverDirectory, storageRoot,
    trustedAdministratorUserIds: independentHouseholdAdministratorUserIds,
  })
  // Central sessions cannot query a global People table: each household
  // keeps its own database. The display resolver never grants actor rights.
  const resolveDevicePersonName = createPrivateGatewayDevicePersonResolver({
    identityDatabase, serverDirectory, storageRoot,
    getRoutedHouseholdIds: () => [...portByHousehold.keys()],
  })
  // An existing invited Owner must not be redirected to the calendar
  // before the operator has activated that exact household. Operator login
  // goes directly to its separate metadata-only system dashboard.
  const resolveSignedInLanding = session => resolvePrivateFamilyLanding(identityDatabase, {
    serverVerifiedUserId: session.user_id,
    trustedAdministratorUserIds: independentHouseholdAdministratorUserIds,
    routedHouseholdIds: [...portByHousehold.keys()],
  })
  installFamilyAuth(app, identityDatabase, serverDirectory, 'required', {
    cookieName: '__Host-fc_gateway_session', resolveDevicePersonName,
    resolveSignedInLanding,
    denyPrivateGatewayKioskDeviceManagement: session => Boolean(
      identityDatabase.prepare([
        'SELECT 1 FROM private_home_kiosk_sessions',
        'WHERE session_id=? AND disabled_at IS NULL',
      ].join(' ')).get(session.id)
    ),
  })
  // Before ANY gateway-controlled administration, kiosk routes, AI or
  // backend proxy, restrict the first pilot to invited Owners + operator
  // metadata. All nonessential APIs and uploads fail closed.
  if (phase1OwnerPilotOnly) {
    installPrivatePhase1OwnerPilotGate(app, {
      identityDatabase,
      trustedAdministratorUserIds: independentHouseholdAdministratorUserIds,
    })
    // Only after the strict phase gate: give configured invited Owners a
    // usable narrow page instead of the full calendar SPA's disabled APIs.
    installPrivatePhase1OwnerPilotUi(app, {
      identityDatabase,
      trustedAdministratorUserIds: independentHouseholdAdministratorUserIds,
      getRoutedHouseholdIds: () => [...portByHousehold.keys()],
    })
  }
  // Register the dedicated PIN enrollment/challenge routes BEFORE the Home
  // action gate. Owner changes here always require a real account password.
  const privateHomeIdentity = installPrivateHomeKioskIdentity(app, {
    identityDatabase, serverDirectory, storageRoot,
    trustedHousehold, ownerPasswordStepUp,
  })
  // Every later route, including Owner administrative routes, Arney and the
  // backend proxy, is subject to a DENY-by-default shared Home action gate.
  // A Home avatar alone is not an enrollment; personal phones are unchanged.
  installPrivateSharedHomeWriteGate(app, {
    identityDatabase, serverDirectory, storageRoot, trustedHousehold,
    resolveHomeActorProof: privateHomeIdentity.resolveHomeActorProof,
  })
  // Operator review and opt-in contact editing require a verified existing
  // session, and one more real password check before sensitive writes.
  installPrivateRecoveryOperator(app, {
    identityDatabase, trustedAdministratorUserIds: independentHouseholdAdministratorUserIds,
    passwordStepUp: ownerPasswordStepUp,
  })
  // A dedicated SYSTEM operator route, never inside any household settings
  // pane or backend. Read-only metadata, invitations and recovery review.
  installPrivateSystemAdministrator(app, {
    identityDatabase, serverDirectory, storageRoot,
    trustedAdministratorUserIds: independentHouseholdAdministratorUserIds,
    activateReviewedHousehold,
    // Enrollment can add a verified private backend after initial boot.
    // Always derive operator status from the current trusted route map.
    getRoutedHouseholdIds: () => [...portByHousehold.keys()],
  })
  // Newly invited Owner status is derived ONLY from their verified session
  // and current activated, trusted gateway routing. Never activate via UI.
  installPrivateInvitedOwnerOnboarding(app, {
    identityDatabase, serverDirectory,
    getRoutedHouseholdIds: () => [...portByHousehold.keys()],
  })
  installPrivateFamilyEntryRouting(app, {
    identityDatabase,
    trustedAdministratorUserIds: independentHouseholdAdministratorUserIds,
    getRoutedHouseholdIds: () => [...portByHousehold.keys()],
  })
  // The former Capture Inbox is retired. Do not let an authenticated Owner,
  // Adult or Child use the old inbox read/write API through a private family
  // backend, even while the optional member-enforcement pilot is OFF.
  // This does NOT block the separate direct Analyze Photo / Take Photo flow.
  // Old SQLite capture records and uploads are never erased here.
  app.use('/api/capture-inbox', (_request, response) => {
    response.status(404).json({ error: 'Not found.' })
  })

  // Never forward an unknown administrator API to a family backend.
  app.use('/api/admin', (_request, response) =>
    response.status(404).json({ error: 'Not found.' }))
  // This policy must register BEFORE gateway-owned Arney/share endpoints
  // AND the backend proxy. If enabled, unknown API routes fail closed.
  if (enforceFamilyMemberPermissions) {
    installPrivateMemberRouteEnforcement(app, {
      identityDatabase, trustedHousehold,
    })
  }
  createEventCreatorAuditTables(identityDatabase)
  createPrivateHomeWriteAuditTables(identityDatabase)

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

  // Private operator inventory. An ordinary household owner is NOT an
  // operator; permission is checked against server-trusted numeric IDs.
  // Return only this operator's invitations / registered families; no secrets,
  // raw invitation tokens, credential hashes or filesystem paths.
  app.get('/api/households/independent-administration', (request, response) => {
    response.set('Cache-Control', 'no-store')
    try {
      const state = listIndependentHouseholdAdministration(identityDatabase, {
        serverVerifiedAdministratorUserId: request.familyAccount.user_id,
        trustedAdministratorUserIds: independentHouseholdAdministratorUserIds,
      })
      response.json({
        invitations: state.invitations,
        households: state.households.map(household => ({
          householdId: household.householdId,
          displayName: household.displayName,
          state: !household.approved ? 'pending' :
            portByHousehold.has(household.householdId) ? 'routed' : 'approved-unrouted',
        })),
      })
    } catch (error) {
      response.status(error?.message === 'Trusted calendar administrator permission required.'
        ? 403 : 503).json({ error: 'Private household administration unavailable.' })
    }
  })

  // New-household invitation issuance is distinct from inviting a member into
  // an existing household. A browser can never supply an administrator role.
  app.post('/api/households/independent-invitations', (request, response) => {
    try {
      const invite = issueIndependentHouseholdInvitation(identityDatabase, {
        serverVerifiedAdministratorUserId: request.familyAccount.user_id,
        trustedAdministratorUserIds: independentHouseholdAdministratorUserIds,
      })
      response.set('Cache-Control', 'no-store')
      response.status(201).json({
        ...invite,
        startUrl: 'https://' + request.get('host') + '/start-family#token=' + invite.token,
      })
    } catch (error) {
      response.status(error?.message === 'Trusted calendar administrator permission required.'
        ? 403 : error?.message === 'Independent household invitation limit reached.'
          ? 429 : 503).json({ error: 'Independent household invitation unavailable.' })
    }
  })
  app.post('/api/households/independent-invitations/:id/revoke', (request, response) => {
    const invitationId = decimalPathId(request.params.id)
    if (!invitationId) return response.status(400).json({ error: 'Invalid invitation.' })
    try {
      const revoked = revokeIndependentHouseholdInvitation(identityDatabase, {
        serverVerifiedAdministratorUserId: request.familyAccount.user_id,
        trustedAdministratorUserIds: independentHouseholdAdministratorUserIds,
        invitationId,
      })
      response.status(revoked ? 200 : 404).json(revoked ? { ok: true }
        : { error: 'Pending invitation not found.' })
    } catch (error) {
      response.status(error?.message === 'Trusted calendar administrator permission required.'
        ? 403 : 503).json({ error: 'Independent household invitation unavailable.' })
    }
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

  // PRIVATE HARNESS ONLY: read the member's effective role from their actual
  // authenticated central session and an independently verified household.
  // A chosen People avatar, mobile User-Agent or request body grants nothing.
  // No PIN is needed for a valid personal-account session.
  app.get('/api/households/my-member-access', (request, response) => {
    const home = trustedHousehold(request, response)
    if (!home) return
    const storage = resolveHouseholdStorage({
      serverDirectory, storageRoot, householdId: home.householdId,
    })
    const calendarDb = new DatabaseSync(storage.databasePath, { readOnly: true })
    try {
      const actor = getVerifiedFamilyMemberAuthorization(identityDatabase, {
        householdId: home.householdId,
        serverVerifiedUserId: request.familyAccount.user_id,
        householdDatabase: calendarDb,
      })
      response.set('Cache-Control', 'no-store')
      if (!actor) return response.status(403).json({
        error: 'Family account permissions are not configured yet.',
      })
      response.json({
        memberType: actor.role, linkedPersonId: actor.personId,
        allowedActions: actor.permissions,
      })
    } catch (error) {
      console.error('Private member access lookup unavailable:', error?.message)
      response.status(503).json({ error: 'Member access temporarily unavailable.' })
    } finally {
      calendarDb.close()
    }
  })

  // An Owner can review the active household's existing account-to-People
  // links. This is READ-ONLY; changing membership permissions/links requires a
  // separate password-step-up flow, not a selected avatar or Home PIN.
  app.get('/api/households/member-access', (request, response) =>
    ownerOnlyMembershipAction(request, response, householdId => {
      const storage = resolveHouseholdStorage({
        serverDirectory, storageRoot, householdId,
      })
      const calendarDb = new DatabaseSync(storage.databasePath, { readOnly: true })
      try {
        const members = listHouseholdMembers(identityDatabase, {
          householdId,
          serverVerifiedOwnerUserId: request.familyAccount.user_id,
        }).map(member => {
          const actor = getVerifiedFamilyMemberAuthorization(identityDatabase, {
            householdId, serverVerifiedUserId: member.userId,
            householdDatabase: calendarDb,
          })
          const person = actor?.personId == null ? null :
            calendarDb.prepare('SELECT name FROM people WHERE id = ?').get(actor.personId)
          return {
            userId: member.userId, displayName: member.displayName,
            username: member.username, memberType: actor?.role ?? null,
            linkedPersonId: actor?.personId ?? null,
            linkedPersonName: person?.name ?? null,
            allowedActions: actor?.permissions ?? [],
          }
        })
        // Owner-scoped EXISTING People only. Never let a browser create or
        // modify a People row as a side effect of account linking.
        const availablePeople = calendarDb.prepare(
          'SELECT id, name FROM people ORDER BY name COLLATE NOCASE, id'
        ).all().map(person => ({ ...person }))
        response.set('Cache-Control', 'no-store')
        response.json({ members, availablePeople })
      } finally {
        calendarDb.close()
      }
    }))

  // PRIVATE LOCAL GATEWAY ONLY. Sensitive account operations require the
  // Owner's actual password on EVERY change; the personal phone's valid
  // session alone is not administrative step-up. No 4-digit mobile PIN.
  // The existing auth middleware enforces HTTPS same-origin CSRF first.
  async function changeMemberAsVerifiedOwner(request, response, action) {
    const household = trustedHousehold(request, response)
    if (!household) return
    const ownerUserId = request.familyAccount.user_id
    const actor = getFamilyMemberAuthorization(identityDatabase, {
      householdId: household.householdId,
      serverVerifiedUserId: ownerUserId,
    })
    if (actor?.role !== 'owner') {
      return response.status(403).json({ error: 'Household Owner required.' })
    }
    const memberUserId = decimalPathId(request.params.id)
    if (!memberUserId) {
      return response.status(400).json({ error: 'Invalid family member.' })
    }
    let reverified
    try {
      reverified = await ownerPasswordStepUp.verify(identityDatabase, {
        serverVerifiedUserId: ownerUserId,
        password: request.body?.ownerPassword,
      })
    } catch (error) {
      console.error('Owner password verification unavailable:', error?.message)
      return response.status(503).json({ error: 'Owner verification unavailable.' })
    }
    if (reverified.status === 'limited') {
      response.set('Retry-After', String(reverified.retryAfter))
      return response.status(429).json({ error: 'Too many password attempts. Try later.' })
    }
    if (reverified.status === 'busy') {
      response.set('Retry-After', '1')
      return response.status(503).json({ error: 'Owner verification is busy.' })
    }
    if (reverified.status !== 'verified') {
      return response.status(403).json({ error: 'Owner password verification failed.' })
    }
    // Membership and Owner role are checked AGAIN in the transactional
    // setter after awaiting scrypt; stale/revoked sessions cannot mutate.
    try {
      await action(household.householdId, ownerUserId, memberUserId)
      response.set('Cache-Control', 'no-store')
      return response.json({ ok: true })
    } catch (error) {
      const message = error?.message ?? ''
      if (message === 'Person does not exist in this household calendar.' ||
          message === 'Member type must be adult or child.' ||
          message === 'Permission enabled must be a boolean.') {
        return response.status(400).json({ error: 'Invalid member setting.' })
      }
      if (message.includes('UNIQUE constraint failed')) {
        return response.status(409).json({ error: 'This Person is already linked to an account.' })
      }
      if (/Owner required|Target must be|not delegable|Adult administrative|Member must be|Target must be an active/.test(message)) {
        return response.status(403).json({ error: 'Member change is not permitted.' })
      }
      console.error('Member management unavailable:', message)
      return response.status(503).json({ error: 'Member change temporarily unavailable.' })
    }
  }

  const parseMemberChange = express.json({ limit: '8kb' })

  app.post('/api/households/members/:id/type', parseMemberChange, (request, response) => {
    if (!['adult', 'child'].includes(request.body?.memberType)) {
      return response.status(400).json({ error: 'Choose Adult or Child.' })
    }
    return changeMemberAsVerifiedOwner(request, response, (householdId, ownerUserId, memberUserId) =>
      setFamilyMemberType(identityDatabase, {
        householdId, serverVerifiedOwnerUserId: ownerUserId,
        targetUserId: memberUserId, memberType: request.body.memberType,
      }))
  })

  app.post('/api/households/members/:id/person', parseMemberChange, (request, response) => {
    const personId = request.body?.personId
    if (!request.body || !Object.hasOwn(request.body, 'personId') ||
        (personId !== null && (!Number.isSafeInteger(personId) || personId < 1))) {
      return response.status(400).json({ error: 'Choose an existing Person or Unlink.' })
    }
    return changeMemberAsVerifiedOwner(request, response, (householdId, ownerUserId, memberUserId) => {
      const storage = resolveHouseholdStorage({ serverDirectory, storageRoot, householdId })
      const calendarDb = new DatabaseSync(storage.databasePath, { readOnly: true })
      try {
        return setFamilyMemberPersonLink(identityDatabase, {
          householdId, serverVerifiedOwnerUserId: ownerUserId,
          targetUserId: memberUserId, personId, householdDatabase: calendarDb,
        })
      } finally {
        calendarDb.close()
      }
    })
  })

  app.post('/api/households/members/:id/permission', parseMemberChange, (request, response) => {
    const { action, enabled } = request.body ?? {}
    if (typeof action !== 'string' || !FAMILY_ACTIONS.includes(action) ||
        typeof enabled !== 'boolean') {
      return response.status(400).json({ error: 'Choose a valid permission and state.' })
    }
    return changeMemberAsVerifiedOwner(request, response, (householdId, ownerUserId, memberUserId) =>
      setFamilyMemberPermission(identityDatabase, {
        householdId, serverVerifiedOwnerUserId: ownerUserId,
        targetUserId: memberUserId, action, enabled,
      }))
  })

  // PRIVATE SOURCE-ONLY policy switch for the future SHARED Home kiosk.
  // This preference does NOT authenticate a person or remove any current
  // actor check: the device/PIN execution layer is not installed yet.
  app.get('/api/households/home-pin', (request, response) => {
    response.set('Cache-Control', 'no-store')
    if (request.originalUrl !== '/api/households/home-pin') {
      return response.status(404).json({ error: 'Not found.' })
    }
    return ownerOnlyMembershipAction(request, response, householdId => {
      response.json(readPrivateHomePinPolicy(identityDatabase, {
        householdId, serverVerifiedOwnerUserId: request.familyAccount.user_id,
      }))
    })
  })

  app.post('/api/households/home-pin', express.json({ limit: '4kb', strict: true }),
    async (request, response) => {
      response.set('Cache-Control', 'no-store')
      if (request.originalUrl !== '/api/households/home-pin' ||
          !request.body || typeof request.body !== 'object' ||
          Array.isArray(request.body) ||
          Object.keys(request.body).length !== 2 ||
          typeof request.body.pinEnabled !== 'boolean' ||
          typeof request.body.ownerPassword !== 'string') {
        return response.status(400).json({ error: 'Choose a valid shared Home PIN setting.' })
      }
      const home = trustedHousehold(request, response)
      if (!home) return
      const verifiedUserId = request.familyAccount.user_id
      const actor = getFamilyMemberAuthorization(identityDatabase, {
        householdId: home.householdId, serverVerifiedUserId: verifiedUserId,
      })
      if (actor?.role !== 'owner') {
        return response.status(403).json({ error: 'Household Owner required.' })
      }
      let stepUp
      try {
        stepUp = await ownerPasswordStepUp.verify(identityDatabase, {
          serverVerifiedUserId: verifiedUserId,
          password: request.body.ownerPassword,
        })
      } catch (error) {
        console.error('Shared Home PIN Owner verification unavailable:', error?.message)
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
        return response.status(403).json({ error: 'Owner password verification failed.' })
      }
      try {
        // Must recheck the Owner under the SQLite write lock after scrypt.
        return response.json(setPrivateHomePinPolicy(identityDatabase, {
          householdId: home.householdId, serverVerifiedOwnerUserId: verifiedUserId,
          pinEnabled: request.body.pinEnabled,
        }))
      } catch (error) {
        if (error?.message === 'Active household Owner required.') {
          return response.status(403).json({ error: 'Household Owner required.' })
        }
        console.error('Shared Home PIN setting unavailable:', error?.message)
        return response.status(503).json({ error: 'Home PIN preference unavailable.' })
      }
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
        {requireDirectDenial: phase1OwnerPilotOnly},
      )
    } catch {
      response.set('Cache-Control', 'no-store')
      return response.status(503).json({ error: 'Household service temporarily unavailable.' })
    }
    // Recheck after awaited binding probes; a child may have failed meanwhile.
    if (!admittedBySupervisor()) return denySupervisorAdmission(response)
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
    const privateHomeActor = response.locals.privateHomeActor ?? null
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

    const mutationHook = (shouldSync && safeEventId) || isCreate || privateHomeActor
      ? (backendResponseBody) => {
        const resolved = resolveHouseholdStorage({
          serverDirectory,
          storageRoot,
          householdId: household.householdId,
        })
        const sourceDatabase = new DatabaseSync(resolved.databasePath, { readOnly: true })
        try {
          let created
          if (typeof backendResponseBody === 'string') {
            try { created = JSON.parse(backendResponseBody) } catch { created = null }
          }
          if (isCreate && Number.isSafeInteger(created?.id) && created.id > 0) {
            if (privateHomeActor?.kind === 'shared-home') {
              recordSharedHomeEventCreator(identityDatabase, {
                verifiedKioskOwnerUserId: request.familyAccount.user_id,
                verifiedHouseholdId: household.householdId,
                eventId: created.id, trustedSourceDb: sourceDatabase,
              })
            } else {
              // On a kiosk, the real PIN-verified person is the author,
              // never the Owner identity that enrolled the shared device.
              recordAuthenticatedEventCreator(identityDatabase, {
                verifiedUserId: privateHomeActor?.userId ?? request.familyAccount.user_id,
                verifiedHouseholdId: household.householdId,
                eventId: created.id, trustedSourceDb: sourceDatabase,
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
          if (privateHomeActor) {
            // A successful backend response, not a claimed browser role,
            // determines whether a Home write is attributed. This audit is
            // not yet a crash-proof intent journal: keep release on HOLD.
            recordPrivateHomeWriteAudit(identityDatabase, {
              householdId: household.householdId,
              serverVerifiedKioskUserId: request.familyAccount.user_id,
              serverVerifiedSessionId: request.familyAccount.id,
              attribution: privateHomeActor,
              method: request.method, route: request.originalUrl,
              resourceId: Number.isSafeInteger(created?.id) && created.id > 0
                ? created.id : sourceEventId,
            })
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

  // Trusted server-side activation only: NO HTTP route invokes this operation.
  // A newly registered family is not routable until its own separately started
  // localhost backend proves the household identity and private service token.
  // This is an IN-MEMORY enrollment; restarts require an explicitly reviewed
  // backend configuration. Never auto-start a process from signup or a cookie.
  let closing = false
  let enrollmentInProgress = false
  async function enrollHouseholdBackend({ householdId, port, upstreamToken }) {
    if (closing || enrollmentInProgress) {
      throw new Error('Private gateway is closing or already enrolling a household.')
    }
    enrollmentInProgress = true
    try {
      const candidate = validateUpstreams({
        identityDatabase, serverDirectory, storageRoot,
        backendPorts: Object.fromEntries([[householdId, port]]),
      })
      if (portByHousehold.has(householdId)) {
        throw new Error('Household backend is already enrolled.')
      }
      if ([...portByHousehold.values(), server.address()?.port].includes(port)) {
        throw new Error('Private service port is already in use.')
      }
      const token = requirePrivateUpstreamToken(upstreamToken)
      if (usedTokens.has(token)) throw new Error('Household backend secret is already in use.')

      // Restrict live enrollment to first owners created by the specific
      // independent-household invitation flow, not arbitrary registry rows.
      const eligible = identityDatabase.prepare([
        'SELECT 1 AS allowed FROM independent_household_invitations i',
        'JOIN household_registry h ON h.id = i.household_id',
        'JOIN family_users u ON u.id = i.redeemed_user_id',
        'JOIN household_memberships m ON m.user_id = u.id AND m.household_id = h.id',
        'WHERE h.storage_id = ? AND h.disabled = 0 AND u.disabled = 0',
        "AND m.role = 'owner' AND m.disabled = 0",
        'AND i.redeemed_at IS NOT NULL AND i.revoked_at IS NULL LIMIT 1',
      ].join(' ')).get(householdId)
      if (!eligible) throw new Error('Household has no active invited owner.')

      await verifyPrivateBackendBindings(candidate,
        new Map([[householdId, token]]), {requireDirectDenial: phase1OwnerPilotOnly})
      if (closing) throw new Error('Private gateway closed during enrollment.')
      if (activeEventMutations.size !== 0 || activeLocalAi.size !== 0) {
        throw new Error('Private gateway has active work; retry enrollment.')
      }

      // No tenant data is ever copied. Only an EMPTY new household can be
      // enrolled via this live private-preview operation. A nonempty source
      // requires a separate offline import/recovery review.
      const storage = resolveHouseholdStorage({
        serverDirectory, storageRoot, householdId,
      })
      const source = new DatabaseSync(storage.databasePath)
      try {
        const hasEvents = source.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'"
        ).get()
        if (!hasEvents || source.prepare('SELECT COUNT(*) AS n FROM events').get().n !== 0) {
          throw new Error('New household backend must have an empty initialized event table.')
        }
        const grants = identityDatabase.prepare([
          'SELECT COUNT(*) AS n FROM event_share_grants g',
          'JOIN household_registry h ON h.id = g.source_household_id',
          'WHERE h.storage_id = ?',
        ].join(' ')).get(householdId).n
        if (grants !== 0 || countPendingEventShareSync(identityDatabase, {
          sourceHouseholdId: householdId,
        }) !== 0) {
          throw new Error('Household has unresolved sharing activity.')
        }
        installPrivateEventSourceOutbox(source)
      } finally {
        source.close()
      }

      // Persist approval in CENTRAL SQLite, not a browser cookie or local
      // port/secret file. Recovery must rotate a fresh secret and prove a
      // newly started backend's identity on every private gateway boot.
      approvePrivateHouseholdActivation(identityDatabase, { householdId })
      // Publish only after all filesystem, ownership, identity and recovery
      // preconditions succeed. No partial route or token survives rejection.
      portByHousehold.set(householdId, port)
      tokensByHousehold.set(householdId, token)
      usedTokens.add(token)
      return { householdId, activation: 'active' }
    } finally {
      enrollmentInProgress = false
    }
  }

  const server = http.createServer(app)
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(gatewayLoopbackPort, '127.0.0.1', resolve)
    })
  } catch (error) {
    server.close()
    throw error
  }

  const address = server.address()
  if (typeof address !== 'object' || address?.address !== '127.0.0.1'
      || BLOCKED_PORTS.has(address.port)
      || (gatewayLoopbackPort !== 0 && address.port !== gatewayLoopbackPort)) {
    server.close()
    throw new Error('Gateway failed private listener validation.')
  }
  async function closeGateway(stopBackendsForBackup = null) {
    if (closing || enrollmentInProgress) {
      throw new Error('Gateway is closing or household enrollment is in progress.')
    }
    closing = true
    await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()))
    if (stopBackendsForBackup !== null) {
      // The supervisor has already closed admission. Confirm every captured
      // backend has stopped BEFORE replaying the final durable source outbox.
      // A successful POST create may leave an outbox row even when no
      // existing-event share mutation is in flight. Never discard that row.
      await stopBackendsForBackup()
      if (activeEventMutations.size !== 0 || activeLocalAi.size !== 0) {
        throw new Error('Unresolved gateway mutations prevent offline backup.')
      }
      reconcilePendingShares()
      if (countPendingEventShareSync(identityDatabase) !== 0) {
        throw new Error('Unresolved central journal prevents offline backup.')
      }
    }
    // On any failed shutdown/reconciliation retain the writer lock for review.
    writerLock.release()
  }
  return {
    base: 'http://127.0.0.1:' + address.port,
    port: address.port,
    enrollHouseholdBackend,
    close: () => closeGateway(),
    ...(phase1OwnerPilotOnly && supervisorAdmissionCheck !== null ? {
      closeForOfflineBackup: async stopBackends => {
        if (typeof stopBackends !== 'function' || admittedBySupervisor()) {
          throw new Error('Closed supervisor admission and captured-child shutdown are required.')
        }
        await closeGateway(stopBackends)
      },
    } : {}),
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
