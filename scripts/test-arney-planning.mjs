import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planArneyReadOnlyRequest } from '../src/arneyPlanning.mjs'

const now = new Date(2026, 10, 13, 12)
const people = [{ id: 2, name: 'Robert' }, { id: 3, name: 'Haylee' }]
const event = (id, date, title, time = null, endTime = null, assigned = [people[0]]) =>
  ({ id, date, title, time, endTime, people: assigned })
const base = {
  now, activePersonId: 2, recipes: [], mealPlanItems: [],
  events: [],
  occurrenceStartForDate: (e, day) => e.date === day ? e.date : null,
}
const plan = (text, input = {}) => planArneyReadOnlyRequest(text, { ...base, ...input })

test('weekly family schedule includes verified events, people and exact week', () => {
  const result = plan("What's on our family calendar this week?", {
    events: [event(10, '2026-11-13', 'Dentist', '14:00', '15:00')],
  })
  assert.equal(result.kind, 'information')
  assert.match(result.text, /Family calendar/)
  assert.match(result.text, /Fri, 11\/13: Dentist at 14:00 — Robert/)
  assert.match(result.text, /Nothing was changed/)
})

test('no events is read-only and does not invent entries', () => {
  const result = plan('Show our family schedule this week')
  assert.match(result.text, /no matching events found/)
  assert.doesNotMatch(result.text, /Dentist/)
})

test('your own schedule uses active profile, not other people', () => {
  const events = [
    event(1, '2026-11-13', 'Mine'),
    event(2, '2026-11-13', 'Not mine', null, null, [people[1]]),
  ]
  const result = plan('Show my calendar this week', { events })
  assert.match(result.text, /Mine/)
  assert.doesNotMatch(result.text, /Not mine/)
  assert.match(plan('Show my calendar this week', { events, activePersonId: null }).text, /Select your personal profile/)
})

test('next week uses actual following Sunday through Saturday', () => {
  const result = plan('Show our schedule next week', {
    events: [event(1, '2026-11-15', 'Sunday outing'), event(2, '2026-11-13', 'Not next week')],
  })
  assert.match(result.text, /Sunday outing/)
  assert.doesNotMatch(result.text, /Not next week/)
})

test('multi-day and recurring occurrences are delegated to app calendar logic and deduplicated', () => {
  const weekend = event(1, '2026-11-12', 'Weekend visit')
  const repeating = event(2, '2026-11-06', 'Recurring meeting')
  const result = plan('Show our schedule this week', {
    events: [weekend, repeating],
    occurrenceStartForDate: (e, day) =>
      e.id === 1 && ['2026-11-12', '2026-11-13', '2026-11-14'].includes(day)
        ? '2026-11-12'
        : e.id === 2 && day === '2026-11-13' ? '2026-11-13' : null,
  })
  assert.equal(result.text.split('Weekend visit').length - 1, 1)
  assert.match(result.text, /Recurring meeting/)
})

test('overlapping timed entries are reported as possible, not guaranteed conflicts', () => {
  const result = plan('Check our calendar for conflicts this week', {
    events: [
      event(1, '2026-11-13', 'A', '10:00', '11:00'),
      event(2, '2026-11-13', 'B', '10:30', '11:30'),
    ],
  })
  assert.match(result.text, /Possible schedule overlaps/)
  assert.match(result.text, /Both involve: Robert/)
  assert.match(result.text, /not confirmed conflicts/)
})

test('different people overlapping is clearly labeled without claiming conflict', () => {
  const result = plan('Are there overlapping events this week', {
    events: [
      event(1, '2026-11-13', 'A', '10:00', '11:00'),
      event(2, '2026-11-13', 'B', '10:30', '11:30', [people[1]]),
    ],
  })
  assert.match(result.text, /Different assignees/)
})

test('missing end times never cause a false all-clear', () => {
  const result = plan('Check for conflicts this week', {
    events: [event(1, '2026-11-13', 'Unfinished', '10:00', null)],
  })
  assert.match(result.text, /without valid start and end times/)
})

test('end-to-start touching times do not overlap', () => {
  const result = plan('Check for conflicts this week', {
    events: [
      event(1, '2026-11-13', 'A', '10:00', '11:00'),
      event(2, '2026-11-13', 'B', '11:00', '12:00'),
    ],
  })
  assert.match(result.text, /No overlapping timed event pairs/)
})

test('dinner ideas use only saved recipes, preserve existing plans, and never save', () => {
  const result = plan('Suggest five dinners from our recipes', {
    recipes: [
      { name: 'Fajitas', favorite: true },
      { name: 'Chicken rice', favorite: false },
      { name: 'Fajitas', favorite: false },
    ],
    mealPlanItems: [{ date: '2026-11-13', mealType: 'dinner', title: 'Pizza' }],
  })
  assert.match(result.text, /Already planned — Pizza/)
  assert.match(result.text, /Suggested — Fajitas/)
  assert.match(result.text, /Suggested — Chicken rice/)
  assert.equal(result.text.split('Suggested — Fajitas').length - 1, 1)
  assert.match(result.text, /No meal plans or shopping lists were changed/)
})

test('no saved recipes reports the limitation', () => {
  const result = plan('Plan dinners for next week')
  assert.match(result.text, /No saved recipes are available/)
})

test('online research, writes, and unrelated questions are never mistaken for plan tools', () => {
  assert.equal(plan('Find dinner recipes online this week'), null)
  assert.equal(plan('Schedule dinner this week'), null)
  assert.equal(plan('Cancel my meeting this week'), null)
  assert.equal(plan('What is the weather tomorrow?'), null)
})

test('planning code contains no fetch, persistence, or model calls', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = fs.readFileSync(path.join(root, 'src/arneyPlanning.mjs'), 'utf8')
  assert.doesNotMatch(source, /\b(?:fetch|localStorage|indexedDB|writeFile|\.run\(|ollama|axios)\s*\(/)
})
