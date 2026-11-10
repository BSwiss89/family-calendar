import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArneySimpleCommand } from '../src/arneyTextCommands.ts'

const now = new Date(2026, 9, 13, 12)
const lists = [
  { id: 7, name: 'Groceries', items: [{ text: 'Eggs' }, { text: 'Milk' }] },
  { id: 8, name: 'To-Do', items: [] },
]
const people = [
  { id: 2, name: 'Robert' },
  { id: 3, name: 'Haylee' },
  { id: 4, name: 'Morgan' },
]

test('simple list write is a preview, not an API mutation', () => {
  assert.deepEqual(parseArneySimpleCommand('Add bananas to my Groceries list', lists, now), {
    kind: 'add-list-item', listId: 7, listName: 'Groceries', item: 'bananas',
  })
  assert.deepEqual(parseArneySimpleCommand('Add milk to my grocery list', lists, now), {
    kind: 'add-list-item', listId: 7, listName: 'Groceries', item: 'milk',
  })
})

test('meal planning voice command returns an editable draft only', () => {
  assert.deepEqual(parseArneySimpleCommand('Add fajitas to lunch tomorrow', lists, now), {
    kind: 'add-meal', title: 'fajitas', date: '2026-10-14', mealType: 'lunch',
  })
})

test('lists can be queried without writing', () => {
  assert.deepEqual(parseArneySimpleCommand('What is on my Groceries list?', lists, now), {
    kind: 'list-query', listId: 7, listName: 'Groceries', items: ['Eggs', 'Milk'],
  })
})

test('recognizes simple calendar read-only requests', () => {
  assert.deepEqual(parseArneySimpleCommand("What's on my calendar tomorrow?", lists, now), {
    kind: 'calendar-query', when: 'tomorrow',
  })
})

test('event creation supports natural time/date order and stays a draft', () => {
  assert.deepEqual(parseArneySimpleCommand('Schedule dentist tomorrow at 2 PM', lists, now), {
    kind: 'create-event', title: 'dentist', date: '2026-10-14', time: '14:00',
  })
  assert.deepEqual(parseArneySimpleCommand('Create a dentist appointment at 2pm tomorrow', lists, now), {
    kind: 'create-event', title: 'dentist appointment', date: '2026-10-14', time: '14:00',
  })
  assert.deepEqual(parseArneySimpleCommand('Add a dentist appointment tomorrow at 2pm', lists, now), {
    kind: 'create-event', title: 'dentist appointment', date: '2026-10-14', time: '14:00',
  })
  assert.deepEqual(parseArneySimpleCommand('Add a dentist appointment, tomorrow at 2 p.m.', lists, now), {
    kind: 'create-event', title: 'dentist appointment', date: '2026-10-14', time: '14:00',
  })
  assert.equal(parseArneySimpleCommand('Schedule dentist 2026-02-30 at 2 PM', lists, now), null)
  assert.equal(parseArneySimpleCommand('Schedule dentist tomorrow at 3', lists, now), null)
  assert.equal(parseArneySimpleCommand('Schedule dentist someday', lists, now), null)
})

test('spoken people preselect existing profiles and me means the active profile', () => {
  assert.deepEqual(
    parseArneySimpleCommand('Me and Haylee have a date tomorrow at 7 p.m.', lists, now, people, 2),
    {
      kind: 'create-event', title: 'date', date: '2026-10-14', time: '19:00', personIds: [2, 3],
    },
  )
  for (const phrase of [
    'Haylee and I have a date tomorrow',
    'Hey, Haylee and I have a date tomorrow',
    'Hey Arney, Haylee and I have a date tomorrow',
    'They Haylee and I have a date tomorrow',
  ]) {
    assert.deepEqual(
      parseArneySimpleCommand(phrase, lists, now, people, 2),
      {
        kind: 'create-event', title: 'date', date: '2026-10-14', time: null, personIds: [3, 2],
      },
    )
  }
  assert.deepEqual(
    parseArneySimpleCommand('Morgan and Haylee have a movie at 8pm tomorrow', lists, now, people, 2),
    {
      kind: 'create-event', title: 'movie', date: '2026-10-14', time: '20:00', personIds: [4, 3],
    },
  )
  for (const spokenName of ['Haley', 'Hailey', 'Hayley', 'Hay Lee']) {
    assert.deepEqual(
      parseArneySimpleCommand(`Me and ${spokenName} have a date tomorrow at 7pm`, lists, now, people, 2),
      {
        kind: 'create-event', title: 'date', date: '2026-10-14', time: '19:00', personIds: [2, 3],
      },
    )
  }
})

