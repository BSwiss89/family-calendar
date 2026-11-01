import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAcceptedSharedEvents,
  sharedEventsInRange,
  sharedEventOverlapsRange,
  formatSharedTime,
  formatSharedDate,
  isCalendarDateKey,
} from '../src/sharedEventOverlay.ts'

function sample(extra = {}) {
  return {
    shareId: 71,
    sharedBy: 'Family A',
    title: 'Selected BBQ',
    date: '2026-12-20',
    endDate: null,
    time: '12:30',
    endTime: '15:00',
    ...extra,
  }
}

test('only accepted event snapshot allowlist is rendered; never notes, source IDs, locations or people', () => {
  const incoming = {
    events: [sample({
      sourceEventId: 51,
      sourceHouseholdId: 'family-a',
      password_hash: 'DO NOT SHOW',
      notes: 'PRIVATE NOTE',
      location: 'PRIVATE ADDRESS',
      people: [{ name: 'PRIVATE PERSON' }],
      uploads: ['/uploads/private.jpg'],
    })],
    otherFamilies: [{ title: 'SECRET EVENT' }],
  }
  const result = parseAcceptedSharedEvents(incoming)
  assert.deepEqual(result, [sample()])
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /PRIVATE|DO NOT SHOW|SECRET|sourceEventId|sourceHouseholdId|uploads/)
})

test('invalid, forged and duplicate entries are rejected, and empty/HTML response never adds events', () => {
  const result = parseAcceptedSharedEvents({ events: [
    sample(),
    sample({ shareId: 71, title: 'Duplicate' }),
    sample({ shareId: -1 }),
    sample({ shareId: '71' }),
    sample({ shareId: 2, title: '' }),
    sample({ shareId: 3, date: '2026-02-30' }),
    sample({ shareId: 4, date: '2026-13-01' }),
    sample({ shareId: 5, date: '../../other' }),
    sample({ shareId: 6, endDate: '2026-12-19' }),
    sample({ shareId: 7, time: '25:30' }),
    sample({ shareId: 8, sharedBy: '' }),
    sample({ shareId: 9, time: null, endTime: null }),
  ]})
  assert.deepEqual(result.map(e => e.shareId), [9, 71])
  assert.deepEqual(parseAcceptedSharedEvents(null), [])
  assert.deepEqual(parseAcceptedSharedEvents('<html>unsupported endpoint</html>'), [])
  assert.deepEqual(parseAcceptedSharedEvents({ events: undefined }), [])
  assert.equal(isCalendarDateKey('2028-02-29'), true)
  assert.equal(isCalendarDateKey('2027-02-29'), false)
})

test('accepted shared events are filtered by date and optional multiday end, never by all household events', () => {
  const events = parseAcceptedSharedEvents({ events: [
    sample({ shareId: 3, date: '2026-12-24', title: 'Later event' }),
    sample({ shareId: 1, date: '2026-12-10', endDate: '2026-12-12', title: 'Multi-day event' }),
    sample({ shareId: 2, date: '2026-12-11', title: 'Single day' }),
    sample({ shareId: 4, date: '2027-01-03', title: 'Next month' }),
  ]})
  assert.deepEqual(events.map(e => e.shareId), [1, 2, 3, 4])
  assert.deepEqual(sharedEventsInRange(events, '2026-12-12', '2026-12-12').map(e => e.shareId), [1])
  assert.deepEqual(sharedEventsInRange(events, '2026-12-09', '2026-12-11').map(e => e.shareId), [1, 2])
  assert.deepEqual(sharedEventsInRange(events, '2026-12-01', '2026-12-31').map(e => e.shareId), [1, 2, 3])
  assert.equal(sharedEventOverlapsRange(events[0], '2026-12-12', '2026-12-12'), true)
  assert.deepEqual(sharedEventsInRange(events, '2026-12-31', '2026-12-01'), [])
})

test('display formats are human-readable without changing source event data', () => {
  assert.equal(formatSharedTime(null), 'All day')
  assert.equal(formatSharedTime('00:00'), '12:00 AM')
  assert.equal(formatSharedTime('12:00'), '12:00 PM')
  assert.equal(formatSharedTime('15:30'), '3:30 PM')
  assert.equal(formatSharedDate('2026-12-20'), 'Dec 20')
  assert.equal(formatSharedDate('not a date'), '')
})

test('multiple source families with coinciding event IDs remain distinct by share ID', () => {
  const events = parseAcceptedSharedEvents({ events: [
    sample({ shareId: 10, sharedBy: 'Family A', title: 'BBQ', sourceEventId: 1 }),
    sample({ shareId: 11, sharedBy: 'Family C', title: 'Birthday', sourceEventId: 1 }),
  ]})
  assert.deepEqual(events.map(e => e.shareId), [10, 11])
  assert.equal(Object.hasOwn(events[0], 'sourceEventId'), false)
})
