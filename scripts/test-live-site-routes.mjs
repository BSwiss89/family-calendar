import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { familySiteRoutes } from '../src/familySiteRoutes.ts'

test('LIVE production adapter preserves every exact protected API route', () => {
  assert.deepEqual({ ...familySiteRoutes }, {
    assignmentInbox: '/api/live-notification-pilot',
    assignmentRefresh: '/live-notification-pilot/refresh',
    eventInvitations: '/api/live-event-invitations',
    householdJoin: '/api/live-household-events',
    push: '/api/live-push',
  })
  assert.equal(Object.isFrozen(familySiteRoutes), true)
  assert.ok(Object.values(familySiteRoutes).every(route => route.startsWith('/') && !route.includes('/test-')))
})

test('shared components import the adapter rather than guessing environment URLs', () => {
  for (const path of [
    'src/FamilyPushNotifications.tsx',
    'src/useAssignmentInbox.ts',
    'src/useFamilyEventInvitations.ts',
    'src/HouseholdEventJoin.tsx',
  ]) {
    const content = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
    assert.match(content, /from ['"]\.\/familySiteRoutes['"]/, path)
    assert.match(content, /familySiteRoutes\./, path)
    assert.doesNotMatch(content, /\/api\/(?:live|test)-|\/(?:live|test)-notification-pilot/, path)
  }
})

test('the LIVE route adapter keeps original endpoint suffixes and methods separate', () => {
  assert.equal(familySiteRoutes.push + '/config', '/api/live-push/config')
  assert.equal(familySiteRoutes.push + '/status', '/api/live-push/status')
  assert.equal(familySiteRoutes.push + '/subscriptions', '/api/live-push/subscriptions')
  assert.equal(familySiteRoutes.assignmentInbox + '/12/acknowledge', '/api/live-notification-pilot/12/acknowledge')
  assert.equal(familySiteRoutes.eventInvitations + '/34/respond', '/api/live-event-invitations/34/respond')
  assert.equal(familySiteRoutes.householdJoin + '/join-capability', '/api/live-household-events/join-capability')
  assert.equal(familySiteRoutes.householdJoin + '/56/join', '/api/live-household-events/56/join')
  assert.equal(familySiteRoutes.assignmentRefresh, '/live-notification-pilot/refresh')
})
