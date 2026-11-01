// Every fixture is synthetic; do not inspect LIVE/TEST in GitHub Actions.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assessOneFamilyTestPilotReadiness } from './assess-private-one-family-test-pilot.mjs'
import { INSPECTED_CALENDAR_PORTS } from './assess-private-windows-port-owners.mjs'
import { inspectPrivatePreviewReleaseFiles } from './check-private-preview-release-scope.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha = 'a'.repeat(40)
const checkout = (head) => ({
  exists: true, gitRepo: true, trackedAndUntrackedClean: true,
  reparsePoint: false, headSha: head,
})
const task = (name, enabled = true, restartCount = 0) => ({
  name, enabled, restartCount, multipleInstances: 'IgnoreNew', triggerCount: 1,
})
function fixture() {
  return {
    schemaVersion: 1,
    mode: 'existing-test-single-household',
    candidateCommitSha: sha,
    hostInventory: {
      schemaVersion: 1, platform: 'win32', distinctCheckouts: true,
      taskEnumerationSucceeded: true,
      checkouts: { live: checkout('b'.repeat(40)),
        test: checkout('c'.repeat(40)) },
      tasks: [
        task('Family Calendar Server', true, 3),
        task('Family Calendar Secure TEST', true, 3),
        task('Family Calendar Secure TEST Auto Deploy'),
        task('Family Calendar Watchdog'),
        task('Family Calendar Auto Deploy', false),
      ],
    },
    portInventory: {
      schemaVersion: 1, platform: 'win32',
      listenerEnumerationSucceeded: true,
      inspectedPorts: [...INSPECTED_CALENDAR_PORTS],
      listeners: [
        { port: 3001, pid: 4200, processName: 'node', processReadable: true,
          bindClass: 'loopback' },
        { port: 13002, pid: 4400, processName: 'node', processReadable: true,
          bindClass: 'external' },
      ],
    },
  }
}

test('one-family legacy TEST inspection passes observation only; NEVER deploy clearance', () => {
  const result = assessOneFamilyTestPilotReadiness(fixture())
  assert.equal(result.hostInventoryPassed, true)
  assert.equal(result.inspectedOnly, true)
  assert.equal(result.mode, 'existing-test-single-household')
  assert.equal(result.protectedListenersObserved, 2)
  assert.equal(result.hostBlockers.length, 0)
  assert.equal(result.networkReviewRequired, true)
  assert.equal(result.allowedToChangeTest, false)
  assert.equal(result.allowedToChangeLive, false)
  assert.equal(result.allowedToChangeMain, false)
  assert.equal(result.realBackupVerified, false)
  assert.equal(result.isolatedRestoreVerified, false)
  assert.equal(result.rollbackVerified, false)
  assert.equal(result.ownerAccountVerified, false)
  assert.equal(result.osWideWriterFencingVerified, false)
  assert.equal(result.tasksOrFilesModified, false)
  assert(result.requiredBeforeTestCutover.some(x => /authentication/i.test(x)))
  assert(result.requiredBeforeTestCutover.some(x => /backup/i.test(x)))
  assert(result.requiredBeforeTestCutover.some(x => /rollback/i.test(x)))
  assert(result.warnings.some(x => /listener/i.test(x)))
})

test('missing or disabled scheduled tasks block any single-household rollout', () => {
  for (const missing of ['Family Calendar Server',
    'Family Calendar Secure TEST', 'Family Calendar Watchdog',
    'Family Calendar Secure TEST Auto Deploy']) {
    const input = fixture()
    input.hostInventory.tasks =
      input.hostInventory.tasks.filter(x => x.name !== missing)
    const result = assessOneFamilyTestPilotReadiness(input)
    assert(result.hostBlockers.some(x => x.includes(missing)))
    assert.equal(result.allowedToChangeTest, false)
  }
  const input = fixture()
  input.hostInventory.tasks.find(x => x.name === 'Family Calendar Secure TEST')
    .enabled = false
  assert(assessOneFamilyTestPilotReadiness(input).hostBlockers
    .some(x => /Secure TEST/.test(x)))
})

test('LIVE auto-deployer unexpectedly enabled blocks TEST pilot preparation', () => {
  const input = fixture()
  input.hostInventory.tasks.find(x => x.name === 'Family Calendar Auto Deploy')
    .enabled = true
  const result = assessOneFamilyTestPilotReadiness(input)
  assert(result.hostBlockers.some(x => /LIVE auto-deployer/.test(x)))
})

