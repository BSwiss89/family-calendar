// A duplication draft is always a new, non-recurring event for the selected
// occurrence. Never carry over an event ID, batch ID, or series exceptions.
function dateMs(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw Error('A YYYY-MM-DD date is required.')
  }
  const [year, month, day] = key.split('-').map(Number)
  const ms = Date.UTC(year, month - 1, day)
  if (new Date(ms).toISOString().slice(0, 10) !== key) {
    throw Error('Invalid calendar date.')
  }
  return ms
}

export function makeEventDuplicateDraft(event, occurrenceDate) {
  if (!event || typeof event.title !== 'string') {
    throw Error('An existing event is required.')
  }
  const sourceStart = dateMs(event.date)
  const selectedStart = dateMs(occurrenceDate)
  const duration = event.endDate
    ? Math.max(0, Math.round((dateMs(event.endDate) - sourceStart) / 86400000))
    : 0
  return {
    title: event.title,
    date: occurrenceDate,
    endDate: duration
      ? new Date(selectedStart + duration * 86400000).toISOString().slice(0, 10)
      : null,
    time: event.time || '',
    endTime: event.endTime || '',
    allDay: !event.time,
    notes: event.notes || '',
    location: event.location || '',
    personIds: Array.isArray(event.people)
      ? event.people.map(person => person.id).filter(Number.isSafeInteger)
      : [],
    repeatUnit: 'none',
    repeatInterval: 1,
    repeatEndType: 'never',
    repeatEndDate: null,
    repeatCount: null,
  }
}
