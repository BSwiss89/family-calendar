import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectPrivatePreviewReleaseFiles } from './check-private-preview-release-scope.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts/check-private-preview-release-scope.mjs')

test('ordinary small frontend, backend, and documentation releases remain eligible', () => {
  assert.deepEqual(inspectPrivatePreviewReleaseFiles([
    'src/App.tsx', 'Server/index.mjs', 'docs/RELEASE_MILESTONES.md',
    'scripts/release.ps1', '.github/workflows/deployment-safety.yml',
  ]), {allowed:true,invalid:[],draftOnly:[]})
  assert.equal(inspectPrivatePreviewReleaseFiles([]).allowed, true)
})

test('entire PR #47 release (including safety tests) remains deployable', () => {
  // This is the actual seven-file release list from the 62e63b3 -> 88c6285
  // guarded preview. The previous denylist wrongly matched its own test file.
  const actualRelease = [
    '.github/workflows/deployment-safety.yml',
    'docs/RELEASE_MILESTONES.md',
    'scripts/check-private-preview-release-scope.mjs',
    'scripts/deploy-backend.ps1',
    'scripts/deploy-frontend.ps1',
    'scripts/release.ps1',
    'scripts/test-private-preview-release-scope.mjs',
  ]
  assert.deepEqual(inspectPrivatePreviewReleaseFiles(actualRelease), {
    allowed: true, invalid: [], draftOnly: [],
  })
  const cli = spawnSync(process.execPath, [script, ...actualRelease], {
    encoding: 'utf8',
  })
  assert.equal(cli.status, 0, cli.stderr)
  assert.match(cli.stdout, /scope check passed/)

  // The exception must never grant a way to include a draft-only module.
  for (const candidate of [
    'scripts/test-private-household-gateway.mjs',
    'scripts/test-private-arney-event-language.mjs',
    'scripts/test-private-preview-release-scope.mjs.additional',
    'Server/private-household-gateway.mjs',
  ]) {
    const denied = inspectPrivatePreviewReleaseFiles([...actualRelease, candidate])
    assert.equal(denied.allowed, false, candidate)
    assert.deepEqual(denied.draftOnly, [candidate])
  }
})

test('PR #46 runtime and household-preview test artifacts cannot be released', () => {
  const paths = [
    'Server/private-household-gateway.mjs',
    'Server/private-arney-event-language.mjs',
    'Server/private-paid-api-budget.mjs',
    'Server/private-offline-restore-rehearsal.mjs',
    'Server/household-storage.mjs',
    'Server/household-memberships.mjs',
    'Server/family-auth.mjs',
    'Server/event-only-shares.mjs',
    'Server/event-share-sync-journal.mjs',
    'Server/event-creator-audit.mjs',
    'Server/auth-ui/login.html',
    'src/FamilyEventSharing.tsx',
    'src/SharedEventsOverlay.css',
    'src/useAuthenticatedCalendarIdentity.ts',
    'src/InvitationCenter.tsx',
    'src/useSharedEventFeed.ts',
    'scripts/test-private-household-gateway.mjs',
    'scripts/test-event-only-shares.mjs',
    'scripts/run-household-browser-demo.mjs',
  ]
  const result = inspectPrivatePreviewReleaseFiles(paths)
  assert.equal(result.allowed, false)
  assert.deepEqual(result.draftOnly, paths)
  assert.deepEqual(result.invalid, [])
  assert.equal(inspectPrivatePreviewReleaseFiles(['src/App.tsx',...paths]).allowed, false)
})

test('noncanonical names and unsupported diff encodings fail closed', () => {
  for (const name of [
    '..', '../Server/private-household-gateway.mjs', '/Server/private-gateway.mjs',
    'Server//private-gateway.mjs', 'Server\\private-gateway.mjs',
    '"Server/private-gateway.mjs"', 'Server/./private-gateway.mjs',
    'Server/private-\nfeature.mjs', '', null, '--help',
  ]) {
    const result = inspectPrivatePreviewReleaseFiles([name])
    assert.equal(result.allowed, false, String(name))
    assert.equal(result.invalid.length, 1)
  }
})

test('CLI denies a mixed release even with ordinary files and accepts safe paths', () => {
  const ok = spawnSync(process.execPath, [script, 'src/App.tsx', 'docs/RELEASE_MILESTONES.md'], {
    encoding: 'utf8',
  })
  assert.equal(ok.status, 0, ok.stderr)
  const blocked = spawnSync(process.execPath, [
    script, 'src/App.tsx', 'Server/household-storage.mjs',
  ], {encoding:'utf8'})
  assert.equal(blocked.status, 2)
  assert.match(blocked.stderr, /BLOCKED/)
  assert.match(blocked.stderr, /household-storage/)
  const invalid = spawnSync(process.execPath,[script,'Server\\private-unsafe.mjs'],{
    encoding:'utf8',
  })
  assert.equal(invalid.status, 2)
})

test('every release entrypoint enforces the gate before approval or backend shutdown', () => {
  for (const file of [
    'scripts/release.ps1', 'scripts/deploy-frontend.ps1',
    'scripts/deploy-backend.ps1',
  ]) {
    const source = readFileSync(path.join(root,file),'utf8')
    assert.match(source,/check-private-preview-release-scope\.mjs/)
    assert.match(source,/PRIVATE MULTI-FAMILY PREVIEW RELEASE BLOCKED/i)
    const guardAt=source.indexOf('check-private-preview-release-scope.mjs')
    const releaseAt=source.indexOf('param([switch]$Apply)')
    if (file.endsWith('release.ps1')) {
      assert.ok(guardAt > source.indexOf('$changed = @(& git'))
      assert.ok(guardAt < source.indexOf('$mode = if'))
    } else if (file.endsWith('deploy-frontend.ps1')) {
      assert.ok(guardAt > source.indexOf('$plan = Get-Plan'))
      assert.ok(guardAt < source.indexOf('$testDist = Join-Path'))
    } else {
      assert.ok(guardAt > source.indexOf('$changed = @(& git'))
      assert.ok(guardAt < source.indexOf("if ($changed -contains 'Server/index.mjs')"))
    }
    assert.ok(releaseAt >= 0)
  }
  const auto=readFileSync(path.join(root,'scripts/auto-release.ps1'),'utf8')
  assert.match(auto,/\$release = Join-Path \$test 'scripts\\release\.ps1'/)
  assert.match(auto,/-File \$release -Apply/)
})