test('unavailable host or listener ownership never claims a safe cutover', () => {
  const input = fixture()
  input.hostInventory.taskEnumerationSucceeded = false
  input.hostInventory.checkouts.test.trackedAndUntrackedClean = false
  input.portInventory.listenerEnumerationSucceeded = false
  const result = assessOneFamilyTestPilotReadiness(input)
  assert.equal(result.hostInventoryPassed, false)
  assert(result.hostBlockers.length > 0)
  assert(result.warnings.some(x => /listener/i.test(x)))
  assert.equal(result.allowedToChangeTest, false)
})

test('malformed mode, SHA, missing metadata and hostile input are rejected', () => {
  for (const wrong of [
    null, [], {}, { ...fixture(), schemaVersion: 2 },
    { ...fixture(), mode: 'private-multifamily-gateway' },
    { ...fixture(), candidateCommitSha: 'deadbeef' },
    { ...fixture(), hostInventory: null },
    { ...fixture(), portInventory: null },
  ]) {
    assert.throws(() => assessOneFamilyTestPilotReadiness(wrong),
      /preflight rejected/)
  }
})

test('CLI does not leak secrets, snapshot values or raw error detail', () => {
  const filename = path.join(root, 'scripts/assess-private-one-family-test-pilot.mjs')
  const input = fixture()
  input.password = 'NEVER-PRINT-SECRET'
  const safe = spawnSync(process.execPath, [filename], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 8000,
  })
  assert.equal(safe.status, 0, safe.stderr)
  assert.equal(JSON.parse(safe.stdout).allowedToChangeTest, false)
  assert(!safe.stdout.includes('NEVER-PRINT-SECRET'))
  const invalid = spawnSync(process.execPath, [filename], {
    input: '{"private-password":"NEVER-PRINT-SECRET"',
    encoding: 'utf8', timeout: 8000,
  })
  assert.equal(invalid.status, 2)
  assert(!invalid.stderr.includes('NEVER-PRINT-SECRET'))
})

test('one-command PowerShell only reads existing inventories and pinned Git HEAD', () => {
  const filename = path.join(root, 'scripts/inspect-private-one-family-test-pilot.ps1')
  const ps = fs.readFileSync(filename, 'utf8')
  for (const required of ['ExpectedCommitSha', 'inspect-private-test-host.ps1',
    'inspect-private-windows-port-owners.ps1',
    'assess-private-one-family-test-pilot.mjs', 'rev-parse HEAD']) {
    assert(ps.includes(required), 'Missing one-family preflight guard: ' + required)
  }
  assert.doesNotMatch(ps,
    /\b(?:Start|Stop|Register|Unregister|Disable|Enable|Set|New)-ScheduledTask\b/i)
  assert.doesNotMatch(ps, /\b(?:Copy|Remove|Move|New|Set)-Item\b/i)
  // Inspect executable lines only: explanatory comments may say 'Git checkout'.
  const operations = ps.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
  assert.doesNotMatch(operations, /\bgit\s+(?:checkout|pull|fetch|push|reset|clean|switch)\b/i)
  assert.doesNotMatch(ps, /\b(?:tailscale\s+(?:serve|funnel)|sqlite3|Set-NetTCPConnection)\b/i)
  for (const path of [
    'scripts/inspect-private-one-family-test-pilot.ps1',
    'scripts/assess-private-one-family-test-pilot.mjs',
    'scripts/test-private-one-family-test-pilot.mjs',
  ]) {
    assert.deepEqual(inspectPrivatePreviewReleaseFiles([path]).draftOnly, [path])
  }
})

test('Windows runner parses PowerShell without executing the laptop inspector', {
  skip: process.platform !== 'win32',
}, () => {
  const source = path.join(root, 'scripts/inspect-private-one-family-test-pilot.ps1')
  const arg = '$err=$null; $t=$null; ' +
    '[System.Management.Automation.Language.Parser]::ParseFile(' +
    '"' + source.replaceAll('\\', '\\\\') +
    '", [ref]$t, [ref]$err) > $null; ' +
    'if ($err.Count) { $err | Out-String | Write-Error; exit 1 }'
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive',
    '-Command', arg], { encoding: 'utf8', timeout: 20000 })
  assert.equal(result.status, 0, result.stderr)
})
