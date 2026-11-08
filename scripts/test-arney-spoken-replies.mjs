import test from 'node:test'
import assert from 'node:assert/strict'
import {
  describeArneyError, describeArneyIntent, describeArneyPreview,
  shouldSpeakArneyReply,
} from '../src/arneyResponses.ts'
import { speakArneyReply, stopArneyReply } from '../src/arneySpeech.ts'

test('response mode respects always, when needed and silent', () => {
  for (const kind of ['information', 'clarification', 'confirmation', 'success', 'error']) {
    assert.equal(shouldSpeakArneyReply('always', kind), true)
    assert.equal(shouldSpeakArneyReply('silent', kind), false)
  }
  assert.equal(shouldSpeakArneyReply('needed', 'information'), false)
  assert.equal(shouldSpeakArneyReply('needed', 'clarification'), true)
  assert.equal(shouldSpeakArneyReply('needed', 'confirmation'), true)
  assert.equal(shouldSpeakArneyReply('needed', 'success'), true)
  assert.equal(shouldSpeakArneyReply('needed', 'error'), true)
})

test('unsupported intents give a practical response without inventing a write', () => {
  for (const value of ['create_event', 'add_list_item', 'other', undefined]) {
    const reply = describeArneyIntent(value)
    assert.equal(reply.kind, 'information')
    assert.match(reply.text, /can|not connected|currently/i)
    assert.ok(!reply.text.includes('not_wired_yet'))
  }
})

test('ready cancellation describes a manual confirmation, never a completed deletion', () => {
  const reply = describeArneyPreview('cancel_event', {
    status: 'ready_for_confirmation',
    count: 1,
    matches: [{ title: 'Dentist', date: '2026-11-10', time: '14:00' }],
  })
  assert.equal(reply.kind, 'confirmation')
  assert.match(reply.text, /Dentist/)
  assert.match(reply.text, /2026-11-10/)
  assert.match(reply.text, /Nothing has changed yet/i)
  assert.ok(!reply.text.includes('{"'))
})

test('ambiguous event selection must not claim a unique match', () => {
  const reply = describeArneyPreview('move_event', {
    status: 'needs_clarification',
    reason: 'multiple_matching_events',
    count: 2,
    matches: [{title: 'A'}, {title: 'B'}],
  })
  assert.equal(reply.kind, 'clarification')
  assert.match(reply.text, /multiple/i)
  assert.doesNotMatch(reply.text, /Nothing has changed yet/)
})

test('missing event/date/target and no-match prompt for details', () => {
  assert.match(describeArneyPreview('cancel_event', {
    status: 'needs_clarification', count: 0, matches: [], criteria: {title: 'Dentist'},
  }).text, /date/i)
  assert.match(describeArneyPreview('move_event', {
    status: 'needs_clarification', reason: 'missing_requested_change',
    count: 0, matches: [],
  }).text, /date or time/i)
  assert.match(describeArneyPreview('move_event', {
    status: 'no_match', count: 0, matches: [],
  }).text, /could not find/i)
})

test('unrecognized/invalid previews and API errors fail safely', () => {
  const invalid = describeArneyPreview('move_event', null)
  assert.equal(invalid.kind, 'error')
  assert.match(invalid.text, /No change was made/i)
  const corrupted = describeArneyPreview('cancel_event', {status:'ready_for_confirmation', matches:[]})
  assert.equal(corrupted.kind, 'error')
  assert.match(corrupted.text, /No changes have been made/i)
  assert.equal(describeArneyError().kind, 'error')
})

test('speech synthesis has a visible fallback when unavailable, and can be stopped', () => {
  const originalWindow = globalThis.window
  const originalUtterance = globalThis.SpeechSynthesisUtterance
  const events = []
  try {
    globalThis.window = undefined
    assert.equal(speakArneyReply('Hello'), false)
    stopArneyReply()
    globalThis.window = {
      speechSynthesis: {
        cancel: () => events.push('cancel'),
        speak: utterance => events.push(['speak', utterance.text]),
      },
    }
    globalThis.SpeechSynthesisUtterance = class {
      constructor(text) { this.text = text }
    }
    assert.equal(speakArneyReply('Event found. Please confirm.'), true)
    assert.deepEqual(events, ['cancel', ['speak', 'Event found. Please confirm.']])
    stopArneyReply()
    assert.equal(events.at(-1), 'cancel')
  } finally {
    globalThis.window = originalWindow
    globalThis.SpeechSynthesisUtterance = originalUtterance
  }
})

test('speech synthesis failure does not prevent readable response', () => {
  const originalWindow = globalThis.window
  const originalUtterance = globalThis.SpeechSynthesisUtterance
  try {
    globalThis.window = { speechSynthesis: { cancel: () => {}, speak: () => { throw Error('blocked') } } }
    globalThis.SpeechSynthesisUtterance = class {
      constructor(text) { this.text = text }
    }
    assert.equal(speakArneyReply('Hello'), false)
    assert.ok(describeArneyIntent('other').text.length > 20)
  } finally {
    globalThis.window = originalWindow
    globalThis.SpeechSynthesisUtterance = originalUtterance
  }
})