test('spoken People matching refuses an equally close ambiguous name', () => {
  const similarPeople = [
    { id: 2, name: 'Robert' },
    { id: 5, name: 'Maya' },
    { id: 6, name: 'Mia' },
  ]
  for (const phrase of [
    'Me and Mya have a meeting tomorrow at 9am',
    'Hey, Mya and me have a meeting tomorrow at 9am',
  ]) {
    assert.deepEqual(
      parseArneySimpleCommand(phrase, lists, now, similarPeople, 2),
      {
        kind: 'create-event', title: 'meeting', date: '2026-10-14', time: '09:00', personIds: [2],
      },
    )
  }
})

test('whole-family holiday ranges select every current profile in an editable draft', () => {
  for (const phrase of [
    'The whole family are going on a trip Christmas to New Years',
    "All of us are going on a trip Christmas through New Year's Day",
    'Everyone is going on a trip from Christmas until New Year Day',
  ]) {
    assert.deepEqual(
      parseArneySimpleCommand(phrase, lists, now, people, 2),
      {
        kind: 'create-event',
        title: 'trip',
        date: '2026-12-25',
        endDate: '2027-01-01',
        time: null,
        personIds: [2, 3, 4],
      },
    )
  }

  assert.deepEqual(
    parseArneySimpleCommand(
      'Everybody is going on vacation Christmas to New Years',
      lists,
      new Date(2026, 11, 26, 12),
      people,
      2,
    ),
    {
      kind: 'create-event',
      title: 'vacation',
      date: '2027-12-25',
      endDate: '2028-01-01',
      time: null,
      personIds: [2, 3, 4],
    },
  )

  assert.equal(
    parseArneySimpleCommand(
      'The whole family is going on a trip Christmas to New Year’s Day',
      lists,
      new Date(2026, 11, 25, 18),
      people,
      2,
    )?.date,
    '2026-12-25',
  )
})

test('cannot infer a list that is not known', () => {
  assert.equal(parseArneySimpleCommand('Add bananas to my Unknown list', lists, now), null)
})

test('voice write routing opens review forms and never auto-saves', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
  assert.match(app, /parseArneySimpleCommand/)
  assert.match(app, /setIsAddingEvent\(true\)/)
  assert.match(app, /setQuickListOpen\(true\)/)
  assert.match(app, /setMealPlanFormOpen\(true\)/)
  assert.match(app, /activeHouseholdPersonId/)
  assert.match(app, /setSelectedPersonIds\(\[\.\.\.voicePersonIds\]\)/)
  assert.match(app, /setSelectedPersonIds\(getDefaultEventPersonIds\(\)\)/)
  assert.match(app, /setEventEndDate\(command\.endDate \?\? ''\)/)
  assert.match(app, /formatDateKeyForText\(command\.endDate\)/)
  assert.match(app, /Heard: “\$\{heardTranscript\}”/)
  assert.match(app, /transcript\.slice\(0, 117\)/)
  assert.match(app, /6500/)
  assert.match(app, /new AbortController\(\)/)
  assert.match(app, /15_000/)
  assert.match(app, /signal: requestController\.signal/)
  assert.match(app, /Arney took too long to respond/)
  const routerStart = app.indexOf('function openArneyVoiceDraft')
  const routerEnd = app.indexOf('function startCalendarAddHold', routerStart)
  assert.ok(routerStart >= 0 && routerEnd > routerStart)
  assert.doesNotMatch(app.slice(routerStart, routerEnd), /fetch\(/)
})

