import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isValidDate, isValidTitle, isValidPersonName, isValidColor, cleanOptionalText } from '../Server/calendar-input-validation.mjs'

test('date validation preserves legacy YYYY-MM-DD format-only rule', () => {
  assert.equal(isValidDate('2026-11-19'), true)
  assert.equal(isValidDate('2026-02-31'), true) // Legacy rule checks shape, not calendar reality.
  assert.equal(isValidDate('11/19/2026'), false)
  assert.equal(isValidDate('2026-1-19'), false)
  assert.equal(isValidDate(null), false)
})

test('event titles and person names retain existing trim and length limits', () => {
  assert.equal(isValidTitle(' An event '), true)
  assert.equal(isValidTitle(' '.repeat(201)), false)
  assert.equal(isValidTitle('a'.repeat(200)), true)
  assert.equal(isValidTitle('a'.repeat(201)), false)
  assert.equal(isValidTitle(12), false)
  assert.equal(isValidPersonName(' A '), true)
  assert.equal(isValidPersonName('n'.repeat(50)), true)
  assert.equal(isValidPersonName('n'.repeat(51)), false)
  assert.equal(isValidPersonName(' '), false)
})

test('colors and optional text retain their original behavior', () => {
  assert.equal(isValidColor('#aBc123'), true)
  assert.equal(isValidColor('#fff'), false)
  assert.equal(isValidColor('aBc123'), false)
  assert.equal(isValidColor('#0000000'), false)
  assert.equal(cleanOptionalText('  hello world  ', 5), 'hello')
  assert.equal(cleanOptionalText('  hello  ', 50), 'hello')
  assert.equal(cleanOptionalText('  ', 50), null)
  assert.equal(cleanOptionalText(undefined, 50), null)
  assert.equal(cleanOptionalText(14, 50), null)
})

test('legacy API imports the shared validators; no duplicate functions remain', () => {
  const api = readFileSync(new URL('../Server/index.mjs', import.meta.url), 'utf8')
  assert.match(api, /from '\.\/calendar-input-validation\.mjs'/)
  for (const name of ['isValidDate', 'isValidTitle', 'isValidPersonName', 'isValidColor', 'cleanOptionalText']) {
    assert.doesNotMatch(api, new RegExp('function\\s+' + name + '\\s*\\('))
  }
})
