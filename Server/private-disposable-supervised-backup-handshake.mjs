// DISPOSABLE/OFFLINE snapshot handshake — NOT a Windows service or live backup.
// Coordinates the existing reviewed supervisor ownership lock and existing
// offline capture rehearsal with proof that its captured child handles exited,
// and that all nominated loopback listeners refuse connections. These checks
// do NOT prove OS-wide writer fencing, SQLite checkpointing or LIVE safety.
// Production paths are rejected by the underlying OS-temp-only capture.
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ChildProcess } from 'node:child_process'
import { captureDisposableCoordinatedHouseholdSnapshot }
  from './private-disposable-coordinated-snapshot.mjs'

const BLOCKED_PORTS = new Set([3001, 13001, 13002, 13003, 11434, 443, 8443])
const FRIEND = /^family-[a-f0-9]{24}$/
const PRIMARY = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

function fail(message) {
  throw new Error('Disposable supervised capture refused: ' + message)
}

function safePort(port) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 ||
      BLOCKED_PORTS.has(port)) fail('invalid or reserved loopback service port.')
  return port
}

async function requireClosedLoopback(port) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let finished = false
    function finish(error) {
      if (finished) return
      finished = true
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    socket.once('connect', () =>
      finish(new Error('Private loopback listener still accepts connections.')))
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') return finish()
      finish(new Error('Loopback closure cannot be verified.'))
    })
    socket.setTimeout(1200, () =>
      finish(new Error('Loopback closure timed out; writer status unknown.')))
  })
}

/**
 * Prototype: the caller must have already shut the gateway and requested
 * graceful exits of *every exact* captured backend. The durable supervisor
 * instance remains locked for the ENTIRE copy. Any failed copy or suspected
 * listener intentionally leaves the owner in 'capturing' for manual review:
 * there is NO automatic unlock or rollback-to-running API.
 */
export async function captureAfterDisposableReviewedShutdown({
  plan, supervisor, backends, backendPorts, gatewayPort, gatewayClosed,
  serverDirectory, sourceRoot, destinationRoot,
}) {
  const ids = plan?.householdIds
  if (!Object.isFrozen(plan) || plan.kind !== 'reviewed-private-test-startup-plan-v1' ||
      plan.planVerifiedReadOnly !== true || plan.deploymentAuthorized !== false ||
      !Array.isArray(ids) || !Object.isFrozen(ids) || ids.length < 1 ||
      plan.primaryHouseholdId !== ids[0] || !PRIMARY.test(ids[0]) ||
      ids[0] === 'family-a' || ids[0] === 'family-b' || FRIEND.test(ids[0]) ||
      new Set(ids).size !== ids.length ||
      ids.slice(1).some(id => typeof id !== 'string' || !FRIEND.test(id)) ||
      !supervisor || typeof supervisor.beginDisposableOfflineCapture !== 'function' ||
      typeof supervisor.completeDisposableOfflineCapture !== 'function' ||
      !Array.isArray(backends) || backends.length !== ids.length ||
      !backendPorts || typeof backendPorts !== 'object' ||
      gatewayClosed !== true || !Object.isFrozen(plan) ||
      Object.keys(backendPorts).length !== ids.length) {
    fail('reviewed household plan, captured backends and closed gateway required.')
  }
  const byId = new Map()
  const allPorts = [safePort(gatewayPort)]
  for (const backend of backends) {
    if (!ids.includes(backend?.householdId) ||
        byId.has(backend.householdId) ||
        !(backend.child instanceof ChildProcess) ||
        !Number.isSafeInteger(backend.child.pid) || backend.child.pid < 1 ||
        (backend.child.exitCode === null && backend.child.signalCode === null)) {
      fail('every expected captured OS child must already have exited.')
    }
    byId.set(backend.householdId, backend)
  }
  for (const id of ids) {
    if (!byId.has(id) || !Object.hasOwn(backendPorts, id)) {
      fail('a planned household process or port is missing.')
    }
    allPorts.push(safePort(backendPorts[id]))
  }
  if (new Set(allPorts).size !== allPorts.length) {
    fail('gateway and backend loopback ports must be distinct.')
  }

  // Never examine arbitrary caller-selected source folders first. Refuse any
  // installed/LIVE/TEST path BEFORE reading a household name or data file.
  if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)) {
    fail('only absolute disposable source folders are permitted.')
  }
  const temp = fs.realpathSync(os.tmpdir())
  const source = fs.realpathSync(sourceRoot)
  const relative = path.relative(temp, source)
  if (!relative || relative === '..' ||
      relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    fail('backup source must be an isolated OS-temp fixture.')
  }

  // This transition atomically protects the supervisor instance lock against
  // its own graceful release during capture. It is NEVER automatically undone
  // after a partial or unverified capture.
  supervisor.beginDisposableOfflineCapture(ids)
  // Reject a backup of another family's data BEFORE any snapshot publication.
  // The capture module validates complete source inventory and OS-temp scope.
  const slugs = fs.readdirSync(path.join(sourceRoot, 'households')).sort()
  if (JSON.stringify(slugs) !== JSON.stringify([...ids].sort())) {
    fail('offline source households differ from supervised household scope.')
  }
  for (const port of allPorts) await requireClosedLoopback(port)
  const captured = captureDisposableCoordinatedHouseholdSnapshot({
    serverDirectory, sourceRoot, destinationRoot,
  })
  // A valid backup of DIFFERENT families must never count as this owner's
  // verified capture. The internal staging folder remains for operator review.
  if (JSON.stringify([...captured.attestation.households].sort()) !==
      JSON.stringify([...ids].sort())) {
    fail('captured household inventory does not match supervised identities.')
  }
  // Detect even a listener that appeared after copying. Remain held on error.
  for (const port of allPorts) await requireClosedLoopback(port)
  supervisor.completeDisposableOfflineCapture()
  return Object.freeze({
    ...captured,
    capturedOsChildrenExited: true,
    nominatedLoopbackPortsClosed: true,
    supervisorInstanceHeldDuringCopy: true,
    allSystemWritersFenced: false,
    productionBackupAuthorized: false,
  })
}
