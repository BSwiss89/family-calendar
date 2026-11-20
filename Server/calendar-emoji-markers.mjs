import { emojiMarkerOccursOnDate, normalizeEmojiMarkerPayload, previousEmojiDate, validEmojiDate } from './emoji-marker-rules.mjs'

// A marker is not an event: no invitations, attendee rows, notifications or event slots.
// This uses the already-selected environment's SQLite connection. Authentication is
// installed by index.mjs BEFORE these routes are registered.
export function installCalendarEmojiMarkers(app, database) {
  database.exec([
    'CREATE TABLE IF NOT EXISTS emoji_markers (',
    'id INTEGER PRIMARY KEY,',
    'date TEXT NOT NULL, emoji TEXT NOT NULL, label TEXT NOT NULL DEFAULT \'\',',
    'repeat_unit TEXT, repeat_interval INTEGER, repeat_weekdays TEXT,',
    'repeat_month_pattern TEXT, repeat_end_type TEXT, repeat_end_date TEXT,',
    'repeat_count INTEGER',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS emoji_marker_exceptions (',
    'marker_id INTEGER NOT NULL, occurrence_date TEXT NOT NULL,',
    'PRIMARY KEY (marker_id, occurrence_date),',
    'FOREIGN KEY (marker_id) REFERENCES emoji_markers(id) ON DELETE CASCADE',
    ') STRICT;',
  ].join('\n'))

  const selectRows = database.prepare([
    'SELECT id, date, emoji, label, repeat_unit AS repeatUnit,',
    'repeat_interval AS repeatInterval, repeat_weekdays AS repeatWeekdaysJson,',
    'repeat_month_pattern AS repeatMonthPattern, repeat_end_type AS repeatEndType,',
    'repeat_end_date AS repeatEndDate, repeat_count AS repeatCount',
    'FROM emoji_markers ORDER BY id',
  ].join(' '))
  const selectExceptions = database.prepare(
    'SELECT marker_id AS markerId, occurrence_date AS occurrenceDate FROM emoji_marker_exceptions ORDER BY occurrence_date'
  )
  const findMarker = database.prepare('SELECT id FROM emoji_markers WHERE id = ?')
  const insert = database.prepare([
    'INSERT INTO emoji_markers (date, emoji, label, repeat_unit, repeat_interval,',
    'repeat_weekdays, repeat_month_pattern, repeat_end_type, repeat_end_date, repeat_count)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ].join(' '))
  const update = database.prepare([
    'UPDATE emoji_markers SET date = ?, emoji = ?, label = ?, repeat_unit = ?,',
    'repeat_interval = ?, repeat_weekdays = ?, repeat_month_pattern = ?,',
    'repeat_end_type = ?, repeat_end_date = ?, repeat_count = ? WHERE id = ?',
  ].join(' '))
  const skip = database.prepare(
    'INSERT OR IGNORE INTO emoji_marker_exceptions (marker_id, occurrence_date) VALUES (?, ?)'
  )
  const removeExceptions = database.prepare(
    'DELETE FROM emoji_marker_exceptions WHERE marker_id = ?'
  )
  const remove = database.prepare('DELETE FROM emoji_markers WHERE id = ?')
  const stopSeries = database.prepare(
    'UPDATE emoji_markers SET repeat_end_type = ?, repeat_end_date = ?, repeat_count = NULL WHERE id = ?'
  )
  const payloadValues = (marker) => [
    marker.date, marker.emoji, marker.label, marker.repeatUnit,
    marker.repeatInterval,
    marker.repeatWeekdays ? JSON.stringify(marker.repeatWeekdays) : null,
    marker.repeatMonthPattern, marker.repeatEndType,
    marker.repeatEndDate, marker.repeatCount,
  ]
  function list() {
    const exceptions = new Map()
    for (const entry of selectExceptions.all()) {
      if (!exceptions.has(entry.markerId)) exceptions.set(entry.markerId, [])
      exceptions.get(entry.markerId).push(entry.occurrenceDate)
    }
    return selectRows.all().map(({ repeatWeekdaysJson, ...marker }) => ({
      ...marker,
      repeatWeekdays: repeatWeekdaysJson ? JSON.parse(repeatWeekdaysJson) : null,
      exceptions: exceptions.get(marker.id) ?? [],
    }))
  }
  function get(id) {
    return list().find((marker) => marker.id === id) ?? null
  }
  function parseId(request, response) {
    const id = Number(request.params.id)
    if (!Number.isSafeInteger(id) || id < 1) {
      response.status(400).json({ error: 'Invalid emoji marker ID.' })
      return null
    }
    return id
  }
  function checkOccurrence(request, response) {
    const id = parseId(request, response)
    if (id == null) return null
    const marker = get(id)
    if (!marker) {
      response.status(404).json({ error: 'Emoji marker not found.' })
      return null
    }
    const occurrenceDate = request.body?.occurrenceDate
    if (!marker.repeatUnit || !validEmojiDate(occurrenceDate) ||
        !emojiMarkerOccursOnDate(marker, occurrenceDate)) {
      response.status(400).json({ error: 'That date is not an active occurrence of this repeating emoji.' })
      return null
    }
    return { marker, occurrenceDate }
  }

  app.get('/api/emoji-markers', (_request, response) => {
    response.set('Cache-Control', 'no-store')
    response.json(list())
  })
  app.post('/api/emoji-markers', (request, response) => {
    const marker = normalizeEmojiMarkerPayload(request.body)
    if (!marker) return response.status(400).json({ error: 'Choose one emoji, a valid date and repeat settings.' })
    const result = insert.run(...payloadValues(marker))
    response.status(201).json({ id: Number(result.lastInsertRowid), success: true })
  })
  app.put('/api/emoji-markers/:id', (request, response) => {
    const id = parseId(request, response)
    if (id == null) return
    const marker = normalizeEmojiMarkerPayload(request.body)
    if (!marker) return response.status(400).json({ error: 'Invalid emoji marker settings.' })
    if (!findMarker.get(id)) return response.status(404).json({ error: 'Emoji marker not found.' })
    database.exec('BEGIN IMMEDIATE')
    try {
      update.run(...payloadValues(marker), id)
      removeExceptions.run(id) // Old skipped dates must not silently affect a changed series.
      database.exec('COMMIT')
      response.json({ success: true })
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  })
  app.delete('/api/emoji-markers/:id', (request, response) => {
    const id = parseId(request, response)
    if (id == null) return
    const result = remove.run(id)
    if (!result.changes) return response.status(404).json({ error: 'Emoji marker not found.' })
    response.json({ success: true })
  })
  app.post('/api/emoji-markers/:id/exceptions', (request, response) => {
    const result = checkOccurrence(request, response)
    if (!result) return
    skip.run(result.marker.id, result.occurrenceDate)
    response.status(201).json({ success: true })
  })
  // One-date edit replaces this instance only: skip original and insert a
  // nonrecurring replacement together, avoiding partial writes if interrupted.
  app.post('/api/emoji-markers/:id/change-occurrence', (request, response) => {
    const result = checkOccurrence(request, response)
    if (!result) return
    const replacement = normalizeEmojiMarkerPayload({
      date: result.occurrenceDate, emoji: request.body?.emoji,
      label: request.body?.label, repeatUnit: null,
    })
    if (!replacement) return response.status(400).json({ error: 'Invalid replacement emoji.' })
    database.exec('BEGIN IMMEDIATE')
    try {
      skip.run(result.marker.id, result.occurrenceDate)
      const created = insert.run(...payloadValues(replacement))
      database.exec('COMMIT')
      response.status(201).json({ id: Number(created.lastInsertRowid), success: true })
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  })
  app.post('/api/emoji-markers/:id/truncate', (request, response) => {
    const result = checkOccurrence(request, response)
    if (!result) return
    if (result.occurrenceDate === result.marker.date) {
      remove.run(result.marker.id)
      return response.json({ success: true, removedSeries: true })
    }
    const endDate = previousEmojiDate(result.occurrenceDate)
    stopSeries.run('date', endDate, result.marker.id)
    response.json({ success: true, endDate })
  })
}
