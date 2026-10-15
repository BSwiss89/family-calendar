import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTrustedShareRecipients, parseIncomingInvitations, parseOutgoingInvitations,
} from '../src/eventSharingUiModel.ts'

test('recipient list includes only server-approved household contacts with valid names', () => {
  const allowed = parseTrustedShareRecipients({ recipients: [
    { householdId: 'family-b', displayName: 'Family B', userId: 42, passwordHash: 'SECRET' },
    { householdId: 'family-c', displayName: 'Family C' },
    { householdId: 'family-b', displayName: 'Duplicate contact' },
    { householdId: '../../other', displayName: 'Bad household path' },
    { householdId: 'family-d', displayName: '' },
    { householdId: 'family-e', displayName: 'X'.repeat(200) },
  ] })
  assert.deepEqual(allowed, [
    { householdId: 'family-b', displayName: 'Family B' },
    { householdId: 'family-c', displayName: 'Family C' },
  ])
  assert.doesNotMatch(JSON.stringify(allowed), /SECRET|password|userId|Duplicate contact/)
  assert.deepEqual(parseTrustedShareRecipients({}), [])
  assert.deepEqual(parseTrustedShareRecipients('<html>legacy server</html>'), [])
})

test('pending invitation UI never interprets sender calendar IDs, notes or uploads as accessible data', () => {
  const incoming = parseIncomingInvitations({ invitations: [
    { shareId: 11, sharedBy: 'Family B', title: 'BBQ', date: '2026-12-20',
      time: '13:00', sourceEventId: 1, userId: 5, location: 'PRIVATE', notes: 'SECRET' },
    { shareId: 11, sharedBy: 'Duplicate', title: 'Duplicate', date: '2026-12-20', time: '13:00' },
    { shareId: 12, sharedBy: 'Family C', title: 'Party', date: '2026-02-30', time: null },
    { shareId: 13, sharedBy: 'Family A', title: 'Valid day', date: '2026-12-21', time: null },
    { shareId: -2, sharedBy: 'Bad', title: 'Bad id', date: '2026-12-20', time: null },
    { shareId: 9, sharedBy: '', title: 'No sender', date: '2026-12-20', time: null },
  ] })
  assert.deepEqual(incoming, [
    { shareId: 11, sharedBy: 'Family B', title: 'BBQ', date: '2026-12-20', time: '13:00' },
    { shareId: 13, sharedBy: 'Family A', title: 'Valid day', date: '2026-12-21', time: null },
  ])
  assert.doesNotMatch(JSON.stringify(incoming), /PRIVATE|SECRET|sourceEventId|userId/)
})

test('sender can review only individually invited events and statuses, not recipient calendars', () => {
  const sent = parseOutgoingInvitations({ shares: [
    {
      shareId: 45, sourceEventId: 1, recipientHouseholdId: 'family-b',
      recipientDisplayName: 'Family B', title: 'Our BBQ',
      date: '2026-12-20', time: '14:00', status: 'pending',
      otherEvents: ['PRIVATE APPOINTMENT'], recipientDbPath: '/SECRET/db',
    },
    {
      shareId: 46, sourceEventId: 1, recipientHouseholdId: 'family-c',
      recipientDisplayName: 'Family C', title: 'Our BBQ',
      date: '2026-12-20', time: '14:00', status: 'accepted',
    },
    {
      shareId: 47, sourceEventId: 1, recipientHouseholdId: 'family-c',
      recipientDisplayName: 'Family C', title: 'Revoked event',
      date: '2026-12-20', time: '14:00', status: 'revoked',
    },
  ] })
  assert.deepEqual(sent.map(s => s.status), ['pending', 'accepted', 'revoked'])
  assert.deepEqual(sent.map(s => s.shareId), [45, 46, 47])
  assert.doesNotMatch(JSON.stringify(sent), /recipientDbPath|PRIVATE APPOINTMENT|SECRET|otherEvents/)
  assert.deepEqual(parseOutgoingInvitations({ shares: {} }), [])
})
