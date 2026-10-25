import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const app = readFileSync(fileURLToPath(new URL('../src/App.tsx', import.meta.url)), 'utf8')
const sharing = readFileSync(fileURLToPath(new URL('../src/FamilyEventSharing.tsx', import.meta.url)), 'utf8')

test('one event-specific Share Event control in the existing LIVE details popup', () => {
  assert.match(app, /import FamilyEventSharing from '\.\/FamilyEventSharing'/)
  assert.equal((app.match(/<FamilyEventSharing\b/g) ?? []).length, 1)
  const details = app.indexOf('className="event-details-panel"')
  const actions = app.indexOf('className="event-details-actions"', details)
  const share = app.indexOf('<FamilyEventSharing event={viewingCalendarEvent} />')
  const deletion = app.indexOf('{detailsDeleteConfirmOpen && (', actions)
  assert(details >= 0 && actions > details && share > actions && deletion > share)
  assert(share - actions < 5000, 'Sharing must be in the existing event detail, not a global navigation area')
  assert.match(app, /className="event-details-duplicate-button"/)
  assert.match(app, /className="event-details-edit-button"/)
  assert.match(app, /className="event-details-delete-button"/)
})

test('Share Event never offers a whole-calendar export or a recurring series', () => {
  assert.match(sharing, /if \(!supported \|\| !eligible\) return null/)
  assert.match(sharing, /eventIds: \[event\.id\]/)
  assert.match(sharing, /recipientHouseholdIds: selectedValid/)
  assert.match(sharing, /!event\.repeatUnit \|\| event\.repeatUnit === 'none'/)
  assert.doesNotMatch(app, /buttonLabel="Share Events & Invitations"/)
  assert.doesNotMatch(app, /<SharedEventsOverlay/)
})

test('LIVE shopping, lists, and duplicate event controls retain their source entry points', () => {
  assert.match(app, /import \{ ListIcon, LIST_ICON_OPTIONS, getListIconOption \} from '\.\/ListIcons'/)
  assert.match(app, /import \{ makeEventDuplicateDraft \} from '\.\/duplicateEvent\.mjs'/)
  assert.match(app, /setShoppingStoreSettingsOpen\(true\)/)
  assert.match(app, /storeSortingEnabled/)
})
