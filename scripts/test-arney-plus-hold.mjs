import test from 'node:test'
import assert from 'node:assert/strict'
import { createArneyPlusHoldController } from '../src/arneyPlusHold.ts'

function setup(beginOverride) {
  let timerId = 0
  const timers = new Map()
  const calls = { begin: 0, hold: 0, finished: [], canceled: 0, stop: 0, abort: 0 }
  let speechResult = null
  const controller = createArneyPlusHoldController({
    delayMs: 225,
    schedule: callback => {
      const id = ++timerId
      timers.set(id, callback)
      return id
    },
    clear: id => timers.delete(id),
    begin: onResult => {
      calls.begin += 1
      speechResult = onResult
      if (beginOverride) return beginOverride(onResult, calls)
      return { stop: () => { calls.stop += 1 }, cancel: () => { calls.abort += 1 } }
    },
    onHold: () => { calls.hold += 1 },
    onFinished: result => calls.finished.push(result),
    onCanceled: () => { calls.canceled += 1 },
  })
  const advance = () => {
    const pending = Array.from(timers.values())
    timers.clear()
    pending.forEach(callback => callback())
  }
  return { controller, calls, advance, timers, result: r => speechResult?.(r) }
}

test('default deliberate-hold threshold is 225ms', () => {
  let delay=null
  const controller=createArneyPlusHoldController({
    schedule:(_callback,value)=>{delay=value;return 1},clear:()=>{},
    begin:()=>null,onHold:()=>{},onFinished:()=>{},onCanceled:()=>{},
  })
  controller.down(1)
  assert.equal(delay,225)
  controller.destroy()
})

test('short tap keeps normal Quick Add and never starts microphone', () => {
  const t = setup()
  t.controller.down(1)
  t.controller.up(1)
  t.advance()
  assert.equal(t.calls.hold, 0)
  assert.equal(t.calls.begin, 0)
  assert.deepEqual(t.calls.finished, [])
  assert.equal(t.controller.consumeClick(), false)
})

test('hold starts speech, buffers early transcript, then reviews on release', () => {
  const t = setup()
  t.controller.down(2)
  t.advance()
  assert.equal(t.calls.hold, 1)
  assert.equal(t.calls.begin, 1)
  t.result({ kind: 'transcript', text: 'Move my appointment tomorrow' })
  assert.deepEqual(t.calls.finished, [])
  t.controller.up(2)
  assert.deepEqual(t.calls.finished, [{ kind: 'transcript', text: 'Move my appointment tomorrow' }])
  assert.equal(t.calls.abort, 1)
  assert.equal(t.controller.consumeClick(), true)
  assert.equal(t.controller.consumeClick(), false)
})

test('release requests stop and accepts one final asynchronous transcript', () => {
  const t = setup()
  t.controller.down(3)
  t.advance()
  t.controller.up(3)
  assert.equal(t.calls.stop, 1)
  assert.deepEqual(t.calls.finished, [])
  t.result({ kind: 'transcript', text: 'Read my calendar' })
  t.result({ kind: 'transcript', text: 'Read my calendar again' })
  assert.deepEqual(t.calls.finished, [{ kind: 'transcript', text: 'Read my calendar' }])
})

test('pointer cancellation stops speech without opening a review or submitting words', () => {
  const t = setup()
  t.controller.down(4)
  t.advance()
  t.controller.cancel(4)
  t.result({ kind: 'transcript', text: 'Do not send' })
  assert.equal(t.calls.abort, 1)
  assert.equal(t.calls.canceled, 1)
  assert.deepEqual(t.calls.finished, [])
  assert.equal(t.controller.consumeClick(), true)
})

test('an unrelated finger cannot finish the active hold', () => {
  const t = setup()
  t.controller.down(5)
  t.advance()
  t.controller.up(6)
  assert.equal(t.calls.stop, 0)
  t.controller.up(5)
  assert.equal(t.calls.stop, 1)
})

test('browser unavailable / consent refusal only returns a safe error after release', () => {
  const t = setup(onResult => {
    onResult({ kind: 'error', reason: 'speech-consent-required' })
    return null
  })
  t.controller.down(7)
  t.advance()
  assert.deepEqual(t.calls.finished, [])
  t.controller.up(7)
  assert.deepEqual(t.calls.finished, [{ kind: 'error', reason: 'speech-consent-required' }])
})

test('destroy during held speech ignores late results and cancels microphone', () => {
  const t = setup()
  t.controller.down(8)
  t.advance()
  t.controller.destroy()
  t.result({ kind: 'transcript', text: 'stale' })
  assert.deepEqual(t.calls.finished, [])
  assert.equal(t.calls.abort, 1)
})

test('a canceled short touch does not leak into Quick Add or start recognition', () => {
  const t = setup()
  t.controller.down(9)
  t.controller.cancel(9)
  t.advance()
  assert.equal(t.calls.begin, 0)
  assert.equal(t.controller.consumeClick(), true)
  assert.deepEqual(t.calls.finished, [])
})

