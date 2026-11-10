import type { ArneyVoiceResponseMode } from './arneyPreferences'

export type ArneyReplyKind = 'information' | 'clarification' | 'confirmation' | 'success' | 'error'
export type ArneyReply = { text: string; kind: ArneyReplyKind }

export function shouldSpeakArneyReply(mode: ArneyVoiceResponseMode, kind: ArneyReplyKind): boolean {
  if (mode === 'silent') return false
  if (mode === 'always') return true
  return kind === 'clarification' || kind === 'confirmation' ||
    kind === 'success' || kind === 'error'
}

/** Only describe supported commands; classification alone NEVER authorizes edits. */
export function describeArneyIntent(intent: unknown): ArneyReply {
  switch (intent) {
    case 'create_event':
      return {
        text: 'I understand you want to create an event, but voice event creation is not connected yet. Use Quick Add for now.',
        kind: 'information',
      }
    case 'add_list_item':
      return {
        text: 'I understand this is a shopping-list request, but adding list items by voice is not connected yet. Use Quick Add for now.',
        kind: 'information',
      }
    default:
      return {
        text: 'I can currently help review changes to calendar events. Try asking me to move or cancel an event.',
        kind: 'information',
      }
  }
}

type PreviewMatch = { title?: unknown; date?: unknown; time?: unknown }
type Preview = {
  status?: unknown
  reason?: unknown
  count?: unknown
  matches?: unknown
  criteria?: unknown
}

function safeTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'your event'
  return value.trim().slice(0, 100)
}

function safeDate(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
}

export function describeArneyPreview(
  intent: 'cancel_event' | 'move_event',
  previewValue: unknown,
): ArneyReply {
  if (!previewValue || typeof previewValue !== 'object' || Array.isArray(previewValue)) {
    return { text: 'Arney could not read the event preview. No change was made.', kind: 'error' }
  }
  const preview = previewValue as Preview
  const verb = intent === 'cancel_event' ? 'cancel' : 'move'
  const matches = Array.isArray(preview.matches) ? preview.matches as PreviewMatch[] : []
  if (preview.status === 'ready_for_confirmation' && matches.length === 1) {
    const title = safeTitle(matches[0]?.title)
    const date = safeDate(matches[0]?.date)
    return {
      text: 'I found ' + title + (date ? ' on ' + date : '') +
        '. Review the proposed change, then press the confirmation button if it is correct. Nothing has changed yet.',
      kind: 'confirmation',
    }
  }
  if (preview.status === 'needs_clarification') {
    if (matches.length > 1 || (typeof preview.count === 'number' && preview.count > 1)) {
      return {
        text: 'I found multiple matching events. Select the right event before you confirm anything.',
        kind: 'clarification',
      }
    }
    if (intent === 'move_event' && preview.reason === 'missing_requested_change') {
      return {
        text: 'What date or time should I move the event to? No changes have been made.',
        kind: 'clarification',
      }
    }
    if (intent === 'move_event') {
      return {
        text: 'Which event do you want to move? Include its name and date.',
        kind: 'clarification',
      }
    }
    const criteria = preview.criteria && typeof preview.criteria === 'object' && !Array.isArray(preview.criteria)
      ? preview.criteria as Record<string, unknown> : {}
    if (!criteria.title) return { text: 'Which event would you like to cancel?', kind: 'clarification' }
    if (!criteria.date) return { text: 'What date is that event?', kind: 'clarification' }
    if (!criteria.person) return { text: 'Which person is the event assigned to?', kind: 'clarification' }
    return { text: 'I need a little more detail before I can find that event.', kind: 'clarification' }
  }
  if (preview.status === 'no_match' || preview.count === 0) {
    return {
      text: 'I could not find a matching event to ' + verb + '. Check the event title and date, then try again.',
      kind: 'information',
    }
  }
  return {
    text: 'I cannot safely ' + verb + ' that event using this request. No changes have been made.',
    kind: 'error',
  }
}

export function describeArneyError(): ArneyReply {
  return {
    text: 'Arney could not process that request right now. Check the wording or try again when local AI is available. No change was made.',
    kind: 'error',
  }
}

