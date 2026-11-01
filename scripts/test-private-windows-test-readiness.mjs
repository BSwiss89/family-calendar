import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assessPrivateTestHostReadiness } from './assess-private-test-host-readiness.mjs'
import { inspectPrivatePreviewReleaseFiles } from './check-private-preview-release-scope.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'scripts/inspect-private-test-host.ps1')
const evaluator = path.join(root, 'scripts/assess-private-test-host-readiness.mjs')
const headA = 'a'.repeat(40)
const headB = 'b'.repeat(40)

function inventory() {
  return {
    schemaVersion: 1, platform: 'win32', distinctCheckouts: true,
    taskEnumerationSucceeded: true,
    checkouts: {
      live: { exists: true, gitRepo: true, trackedAndUntrackedClean: true,
        reparsePoint: false, headSha: headA },
      test: { exists: true, gitRepo: true, trackedAndUntrackedClean: true,
        reparsePoint: false, headSha: headB },
    },
    tasks: [
      { name: 'Family Calendar Secure TEST Auto Deploy',
        enabled: true, restartCount: 0, multipleInstances: 'IgnoreNew',
        triggerCount: 1 },
      { name: 'Family Calendar Server',
        enabled: true, restartCount: 0, multipleInstances: 'IgnoreNew',
        triggerCount: 1 },
    ],
  }
}

test('clean Windows inventory is read-only information, NEVER permission to deploy', () => {
  const result = assessPrivateTestHostReadiness(inventory())
  assert.deepEqual(result.blockers, [])
  assert.equal(result.hostInventoryPassed, true)
  assert.equal(result.inspectedOnly, true)
  assert.equal(result.authorizedToDeployTest, false)
  assert.equal(result.authorizedToDeployLive, false)
  assert.equal(result.authorizedToMergeMain, false)
  assert.equal(result.taskOrServiceInstalledByThisAudit, false)
  assert(result.requiredManualGates.some(s => /backup/i.test(s)))
  assert(result.requiredManualGates.some(s => /HTTPS/i.test(s)))
  assert(result.requiredManualGates.some(s => /process identity/i.test(s)))
})

test('unavailable task inventory, dirty checkout, reparse path and non-Windows host block review', () => {
  const value = inventory()
  value.taskEnumerationSucceeded = false
  value.platform = 'linux'
  value.distinctCheckouts = false
  value.checkouts.test.trackedAndUntrackedClean = false
  value.checkouts.live.reparsePoint = true
  const result = assessPrivateTestHostReadiness(value)
  assert.equal(result.hostInventoryPassed, false)
  assert(result.blockers.length >= 5)
  assert.equal(result.authorizedToDeployTest, false)
})

test('a pre-existing private supervisor and auto-restart policy require explicit manual review', () => {
  const value = inventory()
  value.tasks.push({ name: 'Family Calendar Private Household Supervisor',
    enabled: true, restartCount: 5, multipleInstances: 'Parallel',
    triggerCount: 2 })
  const result = assessPrivateTestHostReadiness(value)
  assert.equal(result.hostInventoryPassed, false)
  assert(result.blockers.some(s => /existing private household supervisor/.test(s)))
  assert(result.blockers.some(s => /unattended restart/.test(s)))
  assert.equal(result.authorizedToDeployTest, false)
})

test('duplicate/invalid task metadata is never accepted silently', () => {
  const value = inventory()
  value.tasks.push({ ...value.tasks[0] })
  value.tasks.push({ name: 'Outside Family', enabled: true, restartCount: -1 })
  const result = assessPrivateTestHostReadiness(value)
  assert(result.blockers.some(s => /Duplicate/.test(s)))
  assert(result.blockers.some(s => /incomplete or unsafe/.test(s)))
  assert.throws(() => assessPrivateTestHostReadiness(null), /versioned/)
  assert.throws(() => assessPrivateTestHostReadiness({ schemaVersion: 99 }), /versioned/)
})

test('evaluator CLI excludes raw inventory values, secrets, paths and task arguments', () => {
  const sample = inventory()
  sample.privateSecret = 'NEVER-ECHO-TOKEN-OR-PASSWORD'
  sample.tasks[0].actionArgs = '--bearer NEVER-ECHO-TOKEN-OR-PASSWORD'
  const p = spawnSync(process.execPath, [evaluator], {
    input: JSON.stringify(sample), encoding: 'utf8', timeout: 5000,
  })
  assert.equal(p.status, 0, p.stderr)
  const response = JSON.parse(p.stdout)
  assert.equal(response.authorizedToDeployTest, false)
  assert(!p.stdout.includes('NEVER-ECHO'))
  assert(!p.stdout.includes('Family Calendar Server'))
  const invalid = spawnSync(process.execPath, [evaluator], {
    input: '{"raw-password":"bad"', encoding: 'utf8', timeout: 5000,
  })
  assert.equal(invalid.status, 2)
  assert(!invalid.stderr.includes('raw-password'))
})

test('PowerShell probe is explicitly read-only and protected from automatic release', () => {
  const ps = readFileSync(source, 'utf8')
  assert.match(ps, /Get-ScheduledTask/)
  assert.match(ps, /git -C \$Directory rev-parse HEAD/)
  assert.match(ps, /git -C \$Directory status --porcelain/)
  assert.match(ps, /assess-private-test-host-readiness\.mjs/)
  // NO task mutation, child execution of arbitrary task actions, filesystem
  // writes, Git pushes/checkouts, Tailscale edits or deployment scripts.
  assert.doesNotMatch(ps, /^\s*(?:New|Register|Unregister|Set|Stop|Start|Disable|Enable|Remove)-ScheduledTask\b/im)
  assert.doesNotMatch(ps, /^\s*(?:Copy|Move|Remove|Set|New)-Item\b/im)
  assert.doesNotMatch(ps, /\bgit\s+(?:pull|push|fetch|checkout|reset|clean|switch)\b/i)
  assert.doesNotMatch(ps, /\btailscale\s+(?:serve|funnel|up|down)\b/i)
  for (const filepath of ['scripts/assess-private-test-host-readiness.mjs',
    'scripts/inspect-private-test-host.ps1']) {
    assert.deepEqual(inspectPrivatePreviewReleaseFiles([filepath]).draftOnly,
      [filepath], 'New private inspection scripts must stay behind release denylist')
  }
})

test('Windows PowerShell syntax validates without executing the host inspector', {
  skip: process.platform !== 'win32',
}, () => {
  // Parse only: never run the task inventory script during CI.
  const arg = '$e=$null; $tokens=$null; [System.Management.Automation.Language.Parser]::ParseFile(' +
    '"' + source.replaceAll('\\', '\\\\') + '", [ref]$tokens, [ref]$e) > $null; ' +
    'if ($e.Count -gt 0) { $e | Out-String | Write-Error; exit 1 }'
  const p = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', arg], {
    encoding: 'utf8', timeout: 15000,
  })
  assert.equal(p.status, 0, p.stderr)
})
