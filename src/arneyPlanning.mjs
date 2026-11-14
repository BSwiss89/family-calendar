/**
 * Arney Phase 4A: deterministic, read-only planning tools.
 * Uses the already-authenticated calendar state in App; no network, AI service,
 * database writes, external sources, or storage. The existing Ministral route
 * handles requests that do not match these narrow, verified tool capabilities.
 */
function dateKey(date) {
  const pad = n => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function daysFrom(date, offset, count) {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset + i, 12)
    return dateKey(d)
  })
}

function datesFor(text, now) {
  if (/\bnext week\b/i.test(text)) {
    return daysFrom(now, 7 - now.getDay(), 7)
  }
  if (/\bnext (?:seven|7) days\b/i.test(text)) {
    return daysFrom(now, 0, 7)
  }
  if (/\bnext weekend\b/i.test(text)) {
    const saturdayOffset = now.getDay() === 0 ? 6 : 6 - now.getDay()
    return daysFrom(now, saturdayOffset + 7, 2)
  }
  if (/\b(?:this|the) weekend\b/i.test(text)) {
    const saturdayOffset = now.getDay() === 0 ? -1 : 6 - now.getDay()
    return daysFrom(now, saturdayOffset, 2)
  }
  if (/\btomorrow\b/i.test(text)) return daysFrom(now, 1, 1)
  if (/\btoday\b/i.test(text)) return daysFrom(now, 0, 1)
  return daysFrom(now, -now.getDay(), 7)
}

function displayDay(dateKeyValue) {
  const [year, month, day] = dateKeyValue.split('-').map(Number)
  const date = new Date(year, month - 1, day, 12)
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })
}

function peopleLabel(event) {
  const names = (event.people ?? []).map(person => person?.name?.trim()).filter(Boolean)
  return names.length ? names.join(', ') : (event.person?.trim() || 'Unassigned')
}

function occurrencesIn(dates, events, occurrenceStartForDate) {
  const results = []
  const seen = new Set()
  for (const day of dates) {
    for (const event of events) {
      if (!event || !Number.isSafeInteger(event.id) || typeof event.title !== 'string') continue
      const start = occurrenceStartForDate(event, day)
      if (typeof start !== 'string') continue
      const key = event.id + ':' + start
      if (seen.has(key)) continue
      seen.add(key)
      results.push({
        event, day, start,
        time: typeof event.time === 'string' ? event.time : null,
        endTime: typeof event.endTime === 'string' ? event.endTime : null,
      })
    }
  }
  return results.sort((a, b) => a.day.localeCompare(b.day) ||
    (a.time ?? '').localeCompare(b.time ?? '') || a.event.id - b.event.id)
}

