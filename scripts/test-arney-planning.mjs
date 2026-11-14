import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planArneyReadOnlyRequest } from '../src/arneyPlanning.mjs'

const now = new Date(2026, 10, 13, 12)
const people = [{ id: 2, name: 'Robert' }, { id: 3, name: 'Haylee' }]
const event = (id, date, title, time = null, endTime = null, assigned = [people[0]]) =>
  ({ id, date, title, time, endTime, people: assigned })
const base = {
  now, activePersonId: 2, recipes: [], mealPlanItems: [], mealPlans: [],
  events: [],
  occurrenceStartForDate: (e, day) => e.date === day ? e.date : null,
}
const plan = (text, input = {}) => planArneyReadOnlyRequest(text, { ...base, ...input })

test('weekly family schedule includes verified events, people and exact week', () => {
  const result = plan("What's on our family calendar this week?", {
    events: [event(10, '2026-11-13', 'Dentist', '14:00', '15:00')],
  })
  assert.equal(result.kind, 'information')
  assert.match(result.text, /Family calendar/)
  assert.match(result.text, /Fri, 11\/13: Dentist at 14:00 — Robert/)
  assert.doesNotMatch(result.text, /Nothing was changed|Read-only|Local household|cross-household shares/i)
})

test('no events is read-only and does not invent entries', () => {
  const result = plan('Show our family schedule this week')
  assert.match(result.text, /no matching events found/)
  assert.doesNotMatch(result.text, /Dentist/)
})

test('your own schedule uses active profile, not other people', () => {
  const events = [
    event(1, '2026-11-13', 'Mine'),
    event(2, '2026-11-13', 'Not mine', null, null, [people[1]]),
  ]
  const result = plan('Show my calendar this week', { events })
  assert.match(result.text, /Mine/)
  assert.doesNotMatch(result.text, /Not mine/)
  assert.match(plan('Show my calendar this week', { events, activePersonId: null }).text, /Select your personal profile/)
})

test('next week uses actual following Sunday through Saturday', () => {
  const result = plan('Show our schedule next week', {
    events: [event(1, '2026-11-15', 'Sunday outing'), event(2, '2026-11-13', 'Not next week')],
  })
  assert.match(result.text, /Sunday outing/)
  assert.doesNotMatch(result.text, /Not next week/)
})

test('multi-day and recurring occurrences are delegated to app calendar logic and deduplicated', () => {
  const weekend = event(1, '2026-11-12', 'Weekend visit')
  const repeating = event(2, '2026-11-06', 'Recurring meeting')
  const result = plan('Show our schedule this week', {
    events: [weekend, repeating],
    occurrenceStartForDate: (e, day) =>
      e.id === 1 && ['2026-11-12', '2026-11-13', '2026-11-14'].includes(day)
        ? '2026-11-12'
        : e.id === 2 && day === '2026-11-13' ? '2026-11-13' : null,
  })
  assert.equal(result.text.split('Weekend visit').length - 1, 1)
  assert.match(result.text, /Recurring meeting/)
})

test('overlapping timed entries are reported as possible, not guaranteed conflicts', () => {
  const result = plan('Check our calendar for conflicts this week', {
    events: [
      event(1, '2026-11-13', 'A', '10:00', '11:00'),
      event(2, '2026-11-13', 'B', '10:30', '11:30'),
    ],
  })
  assert.match(result.text, /Possible schedule overlaps/)
  assert.match(result.text, /Both involve: Robert/)
  assert.match(result.text, /not confirmed conflicts/)
})

test('different people overlapping is clearly labeled without claiming conflict', () => {
  const result = plan('Are there overlapping events this week', {
    events: [
      event(1, '2026-11-13', 'A', '10:00', '11:00'),
      event(2, '2026-11-13', 'B', '10:30', '11:30', [people[1]]),
    ],
  })
  assert.match(result.text, /Different assignees/)
})

test('missing end times never cause a false all-clear', () => {
  const result = plan('Check for conflicts this week', {
    events: [event(1, '2026-11-13', 'Unfinished', '10:00', null)],
  })
  assert.match(result.text, /without complete times/)
})

test('end-to-start touching times do not overlap', () => {
  const result = plan('Check for conflicts this week', {
    events: [
      event(1, '2026-11-13', 'A', '10:00', '11:00'),
      event(2, '2026-11-13', 'B', '11:00', '12:00'),
    ],
  })
  assert.match(result.text, /No overlapping timed event pairs/)
})

