import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const app = readFileSync(fileURLToPath(new URL('../src/App.tsx', import.meta.url)), 'utf8')
const inbox = readFileSync(fileURLToPath(new URL('../src/useInvitationInbox.ts', import.meta.url)), 'utf8')
const ui = readFileSync(fileURLToPath(new URL('../src/InvitationCenter.tsx', import.meta.url)), 'utf8')

test('desktop invites have their own page without replacing LIVE navigation', () => {
  assert.match(app, /import \{ DesktopInvitations, MobileInvitationReminder \} from '\.\/InvitationCenter'/)
  assert.match(app, /const invitationInbox = useInvitationInbox\(\)/)
  assert.match(app, /page === 'invitations' && <DesktopInvitations \{\.\.\.invitationInbox\} \/>/)
  assert.match(app, /<span>Invitations<\/span>/)
  assert.match(app, /onClick=\{\(\) => setPage\('invitations'\)\}/)
  for (const page of ['home', 'calendar', 'meals', 'lists', 'householdMembers']) {
    assert.match(app, new RegExp("page === '" + page + "'"))
  }
})

test('mobile invitation reminder is optional and remains isolated from editing events', () => {
  assert.match(app, /<MobileInvitationReminder \{\.\.\.invitationInbox\} suppress=\{page === 'invitations'\} \/>/)
  assert.match(ui, /mobile && available && invitations\.length > 0 && !remindLater/)
  assert.match(ui, /Remind Later/)
  assert.match(ui, /Accept/)
  assert.match(ui, /Decline/)
  assert.match(ui, /document\.visibilityState === 'hidden'/)
  assert.match(inbox, /setAvailable\(false\)/)
  assert.match(inbox, /setInvitations\(\[\]\)/)
  assert.match(inbox, /\/api\/shared-events\/invitations/)
  assert.doesNotMatch(inbox, /\/api\/events/)
})

test('mobile Settings reopens pending invites after Remind Later without duplicate modal', () => {
  assert.match(app, /className="mobile-settings-invitation-count"/)
  assert.match(app, /setPage\('invitations'\)/)
  assert.match(app, /void invitationInbox\.refresh\(\)/)
  assert.match(app, /mobile-invitation-back/)
  assert.match(ui, /!remindLater && !suppress/)
  assert.match(app, /suppress=\{page === 'invitations'\}/)
})

test('pending invitations do not copy external events into the editable local calendar', () => {
  assert.match(inbox, /family-calendar:shared-events-changed/)
  assert.match(inbox, /setInvitations\(current => current\.filter/)
  assert.doesNotMatch(inbox, /setEvents\(|\/api\/events/)
  assert.match(app, /<FamilyEventSharing event=\{viewingCalendarEvent\} \/>/)
  assert.match(app, /storeSortingEnabled/)
  assert.match(app, /makeEventDuplicateDraft/)
})
