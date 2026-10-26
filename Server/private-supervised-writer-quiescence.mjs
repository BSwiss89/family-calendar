// TEST-FIXTURE SUPERVISION ONLY. No production/family database recovery.
// This checks exact child-process handles captured by the disposable launcher
// plus the disappearance of all three expected loopback listeners. It is NOT
// OS-wide writer fencing, a SQLite lock verifier or permission to clear locks.
import { ChildProcess } from 'node:child_process'
import net from 'node:net'

const HOUSEHOLDS = ['family-a', 'family-b']
const RESERVED = new Set([3001, 13001, 13002, 13003, 11434, 443, 8443])
function checkedPort(port) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 ||
      RESERVED.has(port)) {
    throw new Error('Disposable writer quiescence requires safe private loopback ports.')
  }
  return port
}

async function refusesTcpConnections(port) {
  return await new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    let done = false
    function finish(error, closed) {
      if (done) return
      done = true
      socket.destroy()
      if (error) reject(error)
      else resolve(closed)
    }
    socket.once('connect', () => finish(null, false))
    socket.once('error', error => {
      if (error?.code === 'ECONNREFUSED') return finish(null, true)
      finish(new Error('Unable to establish whether disposable port is closed.'))
    })
    socket.setTimeout(1200, () =>
      finish(new Error('Disposable port probe timed out; quiescence unproven.')))
  })
}

export async function assertDisposableSupervisedWritersStopped({
  backends, backendPorts, gatewayPort, gatewayClosed,
  // Optional for the disposable three-family enrollment fixture only.
  expectedHouseholdIds = HOUSEHOLDS,
}) {
  if (gatewayClosed !== true || !Array.isArray(backends) ||
      !Array.isArray(expectedHouseholdIds) || expectedHouseholdIds.length < 2 ||
      !HOUSEHOLDS.every(id => expectedHouseholdIds.includes(id)) ||
      expectedHouseholdIds.some(id => typeof id !== 'string' ||
        !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(id)) ||
      new Set(expectedHouseholdIds).size !== expectedHouseholdIds.length ||
      backends.length !== expectedHouseholdIds.length ||
      !backendPorts || typeof backendPorts !== 'object' ||
      Object.keys(backendPorts).length !== expectedHouseholdIds.length) {
    throw new Error('Disposable writer quiescence needs a closed gateway and exactly two supervised household backends by default, or every explicitly expected backend.')
  }
  const seen = new Set()
  const ports = [checkedPort(gatewayPort)]
  for (const backend of backends) {
    if (!expectedHouseholdIds.includes(backend?.householdId) ||
        seen.has(backend.householdId) ||
        !(backend.child instanceof ChildProcess) ||
        !Number.isSafeInteger(backend.child.pid) || backend.child.pid < 1) {
      throw new Error('Missing, duplicate or untrusted supervised backend child handle.')
    }
    seen.add(backend.householdId)
    if (backend.child.exitCode === null && backend.child.signalCode === null) {
      throw new Error('Supervised backend process has not exited: ' + backend.householdId)
    }
    ports.push(checkedPort(backendPorts[backend.householdId]))
  }
  if (!expectedHouseholdIds.every(id => seen.has(id)) ||
      new Set(ports).size !== ports.length) {
    throw new Error('Expected private household writer ports were not uniquely accounted for.')
  }
  for (const port of ports) {
    if (!(await refusesTcpConnections(port))) {
      throw new Error('Private service still accepts connections on loopback port ' + port)
    }
  }
  // Never return a clearance to remove an abandoned gateway writer lock.
  return { supervisedChildrenExited: true, loopbackListenersClosed: true,
    recoveryApproved: false, allSystemWritersFenced: false }
}
