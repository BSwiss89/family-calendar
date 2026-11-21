import test from 'node:test'
import assert from 'node:assert/strict'
import {
  declaredTestApiRoutes, summarizeTestApiRouteAudit, representativeApiPath,
} from './audit-test-family-route-coverage.mjs'
import { requiredFamilyMemberActions } from '../Server/family-member-route-enforcement.mjs'

test('TEST route audit covers existing event, list, notes, marker and voice declarations', () => {
  const routes = declaredTestApiRoutes()
  const find = (method, template) => routes.find(row =>
    row.method === method && row.template === template)
  for (const [method, template, permission] of [
    ['GET', '/api/events', 'calendar.view'],
    ['POST', '/api/events', 'events.create'],
    ['POST', '/api/ai/reschedule-criteria', 'calendar.view'],
    ['POST', '/api/ai/reschedule-preview', 'calendar.view'],
    ['POST', '/api/ai/cancel-criteria', 'calendar.view'],
    ['POST', '/api/ai/cancel-preview', 'calendar.view'],
    ['POST', '/api/ai/cancel-matches', 'calendar.view'],
    ['POST', '/api/ai/reschedule-confirmed', 'events.edit'],
    ['POST', '/api/ai/cancel-confirmed', 'events.delete'],
    ['POST', '/api/events/:id/exceptions', 'events.delete'],
    ['DELETE', '/api/events/:id/exceptions/:occurrenceDate', 'events.edit'],
    ['DELETE', '/api/event-batches/:batchId', 'events.delete'],
    ['GET', '/api/lists', 'lists.view'],
    ['POST', '/api/lists/:id/items', 'lists.edit'],
    ['GET', '/api/emoji-markers', 'calendar.view'],
    ['POST', '/api/emoji-markers', 'events.create'],
    ['PUT', '/api/emoji-markers/:id', 'events.edit'],
    ['DELETE', '/api/emoji-markers/:id', 'events.delete'],
    ['GET', '/api/family-daily-note', 'calendar.view'],
    ['PUT', '/api/family-daily-note', 'events.edit'],
    ['GET', '/api/arney/local-transcription/status', 'calendar.view'],
    ['POST', '/api/arney/local-transcription', 'calendar.view'],
  ]) {
    const route = find(method, template)
    assert.ok(route, method + ' ' + template + ' must be inventoried')
    assert.equal(route.status, 'REVIEWED_CLASSIFIED', method + ' ' + template)
    assert.ok(route.actions.includes(permission), method + ' ' + template)
  }
  assert.equal(representativeApiPath('/api/daily-notes/:date'),
    '/api/daily-notes/2026-11-20')
})

test('legacy selected-avatar TEST notifications, push subscriptions and event join remain blocked', () => {
  const report = summarizeTestApiRouteAudit()
  assert.equal(report.scope, 'static-literal-API-declarations-only')
  assert.ok(report.declared >= 50, 'missing most TEST API route modules')
  assert.ok(report.reviewed >= 25, 'known safe routes were not discovered')
  assert.ok(report.unreviewed > 0, 'audit must disclose unfinished family route review')
  const unknown = new Set(report.unreviewedRoutes.map(x => x.method + ' ' + x.template))
  for (const endpoint of [
    'GET /api/test-event-invitations',
    'POST /api/test-event-invitations/:id/respond',
    'POST /api/test-household-events/:eventId/join',
    'POST /api/test-household-events/:eventId/leave',
    'POST /api/test-push/subscriptions',
    'POST /api/test-notification-pilot/:notificationId/acknowledge',
  ]) assert.ok(unknown.has(endpoint), endpoint + ' cannot be silently allowed')
  assert.deepEqual(requiredFamilyMemberActions('POST', '/api/ai/cancel-confirmed'),
    ['events.edit', 'events.delete'])
  assert.equal(requiredFamilyMemberActions('POST', '/api/tasks/1/complete'), null)
  // Only the existing signed TEST login bridge can grant these personal
  // routes after checking its server-owned selected Person against the
  // central account link. Private multi-family proxy remains denied.
  assert.equal(requiredFamilyMemberActions('GET', '/api/test-event-invitations'), null)
  assert.equal(requiredFamilyMemberActions('POST', '/api/test-event-invitations/7/respond'), null)
  assert.equal(requiredFamilyMemberActions('GET', '/api/test-notification-pilot'), null)
  assert.equal(requiredFamilyMemberActions('POST', '/api/test-notification-pilot/9/acknowledge'), null)
  assert.equal(requiredFamilyMemberActions('GET', '/api/test-household-events/join-capability'), null)
  assert.equal(requiredFamilyMemberActions('POST', '/api/test-household-events/9/join'), null)
  assert.equal(requiredFamilyMemberActions('POST', '/api/test-household-events/9/leave'), null)
  assert.deepEqual(requiredFamilyMemberActions('POST', '/api/events/17/exceptions'),
    ['events.edit', 'events.delete'])
  assert.deepEqual(requiredFamilyMemberActions('DELETE', '/api/event-batches/batch-1'),
    ['events.delete'])
})

test('route audit is conservative: a route declaration is not security permission', () => {
  const report = summarizeTestApiRouteAudit()
  assert.ok(report.unreviewedRoutes.every(row => row.source.startsWith('Server/')))
  assert.equal(requiredFamilyMemberActions('GET', '/api/health'), null)
  assert.equal(requiredFamilyMemberActions('POST', '/api/family-daily-note'), null)
  assert.equal(requiredFamilyMemberActions('GET', '/API/emoji-markers'), null)
  assert.deepEqual(requiredFamilyMemberActions(
    'POST', '/api/emoji-markers/1/change-occurrence'), ['events.edit'])
  assert.deepEqual(requiredFamilyMemberActions(
    'PUT', '/api/daily-notes/2026-11-20'), ['events.edit'])
})
