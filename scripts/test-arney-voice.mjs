import test from 'node:test'
import assert from 'node:assert/strict'
import { extractArneyWakeCommand, shouldOfferArneyTextFallback } from '../src/arneyWakePhrase.ts'

test('wake words accept Arney, Chrome-transcribed Arnie, and Computer', () => {
  assert.equal(extractArneyWakeCommand('Hey Arney, what is tomorrow?'), 'what is tomorrow?')
  assert.equal(extractArneyWakeCommand('arney'), '')
  assert.equal(extractArneyWakeCommand("hey Arnie what's on my calendar today"), "what's on my calendar today")
  assert.equal(extractArneyWakeCommand('ARNIE, read my calendar'), 'read my calendar')
  assert.equal(extractArneyWakeCommand('hey arnie'), '')
  assert.equal(extractArneyWakeCommand('Computer, cancel my meeting'), 'cancel my meeting')
})
test('wake words do not trigger on incidental mentions', () => {
  assert.equal(extractArneyWakeCommand('I met Arney yesterday'), null)
  assert.equal(extractArneyWakeCommand('computerize this'), null)
  assert.equal(extractArneyWakeCommand('hey Barney'), null)
  assert.equal(extractArneyWakeCommand('hey Ernie'), null)
  assert.equal(extractArneyWakeCommand('arnies'), null)
  assert.equal(extractArneyWakeCommand('I said Arnie'), null)
  assert.equal(extractArneyWakeCommand('hey Armie'), null)
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
    assert.equal(instance.interimResults, true)
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


test('interim Safari transcript survives stop and diagnostic contains no spoken words', async () => {
  const { beginArneySpeech, getArneySpeechDiagnostics } = await import('../src/arneySpeech.ts')
  let instance
  const original = globalThis.window
  globalThis.window = {
    SpeechRecognition: class {
      constructor() { instance = this }
      start() { this.onstart?.() }
      stop() { this.onend?.() }
      abort() { this.onend?.() }
    },
  }
  try {
    const results = []
    const session = beginArneySpeech(result => results.push(result))
    assert.ok(session)
    assert.equal(instance.interimResults, true)
    instance.onaudiostart?.()
    instance.onspeechstart?.()
    instance.onresult?.({ results: [[{ transcript: 'private words' }]] })
    session.stop()
    instance.onresult?.({ results: [[{ transcript: 'ignored duplicate' }]] })
    assert.deepEqual(results, [{ kind: 'transcript', text: 'private words' }])
    const diagnostic = getArneySpeechDiagnostics().join('\n')
    assert.match(diagnostic, /audio start/)
    assert.match(diagnostic, /speech detected/)
    assert.match(diagnostic, /result received \(nonempty\)/)
    assert.match(diagnostic, /completed with transcript/)
    assert.doesNotMatch(diagnostic, /private words|ignored duplicate/)
  } finally {
    globalThis.window = original
  }
})


test('wake mode submits once on final result even if the browser never ends', async () => {
  const { beginArneySpeech } = await import('../src/arneySpeech.ts')
  const original = globalThis.window
  let recognition
  let aborts = 0
  globalThis.window = {
    SpeechRecognition: class {
      constructor() { recognition = this }
      start() {}
      stop() { throw Error('wake mode must not need stop') }
      abort() { aborts++ }
    },
  }
  try {
    const received = []
    const session = beginArneySpeech(
      result => received.push(result),
      undefined,
      { finishOnFinalResult: true },
    )
    assert.ok(session)
    assert.equal(recognition.continuous, true)
    recognition.onresult?.({
      results: [Object.assign([{ transcript: 'Hey Arney, add milk' }], { isFinal: false })],
    })
    assert.deepEqual(received, [], 'interim speech must not submit commands')
    recognition.onresult?.({
      results: [Object.assign([{ transcript: 'Hey Arney, add milk to groceries' }], { isFinal: true })],
    })
    assert.deepEqual(received, [{ kind: 'transcript', text: 'Hey Arney, add milk to groceries' }])
    assert.equal(aborts, 1)
    recognition.onend?.()
    assert.equal(received.length, 1, 'a late browser end cannot resubmit')
  } finally {
    globalThis.window = original
  }
})

test('push-to-talk still waits for release when Chrome reports a final result', async () => {
  const { beginArneySpeech } = await import('../src/arneySpeech.ts')
  const original = globalThis.window
  let recognition
  globalThis.window = {
    SpeechRecognition: class {
      constructor() { recognition = this }
      start() {}
      stop() { this.onend?.() }
      abort() {}
    },
  }
  try {
    const received = []
    const session = beginArneySpeech(result => received.push(result))
    assert.equal(recognition.continuous, false)
    recognition.onresult?.({
      results: [Object.assign([{ transcript: 'What is on the calendar today?' }], { isFinal: true })],
    })
    assert.deepEqual(received, [], 'push-to-talk must wait for release')
    session.stop()
    assert.deepEqual(received, [{ kind: 'transcript', text: 'What is on the calendar today?' }])
  } finally {
    globalThis.window = original
  }
})
