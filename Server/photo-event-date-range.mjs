// Pure parsing guard for calendar dates detected in photographed flyers.
// An AI response may preserve a visible span in its dateText while returning
// only the first day. Never turn a clock-time range into a date range.
const validMonth = value => Number.isInteger(value) && value >= 1 && value <= 12
const validDay = value => Number.isInteger(value) && value >= 1 && value <= 31

export function resolvePhotoEventEndDate({
  dateText = '',
  startMonth,
  startDay,
  modelEndMonth = null,
  modelEndDay = null,
  modelEndYear = null,
}) {
  const empty = { endMonth: null, endDay: null, endYear: null }
  if (!validMonth(startMonth) || !validDay(startDay)) return empty
  const text = typeof dateText === 'string' ? dateText : ''

  // Examples: December 8th - 10th, 2026; Dec 8–10, 2026.
  const sameMonth = text.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:[-–—]|to|through|thru)\s*(\d{1,2})(?:st|nd|rd|th)?\b/i
  )
  if (
    sameMonth &&
    Number(sameMonth[1]) === startDay &&
    validDay(Number(sameMonth[2])) &&
    Number(sameMonth[2]) > startDay
  ) {
    return {
      endMonth: startMonth,
      endDay: Number(sameMonth[2]),
      endYear: Number.isInteger(modelEndYear) ? modelEndYear : null,
    }
  }

  // Examples: 12/08/2026 - 12/10/2026; 12/8-12/10.
  const numericRange = text.match(
    /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\s*(?:[-–—]|to|through)\s*(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/i
  )
  if (
    numericRange &&
    Number(numericRange[1]) === startMonth &&
    Number(numericRange[2]) === startDay &&
    validMonth(Number(numericRange[3])) &&
    validDay(Number(numericRange[4]))
  ) {
    return {
      endMonth: Number(numericRange[3]),
      endDay: Number(numericRange[4]),
      endYear: Number.isInteger(modelEndYear) ? modelEndYear : null,
    }
  }

  // Use the vision model's explicit end fields only when the captured date
  // text actually contains a range separator. This avoids inventing spans.
  const looksLikeRange =
    /(?:\d(?:st|nd|rd|th)?\s*)(?:[-–—]|\bto\b|\bthrough\b|\bthru\b)\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+)?\d/i.test(text)
  if (
    looksLikeRange &&
    validMonth(modelEndMonth) &&
    validDay(modelEndDay) &&
    (modelEndMonth !== startMonth || modelEndDay > startDay)
  ) {
    return {
      endMonth: modelEndMonth,
      endDay: modelEndDay,
      endYear: Number.isInteger(modelEndYear) ? modelEndYear : null,
    }
  }
  return empty
}
