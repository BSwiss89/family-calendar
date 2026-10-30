// All inputs synthetic; never enumerate the Windows host in GitHub CI.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assessPrivateWindowsPortOwners, INSPECTED_CALENDAR_PORTS,
} from './assess-private-windows-port-owners.mjs'

function fixture(listeners = []) {
  return {
    schemaVersion: 1,
    platform: 'win32',
    listenerEnumerationSucceeded: true,
    inspectedPorts: [...INSPECTED_CALENDAR_PORTS],
    listeners,
  }
}
const listener = (port, bindClass = 'loopback', pid = 1234) => ({
  port, bindClass, pid, processName: 'node', processReadable: true,
})

test('fully observed loopback ports remain inspection-only, never authorization', () => {
  const result = assessPrivateWindowsPortOwners(fixture([
    listener(3001), listener(13002, 'loopback', 2345),
    listener(11434, 'loopback', 3456),
  ]))
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.inspectedOnly, true)
  assert.deepEqual(result.blockers, [])
  assert.equal(result.observedListeners, 3)
  assert.equal(result.osWideWriterOwnershipVerified, false)
  assert.equal(result.gatewayBindingVerified, false)
  assert.equal(result.safeToStartSupervisor, false)
  assert.equal(result.authorizedToDeployTest, false)
  assert.equal(result.authorizedToDeployLive, false)
  assert.equal(result.authorizedToMergeMain, false)
  assert.equal(result.taskOrServiceChanged, false)
  assert(result.requiredManualGates.length >= 4)
})

test('wildcard or external private HTTP listener blocks the readiness review', () => {
  for (const bind of ['wildcard', 'external']) {
    const result = assessPrivateWindowsPortOwners(fixture([
      listener(3001, bind),
      listener(13003, bind, 2002),
    ]))
    assert(result.blockers.some(x => x.includes('3001') && x.includes('loopback')))
    assert(result.blockers.some(x => x.includes('13003') && x.includes('loopback')))
    assert.equal(result.safeToStartSupervisor, false)
  }
})

test('exposed HTTPS listener requests TLS review but never certifies routing', () => {
  const result = assessPrivateWindowsPortOwners(fixture([
    listener(443, 'external', 2000),
    listener(8443, 'wildcard', 3000),
  ]))
  assert.deepEqual(result.blockers, [])
  assert(result.warnings.some(x => x.includes('443')))
  assert(result.warnings.some(x => x.includes('8443')))
  assert.equal(result.gatewayBindingVerified, false)
})

test('unavailable Windows socket enumeration fails closed', () => {
  const result = assessPrivateWindowsPortOwners({
    ...fixture(), listenerEnumerationSucceeded: false,
  })
  assert(result.blockers.some(x => x.includes('unavailable')))
  assert.equal(result.authorizedToDeployTest, false)
})

test('unknown PID ownership and unknown bind address fail closed', () => {
  const result = assessPrivateWindowsPortOwners(fixture([
    { port: 3001, pid: 999, bindClass: 'unknown',
      processReadable: false, processName: null },
  ]))
  assert(result.blockers.some(x => x.includes('unverified')))
  assert(result.blockers.some(x => x.includes('loopback')))
})

test('two process owners on one protected port are flagged for manual review', () => {
  const result = assessPrivateWindowsPortOwners(fixture([
    listener(13002, 'loopback', 700),
    listener(13002, 'loopback', 701),
  ]))
  assert(result.blockers.some(x => x.includes('Multiple owner PIDs')))
})

test('duplicated metadata generates a warning, never an automatic clearance', () => {
  const result = assessPrivateWindowsPortOwners(fixture([
    listener(3001), listener(3001),
  ]))
  assert(result.warnings.some(x => x.includes('Duplicate')))
  assert.equal(result.authorizedToDeployTest, false)
})

test('missing, extra, or duplicated protected port scope cannot pass inspection', () => {
  for (const ports of [
    [443, 8443, 3001],
    [...INSPECTED_CALENDAR_PORTS, 4444],
    [...INSPECTED_CALENDAR_PORTS.slice(0, -1), 443],
  ]) {
    const result = assessPrivateWindowsPortOwners({
      ...fixture(), inspectedPorts: ports,
    })
    assert(result.blockers.some(x => x.includes('incomplete')))
  }
})

test('unrecognized listener ports and command-injection process names are rejected', () => {
  const badPort = assessPrivateWindowsPortOwners(fixture([
    listener(9000),
  ]))
  assert(badPort.blockers.some(x => x.includes('invalid ownership')))
  const name = assessPrivateWindowsPortOwners(fixture([{
    ...listener(3001), processName: 'node -e "not safe"',
  }]))
  assert(name.blockers.some(x => x.includes('invalid ownership')))
})

test('unsupported platform and malformed inventory do not claim host readiness', () => {
  assert.throws(() => assessPrivateWindowsPortOwners(null), /versioned/)
  assert.throws(() => assessPrivateWindowsPortOwners([]), /versioned/)
  assert.throws(() => assessPrivateWindowsPortOwners({
    ...fixture(), schemaVersion: 10,
  }), /versioned/)
  const linux = assessPrivateWindowsPortOwners({
    ...fixture(), platform: 'linux',
  })
  assert(linux.blockers.some(x => x.includes('Windows platform identity')))
})

test('oversized listener records are refused, rather than printed or processed', () => {
  const lots = Array.from({ length: 257 }, () => listener(3001))
  assert.throws(() => assessPrivateWindowsPortOwners(fixture(lots)), /too many/)
})
