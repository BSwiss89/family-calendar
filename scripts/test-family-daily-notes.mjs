import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createDailyFamilyNotesHandlers } from '../Server/daily-family-notes.mjs'

function call(handler, body = undefined, familyAccount = { user_id: 1 }) {
  const reply = {
    statusCode: 200,
    headers: {},
    set(name, value) { this.headers[name] = value; return this },
    status(value) { this.statusCode = value; return this },
    json(value) { this.data = value; return this },
  }
  handler({ body, familyAccount }, reply)
  return reply
}

test('all authenticated profiles in one household see the same temporary note', () => {
  const notes = createDailyFamilyNotesHandlers({ now: () => new Date('2026-11-12T18:00:00Z') })
  const initial = call(notes.read)
  assert.deepEqual(initial.data, { day: '2026-11-12', text: '', revision: 0 })
  const changed = call(notes.write, { text: 'Dinner at 6', day: initial.data.day, revision: 0 })
  assert.equal(changed.statusCode, 200)
  assert.equal(changed.data.revision, 1)
  const otherProfile = call(notes.read, undefined, { user_id: 2 })
  assert.equal(otherProfile.data.text, 'Dinner at 6')
  assert.equal(otherProfile.headers['Cache-Control'], 'no-store')
})

test('anonymous access is denied, even if parent auth middleware is disabled', () => {
  const notes = createDailyFamilyNotesHandlers()
  assert.equal(call(notes.read, undefined, undefined).statusCode, 200)
  assert.equal(call(notes.read, undefined, null).statusCode, 401)
  assert.equal(call(notes.write, { text: 'no', day: '2026-11-12', revision: 0 }, null).statusCode, 401)
})

test('stale revision cannot overwrite another family member; unsafe and oversized text rejected', () => {
  const notes = createDailyFamilyNotesHandlers({ now: () => new Date('2026-11-12T18:00:00Z') })
  const base = call(notes.read).data
  assert.equal(call(notes.write, { text: 'A', ...{ day: base.day, revision: 0 } }).statusCode, 200)
  const conflict = call(notes.write, { text: 'B', day: base.day, revision: 0 }, { user_id: 3 })
  assert.equal(conflict.statusCode, 409)
  assert.equal(call(notes.read).data.text, 'A')
  assert.equal(call(notes.write, { text: 'x'.repeat(1201), day: base.day, revision: 1 }).statusCode, 400)
  assert.equal(call(notes.write, { text: 'control\u0000', day: base.day, revision: 1 }).statusCode, 400)
})

test('note clears at midnight America/Chicago, and prior-day writes are refused', () => {
  let time = new Date('2026-11-13T05:59:59Z') // Nov 12 11:59:59 PM CST
  const notes = createDailyFamilyNotesHandlers({ now: () => time })
  const previous = call(notes.read).data
  assert.equal(previous.day, '2026-11-12')
  call(notes.write, { text: 'Yesterday', day: previous.day, revision: 0 })
  time = new Date('2026-11-13T06:00:00Z') // Nov 13 midnight CST
  const newDay = call(notes.read)
  assert.deepEqual(newDay.data, { day: '2026-11-13', text: '', revision: 0 })
  assert.equal(call(notes.write, { text: 'Old', day: previous.day, revision: 1 }).statusCode, 409)
  assert.equal(call(notes.read).data.text, '')
})

test('server process restart and a second household process preserve no prior note history', () => {
  const now = () => new Date('2026-11-12T18:00:00Z')
  const familyA = createDailyFamilyNotesHandlers({ now })
  call(familyA.write, { text: 'No file is created', day: '2026-11-12', revision: 0 })
  const familyB = createDailyFamilyNotesHandlers({ now })
  assert.equal(call(familyB.read).data.text, '')
  const restarted = createDailyFamilyNotesHandlers({ now })
  assert.equal(call(restarted.read).data.text, '')
})

test('Home and Quick Add integration preserves four original tiles and separate widget sizes', () => {
  const app = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const styles = fs.readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
  const notes = fs.readFileSync(new URL('../src/FamilyDailyNotes.tsx', import.meta.url), 'utf8')
  const noteStyles = fs.readFileSync(new URL('../src/FamilyDailyNotes.css', import.meta.url), 'utf8')
  assert.match(app, /<FamilyDailyNotes disabled=\{isEditingHome\}/)
  assert.match(app, /quick-add-option quick-add-settings-option/)
  assert.doesNotMatch(app, /className="home-mobile-settings-button"/)
  for (const item of ['Event', 'List', 'Recipe', 'Photo / Screenshot']) {
    assert.ok(app.includes(`<strong>${item}</strong>`), `${item} Quick Add action remains`)
  }
  assert.match(styles, /min-height: 112px/)
  assert.match(styles, /quick-add-option\.quick-add-settings-option/)
  assert.match(styles, /home-widget-grid:not\(\.home-widget-grid-editing\).*home-widget:not/)
  assert.match(notes, /Share changes/)
  assert.match(notes, /ResizeObserver\(fitFont\)/)
  assert.match(notes, /function fitNoteFont/)
  assert.doesNotMatch(notes, /Shared today · clears at midnight or server restart/)
  assert.doesNotMatch(noteStyles, /family-daily-notes-bottom/)
  assert.match(noteStyles, /max-height: none/)
  assert.match(noteStyles, /resize: none/)
  assert.match(noteStyles, /home-widget-notes > \.family-daily-notes/)
  assert.doesNotMatch(notes, /localStorage|sessionStorage/)
})
