export type ArneyListInfo = {
  id: number
  name: string
  items?: Array<{ text: string }>
}

export type ArneySimpleCommand =
  | { kind: 'add-list-item'; listId: number; listName: string; item: string }
  | { kind: 'list-query'; listId: number; listName: string; items: string[] }
  | { kind: 'calendar-query'; when: 'today' | 'tomorrow' }
  | { kind: 'create-event'; title: string; date: string; time: string | null }

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function localDayKey(date: Date): string {
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d\d)-(\d\d)$/.exec(value)
  if (!match) return false
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return localDayKey(date) === value
}

function arneyTime(value: string | undefined): string | null | undefined {
  if (!value) return null
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value.trim())
  if (!match) return undefined
  let hour = Number(match[1])
  const minute = Number(match[2] || 0)
  if (minute > 59) return undefined
  const suffix = match[3]?.toLowerCase()
  if (suffix) {
    if (hour < 1 || hour > 12) return undefined
    hour = hour % 12 + (suffix === 'pm' ? 12 : 0)
  } else if (hour > 23 || !match[2]) {
    // A bare "3" is ambiguous; require AM/PM or 24-hour HH:mm.
    return undefined
  }
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0')
}

/**
 * Deliberately conservative local patterns. Unrecognized or ambiguous requests
 * go to local Ollama classification; no mutations occur from this function.
 */
export function parseArneySimpleCommand(
  input: string,
  lists: ArneyListInfo[],
  now: Date = new Date(),
): ArneySimpleCommand | null {
  const text = input.trim().replace(/[.!?]+$/, '')
  if (!text || text.length > 500) return null

  for (const list of [...lists].sort((a, b) => b.name.length - a.name.length)) {
    if (!list.name || list.id <= 0) continue
    const name = escapeRegExp(list.name)
    const add = new RegExp('^(?:add|put)\\s+(.+?)\\s+(?:to|on|in)\\s+(?:(?:my|the)\\s+)?' + name + '(?:\\s+list)?$', 'i').exec(text)
    if (add && add[1].trim().length <= 200) {
      return { kind: 'add-list-item', listId: list.id, listName: list.name, item: add[1].trim() }
    }
    const query = new RegExp('^(?:show|read|list|what(?:\\x27s| is) on)\\s+(?:(?:my|the)\\s+)?' + name + '(?:\\s+list)?$', 'i').exec(text)
    if (query) {
      return { kind: 'list-query', listId: list.id, listName: list.name, items: (list.items ?? []).map(item => item.text) }
    }
  }

  if (/^(?:what(?:'s| is)|what do i have|show|tell me|read)(?:.*?)(?:calendar|schedule|events?|appointments?|on today|on tomorrow|for today|for tomorrow)/i.test(text)) {
    if (/\btomorrow\b/i.test(text)) return { kind: 'calendar-query', when: 'tomorrow' }
    if (/\btoday\b/i.test(text)) return { kind: 'calendar-query', when: 'today' }
  }

  const create = /^(?:add|create|schedule|put)\s+(?:an?\s+)?(?:event\s+|appointment\s+)?(.+?)\s+(?:(?:on|for)\s+)?(today|tomorrow|\d{4}-\d{2}-\d{2})(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?$/i.exec(text)
  if (create) {
    const title = create[1].trim()
    const day = create[2].toLowerCase()
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    if (day === 'tomorrow') target.setDate(target.getDate() + 1)
    const date = day === 'today' || day === 'tomorrow' ? localDayKey(target) : day
    const time = arneyTime(create[3])
    if (title && title.length <= 200 && validIsoDate(date) && time !== undefined) {
      return { kind: 'create-event', title, date, time }
    }
  }
  return null
}
