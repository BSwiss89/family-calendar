import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import express from 'express'
import {
  emojiMarkerOccursOnDate, normalizeEmojiMarkerPayload, validEmojiDate,
} from '../Server/emoji-marker-rules.mjs'
import { installCalendarEmojiMarkers } from '../Server/calendar-emoji-markers.mjs'

function marker(date, extra = {}) {
  return normalizeEmojiMarkerPayload({ date, emoji: '💵', label: 'Payday', ...extra })
}

test('strict date and single emoji input validation', () => {
  assert.equal(validEmojiDate('2026-02-29'), false)
  assert.equal(validEmojiDate('2028-02-29'), true)
  assert.equal(marker('2026-11-12')?.emoji, '💵')
  assert.equal(normalizeEmojiMarkerPayload({ date: '2026-11-12', emoji: '💵🎂' }), null)
  assert.equal(normalizeEmojiMarkerPayload({ date: '2026-11-12', emoji: '<script>' }), null)
  assert.equal(normalizeEmojiMarkerPayload({ date: '2026-11-12', emoji: '🏳️‍🌈' })?.emoji, '🏳️‍🌈')
  assert.equal(marker('2026-11-12', { repeatUnit: 'week', repeatInterval: 0 }), null)
  assert.equal(marker('2026-11-12', { repeatUnit: 'week', repeatWeekdays: [] }), null)
})

test('biweekly Thursday payday does not drift through months or daylight changes', () => {
  const payday = marker('2026-11-12', { repeatUnit: 'week', repeatInterval: 2 })
  assert.ok(payday)
  assert.equal(emojiMarkerOccursOnDate(payday, '2026-11-12'), true)
  assert.equal(emojiMarkerOccursOnDate(payday, '2026-11-19'), false)
  assert.equal(emojiMarkerOccursOnDate(payday, '2026-11-26'), true)
  assert.equal(emojiMarkerOccursOnDate(payday, '2026-12-10'), true)
  assert.equal(emojiMarkerOccursOnDate(payday, '2027-01-07'), true)
  assert.equal(emojiMarkerOccursOnDate(payday, '2026-11-11'), false)
})

test('selected weekdays and count end mean occurrences, not weeks', () => {
  const recurring = marker('2026-11-12', {
    repeatUnit: 'week', repeatWeekdays: [1, 4], repeatEndType: 'count', repeatCount: 3,
  })
  assert.ok(recurring)
  assert.equal(emojiMarkerOccursOnDate(recurring, '2026-11-12'), true)
  assert.equal(emojiMarkerOccursOnDate(recurring, '2026-11-16'), true)
  assert.equal(emojiMarkerOccursOnDate(recurring, '2026-11-19'), true)
  assert.equal(emojiMarkerOccursOnDate(recurring, '2026-11-23'), false)
})

test('monthly exact day skips invalid months without losing the count', () => {
  const recurring = marker('2027-01-31', {
    repeatUnit: 'month', repeatMonthPattern: 'date', repeatEndType: 'count', repeatCount: 3,
  })
  assert.ok(recurring)
  assert.equal(emojiMarkerOccursOnDate(recurring, '2027-01-31'), true)
  assert.equal(emojiMarkerOccursOnDate(recurring, '2027-02-28'), false)
  assert.equal(emojiMarkerOccursOnDate(recurring, '2027-03-31'), true)
  assert.equal(emojiMarkerOccursOnDate(recurring, '2027-05-31'), true)
  assert.equal(emojiMarkerOccursOnDate(recurring, '2027-07-31'), false)
})

test('monthly nth weekday, last weekday, and repeat end date', () => {
  const nth = marker('2026-11-12', { repeatUnit: 'month', repeatMonthPattern: 'nth-weekday' })
  assert.equal(emojiMarkerOccursOnDate(nth, '2026-12-10'), true)
  assert.equal(emojiMarkerOccursOnDate(nth, '2026-12-17'), false)
  const last = marker('2026-11-26', { repeatUnit: 'month', repeatMonthPattern: 'last-weekday' })
  assert.equal(emojiMarkerOccursOnDate(last, '2026-12-31'), true)
  const until = marker('2026-11-12', { repeatUnit: 'week', repeatEndType: 'date', repeatEndDate: '2026-11-27' })
  assert.equal(emojiMarkerOccursOnDate(until, '2026-11-26'), true)
  assert.equal(emojiMarkerOccursOnDate(until, '2026-12-03'), false)
})

