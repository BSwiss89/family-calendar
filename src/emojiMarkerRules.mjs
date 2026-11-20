// Pure date-only rules shared by the TEST calendar API and its month view.
// Dates are evaluated at UTC noon/midnight boundaries, never local timestamps.
const DAY = 86400000
const allowedUnits = new Set(['day', 'week', 'month', 'year'])
const monthPatterns = new Set(['date', 'nth-weekday', 'last-weekday'])

export function validEmojiDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function utcDate(value) {
  const [year, month, day] = value.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

function monthlyOccurrenceDay(marker, year, monthIndex) {
  const start = new Date(utcDate(marker.date))
  const originalDay = start.getUTCDate()
  const sourceWeekday = start.getUTCDay()
  const lastDay = daysInMonth(year, monthIndex)
  if (marker.repeatMonthPattern === 'nth-weekday') {
    const ordinal = Math.floor((originalDay - 1) / 7)
    const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay()
    const candidate = 1 + ((sourceWeekday - firstWeekday + 7) % 7) + ordinal * 7
    return candidate <= lastDay ? candidate : null
  }
  if (marker.repeatMonthPattern === 'last-weekday') {
    const lastWeekday = new Date(Date.UTC(year, monthIndex, lastDay)).getUTCDay()
    return lastDay - ((lastWeekday - sourceWeekday + 7) % 7)
  }
  return originalDay <= lastDay ? originalDay : null
}

export function normalizeEmojiMarkerPayload(body) {
  if (!body || typeof body !== 'object' || !validEmojiDate(body.date)) return null
  const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : ''
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (!emoji || emoji.length > 24 || label.length > 80) return null
  if (!/\p{Extended_Pictographic}/u.test(emoji)) return null
  if ([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(emoji)].length !== 1) return null
  const repeatUnit = body.repeatUnit == null || body.repeatUnit === 'none' ? null : body.repeatUnit
  if (repeatUnit !== null && !allowedUnits.has(repeatUnit)) return null
  if (repeatUnit === null) {
    return { date: body.date, emoji, label, repeatUnit: null, repeatInterval: null,
      repeatWeekdays: null, repeatMonthPattern: null, repeatEndType: null,
      repeatEndDate: null, repeatCount: null }
  }
  const repeatInterval = Number(body.repeatInterval ?? 1)
  if (!Number.isInteger(repeatInterval) || repeatInterval < 1 || repeatInterval > 365) return null
  let repeatWeekdays = null
  if (repeatUnit === 'week') {
    const weekdays = body.repeatWeekdays == null
      ? [new Date(utcDate(body.date)).getUTCDay()] : body.repeatWeekdays
    if (!Array.isArray(weekdays) || weekdays.length < 1 || weekdays.length > 7 ||
        weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) return null
    repeatWeekdays = [...new Set(weekdays)].sort((a, b) => a - b)
  }
  let repeatMonthPattern = null
  if (repeatUnit === 'month') {
    repeatMonthPattern = body.repeatMonthPattern ?? 'date'
    if (!monthPatterns.has(repeatMonthPattern)) return null
  }
  const repeatEndType = body.repeatEndType ?? 'never'
  if (!['never', 'date', 'count'].includes(repeatEndType)) return null
  let repeatEndDate = null
  let repeatCount = null
  if (repeatEndType === 'date') {
    if (!validEmojiDate(body.repeatEndDate) || body.repeatEndDate < body.date) return null
    repeatEndDate = body.repeatEndDate
  }
  if (repeatEndType === 'count') {
    repeatCount = Number(body.repeatCount)
    if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 1000) return null
  }
  return { date: body.date, emoji, label, repeatUnit, repeatInterval, repeatWeekdays,
    repeatMonthPattern, repeatEndType, repeatEndDate, repeatCount }
}

export function emojiMarkerOccursOnDate(marker, dateKey) {
  if (!validEmojiDate(dateKey) || !validEmojiDate(marker?.date)) return false
  if (marker.exceptions?.includes(dateKey)) return false
  if (dateKey < marker.date) return false
  if (!marker.repeatUnit) return dateKey === marker.date
  if (marker.repeatEndType === 'date' && marker.repeatEndDate && dateKey > marker.repeatEndDate) return false
  const interval = marker.repeatInterval || 1
  if (!Number.isInteger(interval) || interval < 1) return false
  const startUtc = utcDate(marker.date)
  const targetUtc = utcDate(dateKey)
  const start = new Date(startUtc)
  const target = new Date(targetUtc)
  let occurrenceNumber = 0
  if (marker.repeatUnit === 'day') {
    const difference = (targetUtc - startUtc) / DAY
    if (difference % interval !== 0) return false
    occurrenceNumber = difference / interval + 1
  } else if (marker.repeatUnit === 'week') {
    const startWeek = startUtc - start.getUTCDay() * DAY
    const targetWeek = targetUtc - target.getUTCDay() * DAY
    const weeks = (targetWeek - startWeek) / (7 * DAY)
    const weekdays = Array.isArray(marker.repeatWeekdays) && marker.repeatWeekdays.length
      ? marker.repeatWeekdays : [start.getUTCDay()]
    if (weeks % interval !== 0 || !weekdays.includes(target.getUTCDay())) return false
    const beforeWeeks = weeks / interval
    const firstWeekCount = weekdays.filter((day) => day >= start.getUTCDay()).length
    occurrenceNumber = beforeWeeks === 0
      ? weekdays.filter((day) => day >= start.getUTCDay() && day <= target.getUTCDay()).length
      : firstWeekCount + (beforeWeeks - 1) * weekdays.length +
        weekdays.filter((day) => day <= target.getUTCDay()).length
  } else if (marker.repeatUnit === 'month') {
    const monthDiff = (target.getUTCFullYear() - start.getUTCFullYear()) * 12 +
      target.getUTCMonth() - start.getUTCMonth()
    if (monthDiff % interval !== 0) return false
    if (monthDiff !== 0 && monthlyOccurrenceDay(marker, target.getUTCFullYear(), target.getUTCMonth()) !== target.getUTCDate()) return false
    if (marker.repeatEndType === 'count') {
      for (let delta = 0; delta <= monthDiff; delta += interval) {
        const total = start.getUTCFullYear() * 12 + start.getUTCMonth() + delta
        const y = Math.floor(total / 12), m = total % 12
        if (delta === 0 || monthlyOccurrenceDay(marker, y, m) != null) occurrenceNumber += 1
      }
    } else occurrenceNumber = monthDiff / interval + 1
  } else if (marker.repeatUnit === 'year') {
    const yearDiff = target.getUTCFullYear() - start.getUTCFullYear()
    if (yearDiff % interval !== 0 || start.getUTCMonth() !== target.getUTCMonth() ||
        start.getUTCDate() !== target.getUTCDate()) return false
    if (marker.repeatEndType === 'count') {
      for (let delta = 0; delta <= yearDiff; delta += interval) {
        const y = start.getUTCFullYear() + delta
        if (start.getUTCDate() <= daysInMonth(y, start.getUTCMonth())) occurrenceNumber += 1
      }
    } else occurrenceNumber = yearDiff / interval + 1
  } else return false
  return marker.repeatEndType !== 'count' || !marker.repeatCount ||
    occurrenceNumber <= marker.repeatCount
}

export function previousEmojiDate(dateKey) {
  if (!validEmojiDate(dateKey)) return null
  return new Date(utcDate(dateKey) - DAY).toISOString().slice(0, 10)
}
