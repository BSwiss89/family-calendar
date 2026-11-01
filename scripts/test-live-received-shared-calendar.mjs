import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
  .replaceAll(String.fromCharCode(13, 10), String.fromCharCode(10))
const app = source('../src/App.tsx')
const feed = source('../src/useSharedEventFeed.ts')
const detail = source('../src/SharedEventDetails.tsx')
const overlay = source('../src/SharedEventsOverlay.css')

test('read-only accepted shares are never inserted into editable local events', () => {
  assert.match(app, /const receivedSharedEvents = useSharedEventFeed\(page === 'calendar'\)/)
  assert.match(app, /const \[events, setEvents\] = useState<CalendarEvent\[]>\(\[\]\)/)
  assert.doesNotMatch(app, /setEvents\(receivedSharedEvents\)/)
  assert.match(feed, /parseAcceptedSharedEvents\(data\)/)
  assert.match(feed, /setEvents\(\[\]\)/)
  assert.match(feed, /family-calendar:shared-events-changed/)
  assert.match(feed, /visibilitychange/)
})
test('accepted shares show in month week day and mobile and desktop schedule', () => {
  for (const marker of ['sharedEventsForDay.slice(0, 1)','shared-week-event',
    'day-summary-received-event','shared-mobile-event-group',
    'shared-schedule-timed-event','shared-schedule-event',
    'getScheduleTimedEventLayouts(\n    targetDate, true',
    'getScheduleTimedEventLayouts(\n    scheduleDay, true']) {
    assert.ok(app.includes(marker), 'Missing overlay: ' + marker)
  }
  assert.match(app, /sharedEvent: AcceptedSharedEvent \| null/)
  assert.match(overlay, /month-shared-event-chip/)
})
test('read-only details remove only received grant never sender event', () => {
  assert.match(app, /<SharedEventDetails event=\{selectedReceivedEvent\} onClose=\{closeReceivedDetails\} \/>/)
  assert.match(detail, /\/api\/shared-events\//)
  assert.match(detail, /\/received/)
  assert.doesNotMatch(detail, /\/api\/events\//)
  assert.match(detail, /Read only/)
})
test('LIVE Lists, duplicate action, and stacked household UI are retained', () => {
  for (const marker of ['<FamilyEventSharing event={viewingCalendarEvent} />',
    'const invitationInbox = useInvitationInbox()', 'storeSortingEnabled',
    'makeEventDuplicateDraft', "page === 'householdMembers'", "page === 'invitations'"]) {
    assert.ok(app.includes(marker), marker)
  }
})
