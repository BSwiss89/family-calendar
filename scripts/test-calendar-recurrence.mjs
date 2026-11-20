import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRepeatRule, doesEventStartOnDate } from '../Server/calendar-recurrence.mjs'

function event(date, repeatUnit = null, repeatInterval = null, repeatEndType = null, repeatEndDate = null, repeatCount = null, exceptions = []) {
  return { date, repeatUnit, repeatInterval, repeatEndType, repeatEndDate, repeatCount, exceptions }
}

test('nonrecurring event parsing preserves normalized null fields', () => {
  const none = { repeatUnit: null, repeatInterval: null, repeatEndType: null, repeatEndDate: null, repeatCount: null }
  assert.deepEqual(getRepeatRule({}, '2026-11-19'), none)
  for (const value of [undefined, null, '', 'none']) {
    assert.deepEqual(getRepeatRule({ repeatUnit: value }, '2026-11-19'), none)
  }
})

test('recurrence parsing preserves interval, end-date, and count limits', () => {
  assert.deepEqual(getRepeatRule({ repeatUnit: 'week', repeatInterval: '2' }, '2026-11-19'), {
    repeatUnit: 'week', repeatInterval: 2, repeatEndType: 'never', repeatEndDate: null, repeatCount: null,
  })
  assert.deepEqual(getRepeatRule({ repeatUnit: 'day', repeatInterval: 365, repeatEndType: 'count', repeatCount: '1000' }, '2026-11-19'), {
    repeatUnit: 'day', repeatInterval: 365, repeatEndType: 'count', repeatEndDate: null, repeatCount: 1000,
  })
  assert.deepEqual(getRepeatRule({ repeatUnit: 'month', repeatInterval: 1, repeatEndType: 'date', repeatEndDate: '2026-12-19' }, '2026-11-19'), {
    repeatUnit: 'month', repeatInterval: 1, repeatEndType: 'date', repeatEndDate: '2026-12-19', repeatCount: null,
  })
  for (const invalid of [
    { repeatUnit: 'decade', repeatInterval: 1 },
    { repeatUnit: 'day', repeatInterval: 0 },
    { repeatUnit: 'week', repeatInterval: 366 },
    { repeatUnit: 'year', repeatInterval: 1.5 },
    { repeatUnit: 'month', repeatInterval: 'a' },
    { repeatUnit: 'year', repeatInterval: 1, repeatEndType: 'random' },
    { repeatUnit: 'week', repeatInterval: 1, repeatEndType: 'date', repeatEndDate: '2026-11-18' },
    { repeatUnit: 'week', repeatInterval: 1, repeatEndType: 'count', repeatCount: 0 },
    { repeatUnit: 'week', repeatInterval: 1, repeatEndType: 'count', repeatCount: 1001 },
  ]) assert.equal(getRepeatRule(invalid, '2026-11-19'), null, JSON.stringify(invalid))
})

test('ordinary and exception dates retain exact-match behavior', () => {
  assert.equal(doesEventStartOnDate(event('2026-11-19'), '2026-11-19'), true)
  assert.equal(doesEventStartOnDate(event('2026-11-19'), '2026-11-20'), false)
  assert.equal(doesEventStartOnDate(event('2026-11-19', null, null, null, null, null, ['2026-11-19']), '2026-11-19'), false)
})

test('daily and weekly recurrence preserves intervals, exceptions, and counts', () => {
  const daily = event('2026-11-19', 'day', 2, 'count', null, 3, ['2026-11-21'])
  assert.equal(doesEventStartOnDate(daily, '2026-11-18'), false)
  assert.equal(doesEventStartOnDate(daily, '2026-11-19'), true)
  assert.equal(doesEventStartOnDate(daily, '2026-11-20'), false)
  assert.equal(doesEventStartOnDate(daily, '2026-11-21'), false)
  assert.equal(doesEventStartOnDate(daily, '2026-11-23'), true)
  assert.equal(doesEventStartOnDate(daily, '2026-11-25'), false)
  const weekly = event('2026-11-19', 'week', 2, 'never')
  assert.equal(doesEventStartOnDate(weekly, '2026-12-03'), true)
  assert.equal(doesEventStartOnDate(weekly, '2026-11-26'), false)
})

test('monthly and yearly recurrence preserves matching day, month, and end date rules', () => {
  const monthly = event('2026-01-15', 'month', 2, 'date', '2026-07-15')
  assert.equal(doesEventStartOnDate(monthly, '2026-01-15'), true)
  assert.equal(doesEventStartOnDate(monthly, '2026-02-15'), false)
  assert.equal(doesEventStartOnDate(monthly, '2026-03-15'), true)
  assert.equal(doesEventStartOnDate(monthly, '2026-03-16'), false)
  assert.equal(doesEventStartOnDate(monthly, '2026-09-15'), false)
  const yearly = event('2024-06-13', 'year', 2, 'count', null, 2)
  assert.equal(doesEventStartOnDate(yearly, '2024-06-13'), true)
  assert.equal(doesEventStartOnDate(yearly, '2025-06-13'), false)
  assert.equal(doesEventStartOnDate(yearly, '2026-06-13'), true)
  assert.equal(doesEventStartOnDate(yearly, '2028-06-13'), false)
  assert.equal(doesEventStartOnDate(yearly, '2026-07-13'), false)
})

test('TEST main backend imports the shared module and no longer duplicates the implementations', () => {
  const main = readFileSync(new URL('../Server/index.mjs', import.meta.url), 'utf8')
  assert.match(main, /from '\.\/calendar-recurrence\.mjs'/)
  assert.doesNotMatch(main, /function\s+getRepeatRule\s*\(/)
  assert.doesNotMatch(main, /function\s+doesEventStartOnDate\s*\(/)
})
