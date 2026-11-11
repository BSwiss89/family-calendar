import assert from 'node:assert/strict'
import test from 'node:test'

import {
  eventMatchesCalendarPersonFilter,
  toggleCalendarPersonFilterIds,
} from '../src/calendarPersonFilter.ts'

test('no selected people shows the complete family calendar', () => {
  assert.equal(eventMatchesCalendarPersonFilter([], []), true)
  assert.equal(eventMatchesCalendarPersonFilter([1], []), true)
})

test('multiple selected people show the union of their schedules', () => {
  const selected = [1, 2]

  assert.equal(eventMatchesCalendarPersonFilter([1], selected), true)
  assert.equal(eventMatchesCalendarPersonFilter([2], selected), true)
  assert.equal(eventMatchesCalendarPersonFilter([1, 3], selected), true)
  assert.equal(eventMatchesCalendarPersonFilter([3], selected), false)
  assert.equal(eventMatchesCalendarPersonFilter([], selected), false)
})

test('tapping a person independently adds and removes that filter', () => {
  const oneSelected = toggleCalendarPersonFilterIds([], 1)
  assert.deepEqual(oneSelected, [1])

  const twoSelected = toggleCalendarPersonFilterIds(oneSelected, 2)
  assert.deepEqual(twoSelected, [1, 2])

  const secondRemoved = toggleCalendarPersonFilterIds(twoSelected, 2)
  assert.deepEqual(secondRemoved, [1])

  const allRemoved = toggleCalendarPersonFilterIds(secondRemoved, 1)
  assert.deepEqual(allRemoved, [])
})
