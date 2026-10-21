// PRIVATE MULTI-HOUSEHOLD TEST ONLY: bounded text -> secure Arney preview.
// This is a deterministic grammar, NOT a general LLM parser. It reads ONLY
// the authenticated household's own events, not accepted remote invitations.
// Unsupported/ambiguous text NEVER triggers a write or an automatic choice.
import { lookupGrantedHouseholdForSessionUser } from './household-memberships.mjs'
import { validatePrivateArneyLookupRange } from './private-arney-calendar-lookup.mjs'
import { ArneyActionError, previewPrivateArneyAction } from './private-arney-confirmed-actions.mjs'

const EXAMPLES = Object.freeze([
  'Cancel event "Dentist Appointment" on 2026-12-20',
  'Move event "Dentist Appointment" on 2026-12-20 to 2026-12-22 at 14:30',
])
const MAX_MATCHES = 20
const SIMPLE_TITLE = '[^"\\r\\n\\x00-\\x1f]{1,100}'
const DAY = '(\\d{4}-\\d{2}-\\d{2})'
const CLOCK = '([01]\\d|2[0-3]):([0-5]\\d)'
const CANCEL = new RegExp(
  '^(?:cancel|delete|remove)\\s+(?:the\\s+)?event\\s+"(' +
  SIMPLE_TITLE + ')"\\s+on\\s+' + DAY + '$', 'i'
)
const MOVE = new RegExp(
  '^(?:move|reschedule)\\s+(?:the\\s+)?event\\s+"(' +
  SIMPLE_TITLE + ')"\\s+on\\s+' + DAY + '\\s+to\\s+' +
  DAY + '(?:\\s+at\\s+' + CLOCK + ')?$', 'i'
)

function validDate(value) {
  try {
    validatePrivateArneyLookupRange(value, value)
    return true
  } catch { return false }
}

export function parsePrivateArneyEventText(text) {
  if (typeof text !== 'string' || text.length > 500 || !text.trim()) {
    throw new ArneyActionError(400, 'An event command of 1 to 500 characters is required.')
  }
  // Wake prefix is optional, but does not grant extra privileges.
  const phrase = text.trim().replace(/[.!?]$/, '').trim()
    .replace(/^(?:(?:hey[ ,]+)?(?:arney|calendar)[ ,]+|computer[ ,]+)?please\s+/i, '')
    .replace(/^(?:(?:hey[ ,]+)?arney[ ,]+|computer[ ,]+)/i, '')
  const cancellation = CANCEL.exec(phrase)
  const moving = MOVE.exec(phrase)
  const match = cancellation ?? moving
  if (!match) return null
  const title = match[1].trim()
  const onDate = match[2]
  const newDate = moving?.[3]
  const newTime = moving?.[4] && moving?.[5]
    ? moving[4] + ':' + moving[5] : undefined
  if (!title || !validDate(onDate) || (newDate && !validDate(newDate))) {
    return null
  }
  return {
    action: cancellation ? 'cancel' : 'reschedule',
    title, onDate,
    ...(newDate ? { newDate } : {}),
    ...(newTime ? { newTime } : {}),
  }
}

export function interpretPrivateArneyEventAction({
  identityDatabase, sourceDb, tokenKey,
  verifiedUserId, verifiedSessionId, householdId, text, now = Date.now(),
}) {
  if (!identityDatabase?.prepare || !sourceDb?.prepare ||
      !Number.isSafeInteger(verifiedUserId) || verifiedUserId < 1 ||
      !Number.isSafeInteger(verifiedSessionId) || verifiedSessionId < 1) {
    throw new Error('Trusted Arney event interpretation context required.')
  }
  const access = lookupGrantedHouseholdForSessionUser(identityDatabase, {
    serverVerifiedUserId: verifiedUserId, requestedHouseholdId: householdId,
  })
  if (!access) throw new ArneyActionError(403, 'No active household membership.')

  const parsed = parsePrivateArneyEventText(text)
  if (!parsed) return {
    status: 'needs_clarification', readOnly: true,
    examples: [...EXAMPLES],
  }

  // Exact (case-insensitive) title + explicit original date; no fuzzy matching.
  // Parameterized SQLite lookup prevents phrases from becoming SQL.
  // The source database is pre-resolved by the gateway, never from the text.
  const matches = sourceDb.prepare([
    'SELECT id AS eventId, title, date, time, end_date AS endDate,',
    'repeat_unit AS repeatUnit FROM events',
    'WHERE title = ? COLLATE NOCASE AND date = ?',
    'ORDER BY id LIMIT ?',
  ].join(' ')).all(parsed.title, parsed.onDate, MAX_MATCHES + 1)

  if (matches.length === 0) return {
    status: 'not_found', readOnly: true,
    message: 'No matching event in your own household calendar.',
  }
  if (matches.length > MAX_MATCHES) return {
    status: 'too_many_matches', readOnly: true,
    message: 'Too many matching events. Open your calendar and choose one.',
  }
  if (matches.length > 1) return {
    status: 'needs_selection', readOnly: true,
    action: parsed.action,
    options: matches.map(row => ({
      eventId: row.eventId, title: row.title, date: row.date,
      time: row.time,
      supported: row.endDate == null &&
        (row.repeatUnit == null || row.repeatUnit === '' ||
          row.repeatUnit === 'none'),
    })),
    // After choosing ONE of these local IDs, the UI must call the existing
    // event-action-preview endpoint. No signature/confirmation is issued here.
    previewRequest: {
      action: parsed.action,
      ...(parsed.newDate ? { newDate: parsed.newDate } : {}),
      ...(parsed.newTime ? { newTime: parsed.newTime } : {}),
    },
    requiresSelection: true,
    requiresConfirmation: false,
  }
  const event = matches[0]
  // The single matching event may be recurring or multiday. Never fall
  // through to another candidate or silently edit just one occurrence.
  if (event.endDate != null ||
      (event.repeatUnit != null && event.repeatUnit !== '' &&
       event.repeatUnit !== 'none')) {
    return {
      status: 'unsupported_event', readOnly: true,
      message: 'Recurring or multi-day events need manual editing.',
    }
  }
  const request = {
    action: parsed.action, eventId: event.eventId,
    ...(parsed.newDate ? { newDate: parsed.newDate } : {}),
    ...(parsed.newTime ? { newTime: parsed.newTime } : {}),
  }
  const preview = previewPrivateArneyAction({
    sourceDb, tokenKey, verifiedUserId, verifiedSessionId, householdId,
    request, now,
  })
  return { status: 'ready_for_confirmation', ...preview }
}
