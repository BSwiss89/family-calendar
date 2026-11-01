import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HOME_SELECTION, profileStorageKey, parseProfileSelection,
  serializeProfileSelection, resolveProfileSelection,
} from '../src/householdProfileSelection.mjs'

const sevenPeople = Array.from({ length: 7 }, (_, index) => ({ id: index + 1 }))

test('Home is a reserved selection, not a person or person assignment', () => {
  assert.equal(HOME_SELECTION, 'home')
  assert.deepEqual(parseProfileSelection('home'), { kind: 'home' })
  assert.equal(serializeProfileSelection({ kind: 'home' }), 'home')
  assert.equal(sevenPeople.length, 7)
  assert.ok(sevenPeople.every(person => Number.isInteger(person.id)))
})

test('Existing person IDs round-trip, no names or images stored', () => {
  const selection = { kind: 'person', personId: 5 }
  assert.equal(serializeProfileSelection(selection), 'person:5')
  assert.deepEqual(resolveProfileSelection('person:5', sevenPeople), selection)
})

test('Deleted or invalid people require a new choice', () => {
  for (const input of ['person:8', 'person:0', 'person:-1',
    'person:1.2', 'person:01', 'person:9007199254740992', 'anything', '']) {
    assert.equal(resolveProfileSelection(input, sevenPeople), null)
  }
  assert.equal(resolveProfileSelection('person:5', sevenPeople.filter(p => p.id !== 5)), null)
  assert.equal(resolveProfileSelection('home', []), parseProfileSelection('home'))
})

test('A new wall device may enroll Home, but existing preference wins', () => {
  assert.deepEqual(resolveProfileSelection(null, sevenPeople, true), { kind: 'home' })
  assert.equal(resolveProfileSelection(null, sevenPeople, false), null)
  assert.deepEqual(resolveProfileSelection('person:2', sevenPeople, true),
    { kind: 'person', personId: 2 })
  assert.equal(resolveProfileSelection('person:8', sevenPeople, true), null)
})

test('Device selection storage is scoped to the signed-in account and household', () => {
  const a = profileStorageKey('familyadmin')
  assert.equal(a, profileStorageKey('FAMILYADMIN'))
  assert.notEqual(a, profileStorageKey('otheradmin'))
  assert.notEqual(a, profileStorageKey('familyadmin', 'another-household'))
  assert.equal(profileStorageKey(''), null)
  assert.equal(profileStorageKey('invalid username'), null)
})

test('A rejected profile never produces a persisted preference', () => {
  assert.equal(serializeProfileSelection(null), null)
  assert.equal(serializeProfileSelection({ kind: 'person', personId: -1 }), null)
})