function isCalendarRead(text) {
  // Only handle clear read requests for specific date scopes. Other requests
  // stay on the existing Arney intent path; no calendar mutation can result.
  const prompt = text.replace(/^(?:hey\s+)?arney[,! ]*/i, '')
  const readVerb = /^(?:what(?:'s| is| are| do)?\b|what do (?:we|i)\b|show\b|read\b|summari[sz]e\b|give me\b|tell me\b|list\b|do (?:we|i) have\b|are there\b|any\b)/i.test(prompt)
  const period = /\b(?:today|tomorrow|this weekend|next weekend|the weekend|this week|next week|next (?:seven|7) days)\b/i.test(prompt)
  const subject = /\b(?:calendar|schedule|events?|appointments?|going on|have|happening|planned|doing|agenda)\b/i.test(prompt)
  return readVerb && period && subject
}

function isConflictRequest(text) {
  return /^(?:check|find|show|are there|do\b|does\b|where\b|any\b|look for)/i.test(text) &&
    /\b(?:conflicts?|overlaps?|overlapping|double.book(?:ed|ings?)?)\b/i.test(text)
}

function isDinnerRequest(text) {
  return /^(?:plan|suggest|give me|pick|choose|find|what (?:should|can) we cook)\b/i.test(text) &&
    /\b(?:dinners?|meals?|recipes?)\b/i.test(text) &&
    !/\b(?:online|internet|web|search the web|order|delivery)\b/i.test(text)
}

function clockMinutes(text) {
  if (typeof text !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return null
  const [h, m] = text.split(':').map(Number)
  return h * 60 + m
}

function calendarSummary(text, context, dates) {
  const mine = /\b(?:my calendar|my schedule|my events|do i have|what do i have)\b/i.test(text)
  if (mine && !context.activePersonId) {
    return 'Select your personal profile before asking about your own schedule.'
  }
  const all = occurrencesIn(dates, context.events, context.occurrenceStartForDate)
  const entries = mine
    ? all.filter(item => (item.event.people ?? []).some(p => p.id === context.activePersonId))
    : all
  const title = mine ? 'Your' : 'Family'
  const dateRange = dates.length === 1
    ? displayDay(dates[0])
    : displayDay(dates[0]) + '–' + displayDay(dates[dates.length - 1])
  if (!entries.length) return title + ' calendar: no matching events found for ' +
    dateRange + '. Accepted cross-household shares are not included.'
  const lines = entries.slice(0, 20).map(item => {
    const when = item.time ? ' at ' + item.time : ' (all day / time not set)'
    return displayDay(item.day) + ': ' + item.event.title.slice(0, 100) + when +
      ' — ' + peopleLabel(item.event) + (item.start < item.day ? ' (continues)' : '')
  })
  if (entries.length > 20) lines.push('...and ' + (entries.length - 20) + ' more. Open Calendar for the full schedule.')
  return title + ' calendar (' + dateRange + '):\n' +
    lines.join('\n') + '\nLocal household events only; accepted cross-household shares are not included. Read-only. Nothing was changed.'
}

function overlapCheck(context, dates) {
  const entries = occurrencesIn(dates, context.events, context.occurrenceStartForDate)
  const timed = entries.map(item => ({
    ...item, from: clockMinutes(item.time), to: clockMinutes(item.endTime),
  })).filter(item => item.from !== null && item.to !== null &&
    item.to > item.from && item.start === item.day)
  const overlaps = []
  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length; j += 1) {
      const a = timed[i], b = timed[j]
      if (b.day !== a.day) {
        if (b.day > a.day) break
        continue
      }
      if (a.event.id === b.event.id || a.from >= b.to || b.from >= a.to) continue
      const sharedIds = (a.event.people ?? []).filter(p =>
        (b.event.people ?? []).some(other => other.id === p.id)
      ).map(p => p.name).filter(Boolean)
      overlaps.push({
        day: a.day, a, b, sharedIds,
      })
    }
  }
  if (!overlaps.length) return 'No overlapping timed event pairs found for ' +
    displayDay(dates[0]) + '–' + displayDay(dates[6]) +
    '. This does not check events without valid start and end times, all-day events, or overnight ranges. Nothing was changed.'
  const lines = overlaps.slice(0, 10).map(({day, a, b, sharedIds}) =>
    displayDay(day) + ': ' + a.event.title.slice(0, 70) + ' (' + a.time + '–' + a.endTime +
    ') overlaps ' + b.event.title.slice(0, 70) + ' (' + b.time + '–' + b.endTime + '). ' +
    (sharedIds.length ? 'Both involve: ' + sharedIds.join(', ') + '.' : 'Different assignees or unassigned; check whether this matters.')
  )
  if (overlaps.length > 10) lines.push('...and ' + (overlaps.length - 10) + ' more overlaps.')
  return 'Possible schedule overlaps (not confirmed conflicts):\n' + lines.join('\n') +
    '\nEvents without start/end times, all-day events, overnight ranges, and cross-household shares were not checked. Nothing was changed.'
}

function dinnerDraft(text, context, dates, now) {
  const today = dateKey(now)
  const futureDates = dates.filter(day => day >= today)
  if (!futureDates.length) return 'No remaining days in that week. Ask for next week instead.'
  const count = /\b(?:seven|7)\s+(?:dinners?|meals?)\b/i.test(text) ? 7 :
    /\b(?:three|3)\s+(?:dinners?|meals?)\b/i.test(text) ? 3 :
    /\b(?:four|4)\s+(?:dinners?|meals?)\b/i.test(text) ? 4 : 5
  const planned = new Map()
  for (const meal of context.mealPlanItems ?? []) {
    if (meal.mealType === 'dinner' && typeof meal.date === 'string' &&
      typeof meal.title === 'string' && !planned.has(meal.date)) planned.set(meal.date, meal.title)
  }
  for (const legacy of context.mealPlans ?? []) {
    if (typeof legacy.date === 'string' && typeof legacy.dinner === 'string' &&
      legacy.dinner.trim() && !planned.has(legacy.date)) planned.set(legacy.date, legacy.dinner)
  }
  const existingNames = new Set([...planned.values()].map(name => name.trim().toLowerCase()))
  const unique = new Map()
  for (const recipe of context.recipes ?? []) {
    if (typeof recipe.name !== 'string' || !recipe.name.trim()) continue
    const normalized = recipe.name.trim().toLowerCase()
    if (!unique.has(normalized) && !existingNames.has(normalized)) unique.set(normalized, recipe)
  }
  const choices = [...unique.values()].sort((a, b) =>
    Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) ||
    a.name.localeCompare(b.name, 'en-US'))
  const lines = []
  let next = 0
  for (const day of futureDates) {
    if (planned.has(day)) {
      lines.push(displayDay(day) + ': Already planned — ' + planned.get(day).slice(0, 100))
      continue
    }
    if (next >= choices.length || next >= count) break
    lines.push(displayDay(day) + ': Suggested — ' + choices[next].name.slice(0, 100))
    next += 1
  }
  if (!lines.length) return 'No saved recipes are available to suggest. Add recipes first, or use the meal planner.'
  return 'Dinner ideas from your saved recipes (draft only):\n' + lines.join('\n') +
    (next < count ? '\nOnly ' + next + ' distinct unplanned recipe suggestions were available.' : '') +
    '\nNo meal plans or shopping lists were changed. Review each idea in Meals before saving.'
}

export function planArneyReadOnlyRequest(text, context) {
  if (typeof text !== 'string' || !context || !(context.now instanceof Date) ||
    Number.isNaN(context.now.getTime()) || !Array.isArray(context.events) ||
    !Array.isArray(context.recipes) || !Array.isArray(context.mealPlanItems) ||
    !Array.isArray(context.mealPlans) ||
    typeof context.occurrenceStartForDate !== 'function') return null
  const request = text.trim().replace(/[‘’]/g, "'").replace(/\s+/g, ' ')
  if (!request || request.length > 500) return null
  // Reject obvious mutation phrasing: never interpret a write as a read-only result.
  if (/^(?:add|create|delete|remove|cancel|move|reschedule|change|save|book|schedule|put)\b/i.test(request)) return null
  const dates = datesFor(request, context.now)
  let result = null
  if (isConflictRequest(request)) result = overlapCheck(context, dates)
  else if (isCalendarRead(request)) result = calendarSummary(request, context, dates)
  else if (isDinnerRequest(request)) {
    const dinnerDates = /\b(?:this week|next week|next (?:seven|7) days)\b/i.test(request)
      ? dates : daysFrom(context.now, 0, 7)
    result = dinnerDraft(request, context, dinnerDates, context.now)
  }
  return result ? { kind: 'information', text: result } : null
}
