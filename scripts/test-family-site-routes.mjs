import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { familySiteRoutes } from '../src/familySiteRoutes.ts'

test('TEST route adapter preserves existing exact, isolated, fail-closed API paths', () => {
  assert.deepEqual({ ...familySiteRoutes }, {
    assignmentInbox: '/api/test-notification-pilot',
    assignmentRefresh: '/test-notification-pilot/refresh',
    eventInvitations: '/api/test-event-invitations',
    householdJoin: '/api/test-household-events',
    push: '/api/test-push',
  })
  assert.equal(Object.isFrozen(familySiteRoutes), true)
  assert.ok(Object.values(familySiteRoutes).every(x => x.startsWith('/') && !x.includes('/live-')))
})

test('shared React components import site adapter rather than hardcoded LIVE/TEST routes', () => {
  const paths = [
    'src/FamilyPushNotifications.tsx',
    'src/useAssignmentInbox.ts',
    'src/useFamilyEventInvitations.ts',
    'src/HouseholdEventJoin.tsx',
  ]
  for (const path of paths) {
    const content = fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8')
    assert.match(content, /from ['"]\.\/familySiteRoutes['"]/, path)
    assert.match(content, /familySiteRoutes\./, path)
    assert.doesNotMatch(content, /\/api\/(?:live|test)-|\/(?:live|test)-notification-pilot/, path)
  }
})

test('site URL suffixes remain exactly what the currently deployed TEST routes expect', () => {
  assert.equal(familySiteRoutes.push + '/config', '/api/test-push/config')
  assert.equal(familySiteRoutes.push + '/status', '/api/test-push/status')
  assert.equal(familySiteRoutes.push + '/subscriptions', '/api/test-push/subscriptions')
  assert.equal(familySiteRoutes.assignmentInbox + '/12/acknowledge', '/api/test-notification-pilot/12/acknowledge')
  assert.equal(familySiteRoutes.eventInvitations + '/34/respond', '/api/test-event-invitations/34/respond')
  assert.equal(familySiteRoutes.householdJoin + '/join-capability', '/api/test-household-events/join-capability')
  assert.equal(familySiteRoutes.householdJoin + '/56/join', '/api/test-household-events/56/join')
})
