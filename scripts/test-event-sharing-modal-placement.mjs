import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
const sharing = fs.readFileSync(path.join(root, 'src/FamilyEventSharing.tsx'), 'utf8')
const invitations = fs.readFileSync(path.join(root, 'src/InvitationCenter.tsx'), 'utf8')
const styles = fs.readFileSync(path.join(root, 'src/FamilyEventSharing.css'), 'utf8')

test('one Share Event button in individual event details; NO calendar-wide Events sharing button', () => {
  assert.equal((app.match(/<FamilyEventSharing\b/g) ?? []).length, 1)
  const details = app.indexOf('className="event-details-panel"')
  const button = app.indexOf('<FamilyEventSharing event={viewingCalendarEvent} />')
  const allEventsPage = app.indexOf('<h2>Events</h2>')
  const calendar = app.indexOf('<SharedEventsOverlay')
  assert(details >= 0 && details < button && button < allEventsPage)
  assert(calendar >= 0 && !app.slice(calendar - 220, calendar).includes('FamilyEventSharing'))
  assert.doesNotMatch(app, /buttonLabel="Share Events & Invitations"/)
  assert.match(sharing, />\s*Share Event\s*<\/button>/)
  assert.doesNotMatch(sharing, /Choose your events/)
  assert.doesNotMatch(sharing, /eligibleEvents\.map/)
})

test('Share Event opens a focused modal in front of Event details', () => {
  assert.match(sharing, /createPortal\(/)
  assert.match(sharing, /document\.body/)
  assert.match(sharing, /role="dialog"/)
  assert.match(sharing, /aria-modal="true"/)
  assert.match(sharing, /family-sharing-dialog-backdrop/)
  assert.match(sharing, /keyEvent\.key === 'Escape'/)
  assert.match(sharing, /keyEvent\.key !== 'Tab'/)
  assert.match(sharing, /document\.body\.style\.overflow = 'hidden'/)
  assert.match(styles, /\.family-sharing-dialog-layer[^{]*\{[^}]*z-index:\s*25000/s)
  assert.match(styles, /max-height:\s*calc\(100dvh - 28px\)/)
})

test('Share Event only submits that event ID with explicitly chosen family recipients', () => {
  assert.match(sharing, /eventIds: \[event\.id\]/)
  assert.match(sharing, /recipientHouseholdIds: selectedValid/)
  assert.match(sharing, /window\.confirm\(/)
  assert.match(sharing, /existingTargets\.has\(contact\.householdId\)/)
  assert.match(sharing, /!event\.repeatUnit \|\| event\.repeatUnit === 'none'/)
  assert.doesNotMatch(sharing, /share all|entire calendar/i)
})

test('desktop has Invitations sidebar page and accepted invited events on Day', () => {
  assert.match(app, /page === 'invitations'/)
  assert.match(app, /<DesktopInvitations \{\.\.\.invitationInbox\} \/>/)
  assert.match(app, /<span>Invitations<\/span>/)
  assert.match(app, /<MobileInvitationReminder \{\.\.\.invitationInbox\} \/>/)
  assert.match(app, /sharedEventsInRange\(\s*receivedSharedEvents, dayViewDateKey, dayViewDateKey/)
  assert.match(app, /day-summary-received-event/)
  assert.match(app, /Created by:/)
})

test('mobile pending invitation has Accept, Decline, Remind Later and retries on next foreground', () => {
  assert.match(invitations, /role="dialog"/)
  assert.match(invitations, /aria-modal="true"/)
  assert.match(invitations, /'accepted'/)
  assert.match(invitations, /'declined'/)
  assert.match(invitations, /Remind Later/)
  assert.match(invitations, /setRemindLater\(true\)/)
  assert.match(invitations, /document\.visibilityState === 'hidden'/)
  assert.match(invitations, /setRemindLater\(false\)/)
  assert.match(invitations, /invitations\.length > 0/)
})
