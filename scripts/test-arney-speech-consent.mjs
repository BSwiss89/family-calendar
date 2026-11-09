import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ARNEY_PREFERENCES, ARNEY_PREFERENCES_KEY,
  normalizeArneyPreferences, readArneyPreferences, saveArneyPreferences,
} from '../src/arneyPreferences.ts'

test('private local speech is built in while browser speech remains opt-in', () => {
  assert.equal(DEFAULT_ARNEY_PREFERENCES.browserSpeechEnabled, false)
  assert.equal(DEFAULT_ARNEY_PREFERENCES.localSpeechEnabled, true)
  const migrated = normalizeArneyPreferences({
    responseMode: 'always', wakeWordsEnabled: true, confirmBeforeChanges: true,
  })
  assert.equal(migrated.browserSpeechEnabled, false)
  assert.equal(migrated.localSpeechEnabled, true)
  assert.equal(migrated.wakeWordsEnabled, true)
  assert.equal(migrated.confirmBeforeChanges, true)
})

test('invalid consent never becomes consent', () => {
  for (const value of [null, {}, {browserSpeechEnabled: 'true'},
    {browserSpeechEnabled: 1}, {browserSpeechEnabled: null},
    {browserSpeechEnabled: []}]) {
    assert.equal(normalizeArneyPreferences(value).browserSpeechEnabled, false)
  }
  assert.equal(normalizeArneyPreferences({browserSpeechEnabled: true}).browserSpeechEnabled, true)
  assert.equal(normalizeArneyPreferences({localSpeechEnabled: true}).localSpeechEnabled, true)
  assert.equal(normalizeArneyPreferences({localSpeechEnabled: false}).localSpeechEnabled, true)
})

test('device storage keeps browser speech opt-in and handles invalid saved values', () => {
  const previous = globalThis.window
  const saved = new Map()
  globalThis.window = {
    localStorage: {
      getItem: key => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
    },
  }
  try {
    assert.equal(readArneyPreferences().browserSpeechEnabled, false)
    assert.equal(saveArneyPreferences({
      responseMode: 'silent', wakeWordsEnabled: false,
      browserSpeechEnabled: true, confirmBeforeChanges: true,
    }), true)
    assert.equal(readArneyPreferences().browserSpeechEnabled, true)
    assert.equal(JSON.parse(saved.get(ARNEY_PREFERENCES_KEY)).browserSpeechEnabled, true)
    saved.set(ARNEY_PREFERENCES_KEY, '{invalid')
    assert.equal(readArneyPreferences().browserSpeechEnabled, false)
  } finally {
    globalThis.window = previous
  }
})
