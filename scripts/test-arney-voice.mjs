import test from 'node:test'
import assert from 'node:assert/strict'
import { extractArneyWakeCommand, shouldOfferArneyTextFallback } from '../src/arneyWakePhrase.ts'

test('wake words accept the three requested phrases', () => {
  assert.equal(extractArneyWakeCommand('Hey Arney, what is tomorrow?'), 'what is tomorrow?')
  assert.equal(extractArneyWakeCommand('arney'), '')
  assert.equal(extractArneyWakeCommand('Computer, cancel my meeting'), 'cancel my meeting')
})
test('wake words do not trigger on incidental mentions', () => {
  assert.equal(extractArneyWakeCommand('I met Arney yesterday'), null)
  assert.equal(extractArneyWakeCommand('computerize this'), null)
  assert.equal(extractArneyWakeCommand('hey Barney'), null)
})
test('text fallback appears on the third failure', () => {
  assert.equal(shouldOfferArneyTextFallback(0), false)
  assert.equal(shouldOfferArneyTextFallback(2), false)
  assert.equal(shouldOfferArneyTextFallback(3), true)
})

test('speech adapter waits for end and emits once after stop', async () => {
  const { beginArneySpeech } = await import('../src/arneySpeech.ts')
  class MockRecognition {
    onresult = null
    onerror = null
    onend = null
    lang = ''
    continuous = false
    interimResults = false
    start() {}
    stop() { this.onend?.() }
    abort() { this.onend?.() }
  }
  let instance
  const original = globalThis.window
  globalThis.window = {
    SpeechRecognition: class extends MockRecognition {
      constructor() { super(); instance = this }
    },
  }
  try {
    const results = []
    const session = beginArneySpeech(result => results.push(result))
    assert.ok(session)
    instance.onresult?.({ results: [[{ transcript: 'Add milk to groceries' }]] })
    session.stop()
    instance.onend?.()
    assert.deepEqual(results, [{ kind: 'transcript', text: 'Add milk to groceries' }])
  } finally {
    globalThis.window = original
  }
})

test('canceled browser recognition cannot submit late transcripts', async () => {
  const { beginArneySpeech } = await import('../src/arneySpeech.ts')
  let instance
  const original = globalThis.window
  globalThis.window = {
    SpeechRecognition: class {
      constructor() { instance = this }
      start() {}
      stop() { this.onend?.() }
      abort() { this.onend?.() }
    },
  }
  try {
    const results = []
    const session = beginArneySpeech(result => results.push(result))
    session.cancel()
    instance.onend?.()
    assert.deepEqual(results, [])
  } finally {
    globalThis.window = original
  }
})
