import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const chores = readFileSync(new URL('../src/VerifiedFamilyChores.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../Server/private-family-task-routes.mjs', import.meta.url), 'utf8')
const gateway = readFileSync(new URL('../Server/private-household-gateway.mjs', import.meta.url), 'utf8')
const legacy = readFileSync(new URL('../Server/index.mjs', import.meta.url), 'utf8')

test('existing LIVE and TEST retain a disabled Chores sidebar without server opt-in', () => {
  assert.match(app, /useVerifiedChoresCapability\(familyAuthEnabled\)/)
  assert.match(app, /disabled=\{!choresCapability\}/)
  assert.match(app, /page === 'chores' && choresCapability && \(/)
  assert.match(app, /<VerifiedFamilyChores capability=\{choresCapability\} people=\{people\} \/>/)
  assert.match(app, /\.\.\.\(choresCapability \? \[\{ id: 'chores'/)
  assert.doesNotMatch(legacy, /installPrivateFamilyTaskRoutes/)
  assert.doesNotMatch(legacy, /createFamilyAssignedTaskTables/)
})

test('capability is server-owned and private gateway task API is disabled by default', () => {
  assert.match(gateway, /enableVerifiedTaskApi = false/)
  assert.match(gateway, /enableVerifiedTaskApi && !enforceFamilyMemberPermissions/)
  assert.match(gateway, /if \(enableVerifiedTaskApi\) \{\s*installPrivateFamilyTaskRoutes/)
  assert.match(api, /originalUrl === ROOT \+ '\/capability' && method === 'GET'/)
  assert.match(api, /getVerifiedFamilyMemberAuthorization\(identityDatabase/)
  assert.match(api, /canFamilyMemberAct\(actor, 'tasks\.view'\)/)
  assert.match(api, /canCompleteOwn: canFamilyMemberAct\(actor, 'tasks\.completeAssigned'/)
})

test('Chores UI does not use a selected avatar, local role or household claim as action authority', () => {
  assert.match(chores, /fetch\(BASE \+ '\/capability'/)
  assert.match(chores, /credentials: 'same-origin', cache: 'no-store'/)
  assert.match(chores, /capability\.canManage && \(/)
  assert.match(chores, /task\.assignedPersonId === capability\.linkedPersonId/)
  assert.match(chores, /const canComplete = own && capability\.canCompleteOwn/)
  assert.match(chores, /body: '\{\}'/)
  assert.doesNotMatch(chores, /localStorage|sessionStorage|selectedProfile/)
  assert.doesNotMatch(chores, /body: JSON\.stringify\(\{[^}]*actor/)
})