test('dinner ideas use only saved recipes, preserve existing plans, and never save', () => {
  const result = plan('Suggest five dinners from our recipes', {
    recipes: [
      { name: 'Fajitas', favorite: true },
      { name: 'Chicken rice', favorite: false },
      { name: 'Fajitas', favorite: false },
    ],
    mealPlanItems: [{ date: '2026-11-13', mealType: 'dinner', title: 'Pizza' }],
  })
  assert.match(result.text, /Already planned — Pizza/)
  assert.match(result.text, /Suggested — Fajitas/)
  assert.match(result.text, /Suggested — Chicken rice/)
  assert.equal(result.text.split('Suggested — Fajitas').length - 1, 1)
  assert.doesNotMatch(result.text, /No meal plans or shopping lists were changed|draft only|Read-only/i)
})

test('no saved recipes reports the limitation', () => {
  const result = plan('Plan dinners for next week')
  assert.match(result.text, /No saved recipes are available/)
})

test('online research, writes, and unrelated questions are never mistaken for plan tools', () => {
  assert.equal(plan('Find dinner recipes online this week'), null)
  assert.equal(plan('Schedule dinner this week'), null)
  assert.equal(plan('Cancel my meeting this week'), null)
  assert.equal(plan('What is the weather tomorrow?'), null)
})

