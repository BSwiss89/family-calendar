/**
 * Accepted shared-event snapshots have their own read-only shape. Never cast
 * them to CalendarEvent: event IDs are household-local and edit/delete actions
 * must NEVER target a sender's event or a coincidentally matching local ID.
 */
export type AcceptedSharedEvent = {
  shareId: number
  sharedBy: string
  title: string
  date: string
  endDate: string | null
  time: string | null
  endTime: string | null
}

type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isCalendarDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const [year, month, day] = value.split('-').map(Number)
  const actual = new Date(Date.UTC(year, month - 1, day))
  return Number.isFinite(actual.getTime()) &&
    actual.getUTCFullYear() === year &&
    actual.getUTCMonth() === month - 1 &&
    actual.getUTCDate() === day
}

function optionalTime(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return undefined
  }
  return value
}

/**
 * A privacy allowlist: project ONLY event title, date/time and shared-by name.
 * Ignore unexpected fields (source IDs, notes, location, people and photos),
 * even if a mistaken server implementation accidentally sends them.
 */
export function parseAcceptedSharedEvents(payload: unknown): AcceptedSharedEvent[] {
  if (!isRecord(payload) || !Array.isArray(payload.events)) return []
  const seen = new Set<number>()
  const result: AcceptedSharedEvent[] = []

  for (const raw of payload.events) {
    if (!isRecord(raw) || !Number.isSafeInteger(raw.shareId) ||
        (raw.shareId as number) <= 0 || seen.has(raw.shareId as number) ||
        typeof raw.title !== 'string' || raw.title.trim().length === 0 ||
        raw.title.length > 250 ||
        typeof raw.sharedBy !== 'string' || raw.sharedBy.trim().length === 0 ||
        raw.sharedBy.length > 100 ||
        !isCalendarDateKey(raw.date)) {
      continue
    }

    const endDate = raw.endDate ?? null
    if (endDate !== null && (!isCalendarDateKey(endDate) || endDate < raw.date)) {
      continue
    }
    const time = optionalTime(raw.time ?? null)
    const endTime = optionalTime(raw.endTime ?? null)
    if (time === undefined || endTime === undefined) continue

    const shareId = raw.shareId as number
    seen.add(shareId)
    result.push({
      shareId,
      sharedBy: raw.sharedBy.trim(),
      title: raw.title.trim(),
      date: raw.date,
      endDate,
      time,
      endTime,
    })

    if (result.length === 250) break
  }

  return result.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.time ?? '').localeCompare(b.time ?? '') ||
    a.shareId - b.shareId
  )
}

export function sharedEventOverlapsRange(
  event: AcceptedSharedEvent, start: string, end: string
): boolean {
  return event.date <= end && (event.endDate ?? event.date) >= start
}

export function sharedEventsInRange(
  events: readonly AcceptedSharedEvent[], start: string, end: string
): AcceptedSharedEvent[] {
  if (!isCalendarDateKey(start) || !isCalendarDateKey(end) || end < start) return []
  return events.filter(event => sharedEventOverlapsRange(event, start, end))
}

export function formatSharedTime(time: string | null): string {
  if (!time) return 'All day'
  const [hours, minutes] = time.split(':').map(Number)
  const displayHour = (hours % 12) || 12
  return `${displayHour}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`
}

export function formatSharedDate(dateKey: string): string {
  if (!isCalendarDateKey(dateKey)) return ''
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
  })
}
