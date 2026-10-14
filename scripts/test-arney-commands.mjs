import test from 'node:test'
import assert from 'node:assert/strict'
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

test('event creation must have a valid, explicit date and time', () => {
  assert.deepEqual(parseArneySimpleCommand('Schedule dentist tomorrow at 2 PM', lists, now), {
    kind: 'create-event', title: 'dentist', date: '2026-10-14', time: '14:00',
  })
  assert.equal(parseArneySimpleCommand('Schedule dentist 2026-02-30 at 2 PM', lists, now), null)
  assert.equal(parseArneySimpleCommand('Schedule dentist tomorrow at 3', lists, now), null)
  assert.equal(parseArneySimpleCommand('Schedule dentist someday', lists, now), null)
})

test('cannot infer a list that is not known', () => {
  assert.equal(parseArneySimpleCommand('Add bananas to my Unknown list', lists, now), null)
})
