export type ArneyListInfo = {
  id: number
  name: string
  items?: Array<{ text: string }>
}

export type ArneyMealType = 'breakfast' | 'lunch' | 'dinner' | 'snack'

export type ArneySimpleCommand =
  | { kind: 'add-list-item'; listId: number; listName: string; item: string }
  | { kind: 'add-meal'; title: string; date: string; mealType: ArneyMealType }
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

function resolveDay(value: string, now: Date): string | null {
  const day = value.toLowerCase()
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (day === 'tomorrow') target.setDate(target.getDate() + 1)
  const date = day === 'today' || day === 'tomorrow' ? localDayKey(target) : day
  return validIsoDate(date) ? date : null
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

function comparableListName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bgroceries\b/g, 'grocery')
    .replace(/\bshopping\b/g, 'grocery')
    .replace(/\blist\b/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Deliberately conservative local patterns. Recognized writes return only a
 * draft for an existing review form. They never call an API or save anything.
 */
export function parseArneySimpleCommand(
  input: string,
  lists: ArneyListInfo[],
  now: Date = new Date(),
): ArneySimpleCommand | null {
  const text = input
    .trim()
    .replace(/\b([ap])\s*\.\s*m\s*\.?/gi, '$1m')
    .replace(/[,;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
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

  const genericListAdd = /^(?:add|put)\s+(.+?)\s+(?:to|on|in)\s+(?:(?:my|the)\s+)?(.+?)$/i.exec(text)
  if (genericListAdd && genericListAdd[1].trim().length <= 200) {
    const requested = comparableListName(genericListAdd[2])
    const target = lists.find(list => comparableListName(list.name) === requested) ??
      (requested === 'grocery' ? lists.find(list => comparableListName(list.name) === 'grocery') : undefined)
    if (target) {
      return {
        kind: 'add-list-item',
        listId: target.id,
        listName: target.name,
        item: genericListAdd[1].trim(),
      }
    }
  }

  const meal = /^(?:add|put|plan|schedule)\s+(.+?)\s+(?:to|for)\s+(breakfast|lunch|dinner|snack)\s+(?:(?:on|for)\s+)?(today|tomorrow|\d{4}-\d{2}-\d{2})$/i.exec(text)
  if (meal) {
    const date = resolveDay(meal[3], now)
    const title = meal[1].trim()
    if (date && title && title.length <= 200) {
      return {
        kind: 'add-meal',
        title,
        date,
        mealType: meal[2].toLowerCase() as ArneyMealType,
      }
    }
  }

  if (/^(?:what(?:'s| is)|what do i have|show|tell me|read)(?:.*?)(?:calendar|schedule|events?|appointments?|on today|on tomorrow|for today|for tomorrow)/i.test(text)) {
    if (/\btomorrow\b/i.test(text)) return { kind: 'calendar-query', when: 'tomorrow' }
    if (/\btoday\b/i.test(text)) return { kind: 'calendar-query', when: 'today' }
  }

  const dateThenTime = /^(?:add|create|schedule|put)\s+(?:an?\s+)?(?:event\s+|appointment\s+)?(.+?)\s+(?:(?:on|for)\s+)?(today|tomorrow|\d{4}-\d{2}-\d{2})(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?$/i.exec(text)
  const timeThenDate = /^(?:add|create|schedule|put)\s+(?:an?\s+)?(?:event\s+|appointment\s+)?(.+?)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(?:(?:on|for)\s+)?(today|tomorrow|\d{4}-\d{2}-\d{2})$/i.exec(text)
  const title = (timeThenDate?.[1] ?? dateThenTime?.[1])?.trim()
  const rawDate = timeThenDate?.[3] ?? dateThenTime?.[2]
  const rawTime = timeThenDate?.[2] ?? dateThenTime?.[3]
  if (title && rawDate && title.length <= 200) {
    const date = resolveDay(rawDate, now)
    const time = arneyTime(rawTime)
    if (date && time !== undefined) {
      return { kind: 'create-event', title, date, time }
    }
  }

  return null
}
