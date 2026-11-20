import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeEmojiMarkerPayload, emojiMarkerOccursOnDate } from '../Server/emoji-marker-rules.mjs'

const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const editor = fs.readFileSync(new URL('../src/EmojiCalendarMarkers.tsx', import.meta.url), 'utf8')
const css = fs.readFileSync(new URL('../src/EmojiCalendarMarkers.css', import.meta.url), 'utf8')

test('normal Add Event has an accessible top-right Icon Only switch', () => {
  assert.match(app, /event-modal-heading-row.*event-add-mode-heading/s)
  assert.match(app, /event-icon-only-toggle/)
  assert.match(app, /role="switch" aria-label="Icon Only"/)
  assert.match(app, /checked=\{iconOnlyMode\}/)
  assert.match(css, /\.event-modal-heading-row\.event-add-mode-heading/)
})

test('icon-only form is separate from event submission, and normal Add Event remains', () => {
  assert.match(app, /iconOnlyMode \? \(\s*<EmojiMarkerEventForm/)
  assert.match(app, /className="event-form"\s+onSubmit=\{addOrUpdateEvent\}/)
  assert.match(editor, /onSubmit=\{\(event\) => void save\(event\)\}/)
  assert.match(editor, /markerRequest\(\s*editing \? '\/api\/emoji-markers\/'/)
  assert.doesNotMatch(editor, /fetch\(['"\`]\/api\/events/)
  assert.match(app, /setIconOnlyMode\(false\)/)
})

test('date corner only edits existing markers, creation comes through Add Event', () => {
  assert.match(editor, /if \(!visible\.length\) return null/)
  assert.match(app, /onOpen=\{openIconOnlyFromMonth\}/)
  assert.match(app, /setIconMarkerManageExisting\(true\)/)
  assert.doesNotMatch(app, /EmojiMarkerEditor/)
})

test('payday and icons remain independent of event fields', () => {
  const payday = normalizeEmojiMarkerPayload({
    date: '2026-11-12', emoji: '💵', label: 'Payday',
    repeatUnit: 'week', repeatInterval: 2, repeatWeekdays: [4],
  })
  assert.ok(payday)
  assert.equal(emojiMarkerOccursOnDate(payday, '2026-11-26'), true)
  assert.equal(emojiMarkerOccursOnDate(payday, '2026-12-03'), false)
  assert.match(editor, /Entire repeating series/)
  assert.match(editor, /Remove this & future/)
})
