import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
const sharing = fs.readFileSync(path.join(root, 'src/FamilyEventSharing.tsx'), 'utf8')
const css = fs.readFileSync(path.join(root, 'src/FamilyEventSharing.css'), 'utf8')

test('Share Events trigger belongs to Events list and Event details, not month toolbar', () => {
  assert.equal((app.match(/<FamilyEventSharing\b/g) ?? []).length, 2)
  const eventsHeading = app.indexOf('<h2>Events</h2>')
  const detailsPanel = app.indexOf('className="event-details-panel"')
  const detailsTrigger = app.indexOf('preselectedEventId={viewingCalendarEvent.id}')
  const eventsTrigger = app.indexOf('buttonLabel="Share Events & Invitations"')
  const eventsList = app.indexOf('className={`month-selected-events')
  const overlay = app.indexOf('<SharedEventsOverlay')
  assert(eventsHeading >= 0 && detailsPanel >= 0 && overlay >= 0)
  assert(detailsPanel < detailsTrigger && detailsTrigger < eventsHeading)
  assert(eventsHeading < eventsTrigger && eventsTrigger < eventsList)
  assert(!app.slice(overlay - 250, overlay).includes('<FamilyEventSharing'))
})

test('Sharing form is a modal portal above the event window, not inline under the calendar', () => {
  assert.match(sharing, /createPortal\(/)
  assert.match(sharing, /document\.body/)
  assert.match(sharing, /role="dialog"/)
  assert.match(sharing, /aria-modal="true"/)
  assert.match(sharing, /aria-labelledby=/)
  assert.match(sharing, /family-sharing-dialog-backdrop/)
  assert.match(sharing, /event\.key === 'Escape'/)
  assert.match(sharing, /event\.key !== 'Tab'/)
  assert.match(sharing, /document\.body\.style\.overflow = 'hidden'/)
  assert.match(sharing, /triggerRef\.current\?\.focus\(\)/)
  assert.match(css, /\.family-sharing-dialog-layer[^{]*\{[^}]*z-index:\s*25000/s)
  assert.match(css, /max-height:\s*calc\(100dvh - 28px\)/)
})

test('Contextual share selects only the opened event; sharing remains an explicit recipient choice', () => {
  assert.match(sharing, /preselectedEventId !== undefined/)
  assert.match(sharing, /eligibleEvents\.some\(event => event\.id === preselectedEventId\)/)
  assert.match(sharing, /\? \[preselectedEventId\] : \[\]/)
  assert.match(sharing, /canSend = sendableIds\.length > 0 && sendableRecipients\.length > 0/)
  assert.match(sharing, /window\.confirm\(/)
  assert.match(sharing, /recipientHouseholdIds: sendableRecipients/)
  assert.match(sharing, /eventIds: sendableIds/)
})
