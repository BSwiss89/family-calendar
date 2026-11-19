import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyReleasePaths } from './check-live-alignment-release-scope.mjs'

test('rejects empty and malformed release scope', () => {
  assert.equal(classifyReleasePaths([]).allowed, false)
  assert.equal(classifyReleasePaths(['../secrets']).allowed, false)
})
test('requires separate approval for sensitive backend and environment changes', () => {
  for (const file of ['Server/index.mjs', 'Server/family-auth.mjs', 'Server/private-household-gateway.mjs', 'Server/auth-ui/account.js', 'src/HouseholdMembersSettings.tsx', '.github/workflows/build.yml', 'scripts/secure-test-auto-deploy.ps1']) {
    assert.equal(classifyReleasePaths([file]).allowed, false, file)
  }
})
test('permits ordinary scope to proceed to independent approval gates', () => {
  assert.equal(classifyReleasePaths(['src/App.css']).allowed, true)
})