test('planning code contains no fetch, persistence, or model calls', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = fs.readFileSync(path.join(root, 'src/arneyPlanning.mjs'), 'utf8')
  assert.doesNotMatch(source, /\b(?:fetch|localStorage|indexedDB|writeFile|\.run\(|ollama|axios)\s*\(/)
})


test('legacy dinner plans are preserved, not overwritten by suggestions', () => {
  const result = plan('Plan dinners for next week', {
    recipes: [{ name: 'Fajitas', favorite: true }],
    mealPlans: [{ date: '2026-11-15', dinner: 'Pasta' }],
  })
  assert.match(result.text, /Already planned — Pasta/)
  assert.match(result.text, /Suggested — Fajitas/)
})

test('current Arney text and voice routes use planning without saving anything', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
  assert.match(app, /import \{ planArneyReadOnlyRequest \} from '\.\/arneyPlanning\.mjs'/)
  assert.match(app, /const planningReply = planArneyReadOnlyRequest\(command/)
  assert.match(app, /occurrenceStartForDate: getOccurrenceStartForDate/)
  const first = app.indexOf('const planningReply = planArneyReadOnlyRequest')
  const next = app.indexOf('setAiCommandLoading(true)', first)
  assert.ok(first > 0 && next > first)
  assert.doesNotMatch(app.slice(first, next), /fetch\(|\.save\(|\.post\(/)
  assert.match(app, /whiteSpace: 'pre-wrap'/)
})


test('Ask Arney option exposes typed entry without replacing hold-to-talk', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
  assert.match(app, /className="quick-add-option quick-add-arney-option"/)
  const open = app.slice(app.indexOf('className="quick-add-option quick-add-arney-option"'),
    app.indexOf('className="quick-add-option quick-add-arney-option"') + 1200)
  assert.match(open, /setQuickAddOpen\(false\)/)
  assert.match(open, /setAiVoiceDirect\(false\)/)
  assert.match(open, /setAiCommandText\(''\)/)
  assert.match(open, /setAiCommandOpen\(true\)/)
  assert.match(app, /function startCalendarAddHold/)
  assert.match(app, /openArneyVoiceDraft\(transcript\)/)
  assert.match(app, /aria-label="Ask Arney a question or request"/)
  assert.match(app, /Type a question or request\./)
  assert.match(app, /className="arney-conversation-name"/)
})

test('entire app uses self-hosted Nunito with fallback and an included open license', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const index = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8')
  const appCss = fs.readFileSync(path.join(root, 'src/App.css'), 'utf8')
  assert.match(index, /font-family: 'Nunito'/)
  assert.match(index, /font-family: var\(--family-calendar-font\)/)
  assert.match(appCss, /font-family: var\(--family-calendar-font/)
  assert.doesNotMatch(index, /https?:\/\/fonts\.(?:googleapis|gstatic)\.com/)
  for (const name of [
    'nunito-latin-wght-normal.woff2',
    'nunito-latin-wght-italic.woff2',
    'nunito-latin-ext-wght-normal.woff2',
    'nunito-latin-ext-wght-italic.woff2',
  ]) {
    const file = fs.readFileSync(path.join(root, 'public/fonts', name))
    assert.equal(file.subarray(0, 4).toString('ascii'), 'wOF2')
    assert.ok(file.length > 10000)
    assert.ok(index.includes('/fonts/' + name))
  }
  const license = fs.readFileSync(path.join(root, 'public/fonts/Nunito-OFL-LICENSE.txt'), 'utf8')
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/)
})


test('blue plus uses seven ordered compact rows matching the approved mockup', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'src/App.css'), 'utf8')
  const first = app.indexOf('{quickAddOpen &&')
  const last = app.indexOf('{captureOpen &&', first)
  assert.ok(first > 0 && last > first)
  const block = app.slice(first, last)
  assert.match(block, /className="quick-add-sheet quick-add-actions-sheet"/)
  assert.deepEqual([...block.matchAll(/<strong>(Add Event|Add List Item|Add Recipe|Analyze Photo|Take Photo|Settings|Ask Arney)<\/strong>/g)]
    .map(match => match[1]), [
      'Add Event', 'Add List Item', 'Add Recipe', 'Analyze Photo', 'Take Photo', 'Settings', 'Ask Arney',
    ])
  assert.match(css, /\.quick-add-actions-sheet \.quick-add-options \{/)
  assert.match(css, /flex-direction: column;/)
  assert.match(css, /\.quick-add-sheet\.quick-add-actions-sheet \{/)
  assert.match(css, /\.quick-add-actions-sheet \.quick-add-option-text small \{\s*display: none;/)
  assert.match(app, /function startCalendarAddHold/)
})

test('spoken daily question reads only today and never falls back to cancel/move', () => {
  const result = plan("What's on our calendar today?", {
    events: [
      event(1, '2026-11-13', 'Shift change', '07:00', '08:00'),
      event(2, '2026-11-14', 'Tomorrow dinner', '18:00'),
    ],
  })
  assert.equal(result.kind, 'information')
  assert.match(result.text, /Family calendar \(Fri, 11\/13\):/)
  assert.match(result.text, /Shift change/)
  assert.doesNotMatch(result.text, /Tomorrow dinner/)
  assert.doesNotMatch(result.text, /Nothing was changed|Read-only|Local household|cross-household shares/i)
})

test('common voice variants including Hey Arney and a read without calendar noun', () => {
  const events = [event(1, '2026-11-13', 'School pickup', '15:00')]
  for (const phrase of [
    'Hey Arney, what is on our calendar today?',
    'Hey Arney, what’s on our calendar today?',
    'What do we have today?',
    'Show me the events today',
    "What's going on today?",
    "What's on my schedule today?",
  ]) {
    const answer = plan(phrase, { events })
    assert.ok(answer, 'unrecognized voice read: ' + phrase)
    assert.match(answer.text, /School pickup/, phrase)
  }
})

test('tomorrow reads a different date and respects recurring occurrences', () => {
  const answer = plan('What do we have tomorrow?', {
    events: [event(1, '2026-11-13', 'Today'), event(2, '2026-11-07', 'Recurring workout')],
    occurrenceStartForDate: (entry, date) =>
      entry.id === 2 && date === '2026-11-14' ? date : entry.date === date ? date : null,
  })
  assert.match(answer.text, /Sat, 11\/14/)
  assert.match(answer.text, /Recurring workout/)
  assert.doesNotMatch(answer.text, /Today/)
})

test('weekend spans Saturday and Sunday even when the dates cross weeks', () => {
  const events = [
    event(1, '2026-11-13', 'Friday'),
    event(2, '2026-11-14', 'Saturday'),
    event(3, '2026-11-15', 'Sunday'),
    event(4, '2026-11-21', 'Next Saturday'),
  ]
  const thisWeekend = plan("What's on our calendar this weekend?", { events })
  assert.match(thisWeekend.text, /Saturday/)
  assert.match(thisWeekend.text, /Sunday/)
  assert.doesNotMatch(thisWeekend.text, /Friday/)
  assert.doesNotMatch(thisWeekend.text, /Next Saturday/)
  const nextWeekend = plan('Show our schedule next weekend', { events })
  assert.match(nextWeekend.text, /Next Saturday/)
  assert.doesNotMatch(nextWeekend.text, /Sunday/)
})

test('this weekend on Sunday still includes yesterday Saturday', () => {
  const answer = plan("What's our schedule this weekend?", {
    now: new Date(2026, 10, 15, 12),
    events: [event(1, '2026-11-14', 'Saturday plans'), event(2, '2026-11-15', 'Sunday plans')],
  })
  assert.match(answer.text, /Saturday plans/)
  assert.match(answer.text, /Sunday plans/)
})

test('daily personal schedule requires selection and excludes others', () => {
  const events = [
    event(1, '2026-11-13', 'My event'),
    event(2, '2026-11-13', 'Other event', null, null, [people[1]]),
  ]
  assert.match(plan("What's on my calendar today?", { events, activePersonId: null }).text, /Select your personal profile/)
  const own = plan('Show my schedule today', { events })
  assert.match(own.text, /My event/)
  assert.doesNotMatch(own.text, /Other event/)
})

test('daily empty schedule is explicit rather than a generic calendar edit limitation', () => {
  const answer = plan("What's on our calendar today?", {
    events: [event(1, '2026-11-14', 'Not today')],
  })
  assert.match(answer.text, /no matching events found for Fri, 11\/13/)
  assert.doesNotMatch(answer.text, /Not today/)
})

test('daily query tool refuses weather, mutations, and unrelated work', () => {
  assert.equal(plan('What is the weather today?'), null)
  assert.equal(plan('Add an event today'), null)
  assert.equal(plan('Cancel my appointment today'), null)
  assert.equal(plan('Can you book my dentist appointment today?'), null)
})

test('voice reply retains the on-screen transcript without auto-saving it', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
  assert.match(app, /onFinished: result =>/)
  assert.match(app, /void submitAiCommand\(transcript\)/)
  assert.match(app, /aiVoiceDirect && aiCommandText\.trim\(\) !== ''/)
  assert.match(app, /You said:/)
  assert.match(app, /aria-label="Words Arney heard"/)
  assert.match(app, /className="arney-voice-heard"/)
})

test('calendar answers stay concise without technical notes across date scopes', () => {
  const events = [
    event(1, '2026-11-13', 'Work', '07:00'),
    event(2, '2026-11-14', 'Family time', '11:00'),
  ]
  for (const query of [
    "What's on our calendar today?",
    "What's on our calendar tomorrow?",
    "What's on our calendar this week?",
    "What's on our calendar this weekend?",
    "Show my schedule today",
  ]) {
    const result = plan(query, { events })
    assert.equal(result?.kind, 'information', query)
    assert.doesNotMatch(result.text,
      /local household|cross-household|not shared|read-only|nothing was changed/i, query)
    assert.match(result.text, /calendar/, query)
  }
})

test('empty days do not add warnings about sharing or changing data', () => {
  const answer = plan("What's on our calendar today?")
  assert.match(answer.text, /no matching events found/i)
  assert.doesNotMatch(answer.text,
    /local household|cross-household|read-only|nothing was changed/i)
})

test('conflict and dinner replies avoid repetitive status boilerplate', () => {
  const conflict = plan('Check our calendar for conflicts this week')
  const meal = plan('Plan dinners for next week', {
    recipes: [{ name: 'Chicken tacos' }],
  })
  for (const result of [conflict, meal]) {
    assert.equal(result.kind, 'information')
    assert.doesNotMatch(result.text,
      /local household|cross-household|read-only|nothing was changed|no meal plans or shopping lists were changed/i)
  }
  assert.match(conflict.text, /without complete times/)
  assert.match(meal.text, /Suggested — Chicken tacos/)
})

test('Analyze Photo opens native file chooser directly, camera asks for rear camera, and selection is reviewed before analysis', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
  const css = fs.readFileSync(path.join(root, 'src/App.css'), 'utf8')
  const menu = app.slice(app.indexOf('{quickAddOpen &&'), app.indexOf('{captureOpen &&'))
  const modal = app.slice(app.indexOf('{captureOpen &&'), app.indexOf('{multiEventReview &&'))
  assert.match(menu, /onClick=\{\(\) => openQuickAddCapturePicker\('photo'\)\}/)
  assert.match(menu, /onClick=\{\(\) => openQuickAddCapturePicker\('camera'\)\}/)
  assert.match(app, /ref=\{capturePhotoInputRef\}/)
  assert.match(app, /ref=\{captureCameraInputRef\}/)
  assert.match(app, /capture="environment"/)
  assert.match(app, /accept="image\/\*"/)
  assert.match(app, /input\.click\(\)/)
  assert.match(app, /event\.currentTarget\.value = ''/)
  assert.match(app, /if \(!file\) return \/\/ Native picker\/camera was dismissed/)
  assert.match(app, /await prepareCaptureImage\(file\)/)
  assert.match(app, /setCaptureOpen\(true\)/)
  assert.match(css, /\.capture-picker-hidden-input \{/)
  assert.doesNotMatch(menu, /setCaptureOpen\(true\)/)
  assert.match(modal, /<h2>Review Photo<\/h2>/)
  assert.match(modal, /className="capture-preview"/)
  assert.match(modal, /void analyzeQuickAddPhoto\(\)/)
  assert.match(modal, /disabled=\{\s*captureFile === null \|\|\s*captureSaving/)
  assert.doesNotMatch(modal, /View Capture Inbox|type="file"|setPage\('capture'\)/)
})

test('existing Capture Inbox data and APIs remain intact despite removing popup button', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
  assert.match(app, /async function loadCaptureInbox\(\)/)
  assert.match(app, /page === 'capture'/)
  assert.match(app, /function openCaptureDestination\(/)
  assert.match(app, /function openCapturedEventForReview\(/)
  assert.match(app, /async function analyzeQuickAddPhoto\(\)/)
})
