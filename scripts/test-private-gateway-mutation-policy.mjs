import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectPrivateGatewayMutation } from '../Server/private-gateway-mutation-policy.mjs'

test('canonical individual event changes are the only mutable event routes permitted', () => {
  assert.deepEqual(inspectPrivateGatewayMutation('POST', '/api/events'), {
    allowed: true, isCreate: true,
  })
  assert.deepEqual(inspectPrivateGatewayMutation('POST', '/api/events?from=month'), {
    allowed: true, isCreate: true,
  })
  assert.deepEqual(inspectPrivateGatewayMutation('PUT', '/api/events/123?ignore=1'), {
    allowed: true, sourceEventId: 123,
  })
  assert.deepEqual(inspectPrivateGatewayMutation('DELETE', '/api/events/1'), {
    allowed: true, sourceEventId: 1,
  })
  assert.deepEqual(inspectPrivateGatewayMutation('GET', '/api/events'), {
    allowed: true,
  })
  assert.deepEqual(inspectPrivateGatewayMutation('GET', '/api/ai/cancel-confirmed'), {
    allowed: true,
  })
})

test('alternate event mutations fail closed instead of skipping durable journal', () => {
  const forbidden = [
    ['POST', '/api/ai/cancel-confirmed'],
    ['POST', '/api/ai/reschedule-confirmed'],
    ['POST', '/API/AI/CANCEL-CONFIRMED'],
    ['POST', '/api/ai/cancel-confirmed/'],
    ['DELETE', '/api/event-batches/group-1'],
    ['DELETE', '/api/event-batches/group-1?household=family-b'],
    ['POST', '/api/events/1/exceptions'],
    ['DELETE', '/api/events/1/exceptions/2026-12-20'],
    ['PATCH', '/api/events/1'],
    ['DELETE', '/api/events/01'],
    ['PUT', '/api/events/01'],
    ['DELETE', '/API/EVENTS/1'],
    ['DELETE', '/api/events/1/'],
    ['DELETE', '/api/events/%31'],
    ['DELETE', '/api/events/1%2f'],
    ['DELETE', '/api/events//1'],
    ['DELETE', '/api/events/9007199254740992'],
    ['POST', '/api/events/1'],
    ['POST', '/api/events/'],
    ['DELETE', '/api/events'],
    ['DELETE', '/api/ai/cancel-confirmed%2f'],
  ]
  for (const [method, url] of forbidden) {
    assert.deepEqual(inspectPrivateGatewayMutation(method, url),
      { allowed: false }, method + ' ' + url)
  }
})

test('unrelated household-scoped functionality is not accidentally blocked', () => {
  for (const [method, url] of [
    ['POST', '/api/lists'],
    ['PUT', '/api/list-items/5'],
    ['POST', '/api/recipes'],
    ['POST', '/api/ai/intent'],
    ['PATCH', '/api/people/5'],
    ['PUT', '/api/daily-notes/2026-12-20'],
  ]) {
    assert.deepEqual(inspectPrivateGatewayMutation(method, url),
      { allowed: true }, method + ' ' + url)
  }
})
