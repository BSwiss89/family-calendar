// READ-ONLY Windows network-listener inventory review for future household TEST.
// Takes only a sanitized synthetic or operator-supplied inventory. This is
// NOT proof of OS-wide writer fencing, process identity, HTTPS security,
// or authority to change any running calendar service.
import { pathToFileURL } from 'node:url'

export const INSPECTED_CALENDAR_PORTS = Object.freeze([
  443, 8443, 3001, 11434, 13001, 13002, 13003,
])
const PORT_SET = new Set(INSPECTED_CALENDAR_PORTS)
const PRIVATE_HTTP = new Set([3001, 11434, 13001, 13002, 13003])
const BIND_CLASS = new Set(['loopback', 'wildcard', 'external', 'unknown'])
const PROCESS = /^[a-zA-Z0-9_.-]{1,100}$/

function reject(message) {
  throw new Error('Windows listener audit refused: ' + message)
}

export function assessPrivateWindowsPortOwners(inventory) {
  if (!inventory || typeof inventory !== 'object' ||
      Array.isArray(inventory) || inventory.schemaVersion !== 1) {
    reject('a versioned sanitized host inventory is required.')
  }
  const blockers = []
  const warnings = []
  if (inventory.platform !== 'win32') {
    blockers.push('Windows platform identity was not established.')
  }
  if (inventory.listenerEnumerationSucceeded !== true ||
      !Array.isArray(inventory.listeners)) {
    blockers.push('Listening socket enumeration is unavailable.')
  }
  if (!Array.isArray(inventory.inspectedPorts) ||
      inventory.inspectedPorts.length !== PORT_SET.size ||
      new Set(inventory.inspectedPorts).size !== PORT_SET.size ||
      inventory.inspectedPorts.some(p => !PORT_SET.has(p))) {
    blockers.push('The expected protected port inventory is incomplete.')
  }

  const listeners = Array.isArray(inventory.listeners) ? inventory.listeners : []
  if (listeners.length > 256) reject('too many network listener records.')
  const seen = new Set()
  const owners = new Map()
  for (const l of listeners) {
    if (!l || typeof l !== 'object' || Array.isArray(l) ||
        !PORT_SET.has(l.port) ||
        !Number.isSafeInteger(l.pid) || l.pid < 0 ||
        !BIND_CLASS.has(l.bindClass) ||
        typeof l.processReadable !== 'boolean' ||
        (l.processReadable === true && !PROCESS.test(l.processName)) ||
        (l.processReadable === false && l.processName !== null)) {
      blockers.push('At least one protected port has invalid ownership metadata.')
      continue
    }
    const key = l.port + ':' + l.pid + ':' + l.bindClass
    if (seen.has(key)) {
      // IPv4 + IPv6 may legitimately produce several records for an owner.
      warnings.push('Duplicate sanitized listener record needs operator review.')
    }
    seen.add(key)
    if (!owners.has(l.port)) owners.set(l.port, new Set())
    owners.get(l.port).add(l.pid)

    if (!l.processReadable || l.pid === 0 || l.bindClass === 'unknown') {
      blockers.push('Process identity or binding for port ' + l.port + ' is unverified.')
    }
    if (PRIVATE_HTTP.has(l.port) && l.bindClass !== 'loopback') {
      blockers.push('Private HTTP port ' + l.port + ' is not verified as loopback-only.')
    }
    if (!PRIVATE_HTTP.has(l.port) && l.bindClass !== 'loopback') {
      warnings.push('HTTPS listener on port ' + l.port + ' requires routing and TLS review.')
    }
  }
  for (const [port, pids] of owners) {
    if (pids.size > 1) {
      blockers.push('Multiple owner PIDs were observed on port ' + port + '; inspect before routing.')
    }
  }
  // A snapshot of listener/PID metadata cannot distinguish a real executable
  // from another process with the same name, nor rule out a hidden SQLite writer.
  const requiredManualGates = [
    'Verify actual pinned executable identity and Windows task actions offline',
    'Verify gateway ownership and both HTTPS/Tailscale routes without changing them',
    'Check all active SQLite file handles and independent writer locks',
    'Demonstrate protected central and household backup, restore, and rollback',
    'Separate explicit approval for any future TEST-only startup or cutover',
  ]
  return {
    schemaVersion: 1,
    inspectedOnly: true,
    observedListeners: listeners.length,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    requiredManualGates,
    osWideWriterOwnershipVerified: false,
    gatewayBindingVerified: false,
    safeToStartSupervisor: false,
    authorizedToDeployTest: false,
    authorizedToDeployLive: false,
    authorizedToMergeMain: false,
    taskOrServiceChanged: false,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks = []
  let count = 0
  try {
    for await (const chunk of process.stdin) {
      count += chunk.length
      if (count > 32768) reject('sanitized input exceeded size limit.')
      chunks.push(chunk)
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    process.stdout.write(JSON.stringify(assessPrivateWindowsPortOwners(input), null, 2) + '\n')
  } catch {
    // Never echo potentially sensitive input.
    process.stderr.write('Read-only listener inventory rejected; no services changed.\n')
    process.exitCode = 2
  }
}
