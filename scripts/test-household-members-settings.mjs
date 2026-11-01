// Structural guard for the one-objective settings PR. API permissions are
// verified by the existing two-household HTTP integration suite; this checks
// that the frontend never silently routes through a different household.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const source = readFileSync(fileURLToPath(new URL('../src/HouseholdMembersSettings.tsx', import.meta.url)), 'utf8')
const app = readFileSync(fileURLToPath(new URL('../src/App.tsx', import.meta.url)), 'utf8')

test('Household & Members is a Settings destination with mobile home shortcut', () => {
  assert.match(app, /import HouseholdMembersSettings from '\.\/HouseholdMembersSettings'/)
  assert.match(app, /page === 'householdMembers' && <HouseholdMembersSettings/)
  assert.match(app, /home-mobile-settings-button/)
  assert.match(app, /mobile-settings-panel/)
  assert.match(app, /Household &amp; Members/)
  assert.match(app, /setPage\('householdMembers'\)/)
})

test('owner-only member list, one-use invitation and revocation endpoints are authenticated', () => {
  for (const route of [
    "'/api/households'",
    "'/api/households/members'",
    "'/api/households/member-invitations'",
    "'/api/households/member-invitations/'",
    "'/api/households/members/'",
  ]) assert.ok(source.includes(route), 'Missing owner-scoped endpoint: ' + route)
  assert.match(source, /credentials: 'same-origin'/)
  assert.match(source, /cache: 'no-store'/)
  assert.match(source, /selected\.role === 'owner'/)
  assert.match(source, /household\.role === 'owner'/)
  assert.match(source, /member\.role === 'member'/)
  assert.match(source, /window\.confirm\(/)
  assert.match(source, /status === 403/)
  assert.match(source, /status === 404/)
})

test('bearer invitation is shown only once, on HTTPS and in the current origin fragment', () => {
  assert.match(source, /generatedLink/)
  assert.match(source, /new URL\('\/join#token=' \+ invite\.token, window\.location\.origin\)/)
  assert.match(source, /\^\[a-f0-9\]\{64\}\$/)
  assert.match(source, /navigator\.clipboard\.writeText/)
  assert.match(source, /setGeneratedLink\(''\)/)
  assert.match(source, /location\.protocol !== 'https:'/)
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.log/)
})

test('does not expose privileged invitation actions to normal members', () => {
  assert.match(source, /household\.role === 'owner' \? \(/)
  assert.match(source, /household owner manages invitations and member access/)
  assert.match(source, /setMembers\(\[\]\)/)
  assert.match(source, /setInvitations\(\[\]\)/)
})

test('connected families are read-only and distinct from household member invites', () => {
  assert.match(source, /parseTrustedShareRecipients/)
  assert.match(source, /'\/api\/shared-events\/recipients'/)
  assert.match(source, /setConnectionsAvailable\(false\)/)
  assert.match(source, /Connected families/)
  assert.match(source, /family\.displayName/)
  assert.match(source, /an invitation to join your household is different/i)
  assert.doesNotMatch(source, /api\/households\/connections\/create/)
})
