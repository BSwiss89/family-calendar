import { isValidDate } from './calendar-input-validation.mjs'

// Preserves the exact recurring-event parsing and occurrence rules shared by
// the verified LIVE and TEST source baselines. No environment or data access.
export function getRepeatRule(body, eventDate) {
  const repeatUnit = body.repeatUnit

  if (
    repeatUnit === undefined ||
    repeatUnit === null ||
    repeatUnit === '' ||
    repeatUnit === 'none'
  ) {
    return {
      repeatUnit: null,
      repeatInterval: null,
      repeatEndType: null,
      repeatEndDate: null,
      repeatCount: null,
    }
  }

  const allowedUnits = [
    'day',
    'week',
    'month',
    'year',
  ]

  if (!allowedUnits.includes(repeatUnit)) {
    return null
  }

  const repeatInterval = Number(body.repeatInterval)

  if (
    !Number.isInteger(repeatInterval) ||
    repeatInterval < 1 ||
    repeatInterval > 365
  ) {
    return null
  }

  const repeatEndType =
    body.repeatEndType ?? 'never'

  if (
    ![
      'never',
      'date',
      'count',
    ].includes(repeatEndType)
  ) {
    return null
  }

  let repeatEndDate = null
  let repeatCount = null

  if (repeatEndType === 'date') {
    if (
      !isValidDate(body.repeatEndDate) ||
      body.repeatEndDate < eventDate
    ) {
      return null
    }

    repeatEndDate = body.repeatEndDate
  }

  if (repeatEndType === 'count') {
    const count = Number(body.repeatCount)

    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 1000
    ) {
      return null
    }

    repeatCount = count
  }

  return {
    repeatUnit,
    repeatInterval,
    repeatEndType,
    repeatEndDate,
    repeatCount,
  }
}

export function doesEventStartOnDate(
  calendarEvent,
  targetDate
) {
  if (
    calendarEvent.exceptions?.includes(
      targetDate
    )
  ) {
    return false
  }

  if (!calendarEvent.repeatUnit) {
    return calendarEvent.date === targetDate
  }

  if (targetDate < calendarEvent.date) {
    return false
  }

  if (
    calendarEvent.repeatEndType === 'date' &&
    calendarEvent.repeatEndDate &&
    targetDate > calendarEvent.repeatEndDate
  ) {
    return false
  }

  const interval =
    calendarEvent.repeatInterval ?? 1

  const [startYear, startMonth, startDay] =
    calendarEvent.date.split('-').map(Number)

  const [targetYear, targetMonth, targetDay] =
    targetDate.split('-').map(Number)

  const startUtc = Date.UTC(
    startYear,
    startMonth - 1,
    startDay
  )

  const targetUtc = Date.UTC(
    targetYear,
    targetMonth - 1,
    targetDay
  )

  const millisecondsPerDay =
    24 * 60 * 60 * 1000

  const differenceInDays =
    (targetUtc - startUtc) /
    millisecondsPerDay

  let occurrenceNumber = null

  if (calendarEvent.repeatUnit === 'day') {
    if (
      differenceInDays % interval !== 0
    ) {
      return false
    }

    occurrenceNumber =
      differenceInDays / interval + 1
  }

  if (calendarEvent.repeatUnit === 'week') {
    const daysPerOccurrence =
      interval * 7

    if (
      differenceInDays %
        daysPerOccurrence !==
      0
    ) {
      return false
    }

    occurrenceNumber =
      differenceInDays /
        daysPerOccurrence +
      1
  }

  if (calendarEvent.repeatUnit === 'month') {
    if (targetDay !== startDay) {
      return false
    }

    const differenceInMonths =
      (targetYear - startYear) * 12 +
      (targetMonth - startMonth)

    if (
      differenceInMonths < 0 ||
      differenceInMonths % interval !== 0
    ) {
      return false
    }

    occurrenceNumber =
      differenceInMonths / interval + 1
  }

  if (calendarEvent.repeatUnit === 'year') {
    if (
      targetMonth !== startMonth ||
      targetDay !== startDay
    ) {
      return false
    }

    const differenceInYears =
      targetYear - startYear

    if (
      differenceInYears < 0 ||
      differenceInYears % interval !== 0
    ) {
      return false
    }

    occurrenceNumber =
      differenceInYears / interval + 1
  }

  if (occurrenceNumber === null) {
    return false
  }

  if (
    calendarEvent.repeatEndType === 'count' &&
    calendarEvent.repeatCount !== null &&
    occurrenceNumber >
      calendarEvent.repeatCount
  ) {
    return false
  }

  return true
}