test('yearly leap-day markers skip non-leap years and honor count', () => {
  const recurring = marker('2028-02-29', { repeatUnit: 'year', repeatEndType: 'count', repeatCount: 2 })
  assert.equal(emojiMarkerOccursOnDate(recurring, '2028-02-29'), true)
  assert.equal(emojiMarkerOccursOnDate(recurring, '2032-02-29'), true)
  assert.equal(emojiMarkerOccursOnDate(recurring, '2036-02-29'), false)
})

test('skipping an occurrence does not shift payday or alter the rest of the series', () => {
  const recurring = { ...marker('2026-11-12', { repeatUnit: 'week', repeatInterval: 2 }),
    exceptions: ['2026-11-26'] }
  assert.equal(emojiMarkerOccursOnDate(recurring, '2026-11-26'), false)
  assert.equal(emojiMarkerOccursOnDate(recurring, '2026-12-10'), true)
})

test('authenticated CRUD supports a separate marker table, single-date skip, one-date edit and truncation', async () => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON; CREATE TABLE events (id INTEGER PRIMARY KEY, title TEXT) STRICT; INSERT INTO events (title) VALUES (\'Existing Event\');')
  const app = express()
  app.use(express.json())
  app.use((request, response, next) => {
    if (request.get('x-test-auth') !== 'yes') return response.status(401).json({ error: 'Login required' })
    next()
  })
  installCalendarEmojiMarkers(app, database)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  const request = async (path, method = 'GET', body = undefined, auth = true) => {
    const response = await fetch(base + path, {
      method, headers: {
        ...(auth ? { 'x-test-auth': 'yes' } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    assert.equal((await request('/api/emoji-markers', 'GET', undefined, false)).status, 401)
    const added = await request('/api/emoji-markers', 'POST', {
      date: '2026-11-12', emoji: '💵', label: 'Payday', repeatUnit: 'week',
      repeatInterval: 2, repeatWeekdays: [4],
    })
    assert.equal(added.status, 201)
    const id = added.body.id
    let markers = (await request('/api/emoji-markers')).body
    assert.equal(markers.length, 1)
    assert.equal(emojiMarkerOccursOnDate(markers[0], '2026-11-26'), true)
    assert.equal((await request('/api/emoji-markers/' + id + '/exceptions', 'POST', {
      occurrenceDate: '2026-11-26',
    })).status, 201)
    markers = (await request('/api/emoji-markers')).body
    assert.equal(emojiMarkerOccursOnDate(markers[0], '2026-11-26'), false)
    assert.equal(emojiMarkerOccursOnDate(markers[0], '2026-12-10'), true)
    assert.equal((await request('/api/emoji-markers/' + id + '/change-occurrence', 'POST', {
      occurrenceDate: '2026-12-10', emoji: '🏆', label: 'Bonus',
    })).status, 201)
    markers = (await request('/api/emoji-markers')).body
    assert.equal(markers.length, 2)
    assert.equal(emojiMarkerOccursOnDate(markers[0], '2026-12-10'), false)
    assert.equal(emojiMarkerOccursOnDate(markers[1], '2026-12-10'), true)
    assert.equal((await request('/api/emoji-markers/' + id + '/truncate', 'POST', {
      occurrenceDate: '2026-12-24',
    })).status, 200)
    markers = (await request('/api/emoji-markers')).body
    assert.equal(emojiMarkerOccursOnDate(markers[0], '2026-12-24'), false)
    assert.equal(emojiMarkerOccursOnDate(markers[0], '2026-12-10'), false)
    assert.equal(database.prepare('SELECT COUNT(*) AS total FROM events').get().total, 1)
    assert.equal((await request('/api/emoji-markers/' + id, 'DELETE')).status, 200)
    assert.equal((await request('/api/emoji-markers')).body.length, 1)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    database.close()
  }
})
