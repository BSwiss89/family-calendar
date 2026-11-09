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
  assert.equal(parseArneySimpleCommand('Schedule dentist 2026-02-30 at 2 PM', lists, now), null)
  assert.equal(parseArneySimpleCommand('Schedule dentist tomorrow at 3', lists, now), null)
  assert.equal(parseArneySimpleCommand('Schedule dentist someday', lists, now), null)
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
  assert.doesNotMatch(app, /function openArneyVoiceDraft[\s\S]*?fetch\(\s*['"]\/api\/(?:events|list-items|meal-plan-items)/)
})
