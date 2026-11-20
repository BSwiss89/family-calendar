import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { emojiMarkerOccursOnDate, type EmojiMarkerData } from '../Server/emoji-marker-rules.mjs'
import './EmojiCalendarMarkers.css'

export function useCalendarEmojiMarkers() {
  const [markers, setMarkers] = useState<EmojiMarkerData[]>([])
  const reload = useCallback(async () => {
    const response = await fetch('/api/emoji-markers', { credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) throw new Error('Could not load emoji markers.')
    const data: EmojiMarkerData[] = await response.json()
    setMarkers(Array.isArray(data) ? data : [])
  }, [])
  useEffect(() => {
    void reload().catch(() => {})
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reload])
  return { markers, reload }
}

export function EmojiMarkerDayButton({
  dateKey, markers, onOpen,
}: {
  dateKey: string
  markers: EmojiMarkerData[]
  onOpen: (date: string) => void
}) {
  const visible = markers.filter((marker) => emojiMarkerOccursOnDate(marker, dateKey))
  // Only existing markers appear in date corners. Creation lives in Add Event.
  if (!visible.length) return null
  const description = visible.map((marker) => marker.label ? marker.emoji + ' ' + marker.label : marker.emoji).join(', ')
  return (
    <button
      className={'emoji-marker-day-button' + (visible.length ? ' emoji-marker-has-value' : '')}
      type="button"
      aria-label={description + ' — edit markers for ' + dateKey}
      title={description}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); onOpen(dateKey) }}
    >
      <>
        {visible.slice(0, 2).map((marker) => (
          <span key={marker.id} aria-hidden="true">{marker.emoji}</span>
        ))}
        {visible.length > 2 && <small>+{visible.length - 2}</small>}
      </>
    </button>
  )
}

const quickEmojis = ['💵', '💰', '🎂', '🎉', '❤️', '⭐', '✅', '🏆', '🧾', '🏡', '🚗', '💊', '✈️', '📌']
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
type RepeatUnit = 'none' | 'day' | 'week' | 'month' | 'year'
type EndType = 'never' | 'date' | 'count'
type EditScope = 'series' | 'occurrence'

async function markerRequest(url: string, method: string, payload?: unknown) {
  const response = await fetch(url, {
    method, credentials: 'same-origin',
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || 'Could not save the emoji marker.')
}

function displayDate(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  })
}

/**
 * An icon-only creation/editing form embedded INSIDE the ordinary Add Event
 * modal. It writes only emoji_markers and never submits the event form.
 */
export function EmojiMarkerEventForm({
  dateKey, markers, manageExisting, onCancel, onSaved,
}: {
  dateKey: string
  markers: EmojiMarkerData[]
  manageExisting: boolean
  onCancel: () => void
  onSaved: () => Promise<void>
}) {
  const onDate = markers.filter((marker) => emojiMarkerOccursOnDate(marker, dateKey))
  const original = manageExisting && onDate.length === 1 ? onDate[0] : null
  const [chooseExisting, setChooseExisting] = useState(manageExisting && onDate.length > 1)
  const [editingId, setEditingId] = useState<number | null>(original?.id ?? null)
  const editing = markers.find((marker) => marker.id === editingId) ?? null
  const [formDate, setFormDate] = useState(dateKey)
  const [emoji, setEmoji] = useState(original?.emoji ?? '💵')
  const [label, setLabel] = useState(original?.label ?? '')
  const [repeatUnit, setRepeatUnit] = useState<RepeatUnit>(original?.repeatUnit ?? 'none')
  const [interval, setInterval] = useState(original?.repeatInterval ?? 1)
  const [repeatWeekdays, setRepeatWeekdays] = useState<number[]>(
    original?.repeatWeekdays ?? [new Date(dateKey + 'T12:00:00').getDay()]
  )
  const [monthPattern, setMonthPattern] = useState<'date' | 'nth-weekday' | 'last-weekday'>(
    original?.repeatMonthPattern ?? 'date'
  )
  const [endType, setEndType] = useState<EndType>(original?.repeatEndType ?? 'never')
  const [endDate, setEndDate] = useState(original?.repeatEndDate ?? '')
  const [endCount, setEndCount] = useState(original?.repeatCount ?? 10)
  const [scope, setScope] = useState<EditScope>('series')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selectedStartDate = editing?.date ?? formDate
  const [startYear, startMonth, startDay] = selectedStartDate.split('-').map(Number)
  const weekday = new Date(startYear, startMonth - 1, startDay).toLocaleDateString(
    undefined, { weekday: 'long' }
  )
  const ordinal = ['first', 'second', 'third', 'fourth', 'fifth'][Math.floor((startDay - 1) / 7)]
  const monthDaySuffix = startDay % 100 >= 11 && startDay % 100 <= 13 ? 'th' :
    startDay % 10 === 1 ? 'st' : startDay % 10 === 2 ? 'nd' : startDay % 10 === 3 ? 'rd' : 'th'

  function resetNew() {
    setEditingId(null)
    setFormDate(dateKey)
    setEmoji('💵')
    setLabel('')
    setRepeatUnit('none')
    setInterval(1)
    setRepeatWeekdays([new Date(dateKey + 'T12:00:00').getDay()])
    setMonthPattern('date')
    setEndType('never')
    setEndDate('')
    setEndCount(10)
    setScope('series')
    setError('')
    setChooseExisting(false)
  }

  function selectExisting(marker: EmojiMarkerData) {
    setEditingId(marker.id)
    setFormDate(dateKey)
    setEmoji(marker.emoji)
    setLabel(marker.label)
    setRepeatUnit(marker.repeatUnit ?? 'none')
    setInterval(marker.repeatInterval ?? 1)
    setRepeatWeekdays(marker.repeatWeekdays ?? [new Date(marker.date + 'T12:00:00').getDay()])
    setMonthPattern(marker.repeatMonthPattern ?? 'date')
    setEndType(marker.repeatEndType ?? 'never')
    setEndDate(marker.repeatEndDate ?? '')
    setEndCount(marker.repeatCount ?? 10)
    setScope('series')
    setError('')
    setChooseExisting(false)
  }

  function changeRepeat(choice: string) {
    if (choice === 'two-weeks') {
      setRepeatUnit('week')
      setInterval(2)
    } else {
      setRepeatUnit(choice as RepeatUnit)
      setInterval(1)
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (editing?.repeatUnit && scope === 'occurrence') {
        await markerRequest('/api/emoji-markers/' + editing.id + '/change-occurrence', 'POST', {
          occurrenceDate: dateKey, emoji, label,
        })
      } else {
        const payload = {
          date: selectedStartDate,
          emoji, label,
          repeatUnit: repeatUnit === 'none' ? null : repeatUnit,
          repeatInterval: interval,
          repeatWeekdays: repeatUnit === 'week' ? repeatWeekdays : null,
          repeatMonthPattern: repeatUnit === 'month' ? monthPattern : null,
          repeatEndType: endType,
          repeatEndDate: endType === 'date' ? endDate : null,
          repeatCount: endType === 'count' ? endCount : null,
        }
        await markerRequest(
          editing ? '/api/emoji-markers/' + editing.id : '/api/emoji-markers',
          editing ? 'PUT' : 'POST',
          payload,
        )
      }
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the icon.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(choice: 'day' | 'future' | 'series') {
    if (!editing || busy) return
    setBusy(true)
    setError('')
    try {
      const url = '/api/emoji-markers/' + editing.id
      if (!editing.repeatUnit || choice === 'series') {
        await markerRequest(url, 'DELETE')
      } else if (choice === 'day') {
        await markerRequest(url + '/exceptions', 'POST', { occurrenceDate: dateKey })
      } else {
        await markerRequest(url + '/truncate', 'POST', { occurrenceDate: dateKey })
      }
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete the icon.')
    } finally {
      setBusy(false)
    }
  }

  if (chooseExisting) {
    return (
      <section className="emoji-marker-event-form emoji-marker-inline" aria-label="Icons on this date">
        <p className="event-selected-date">Icons for <strong>{displayDate(dateKey)}</strong></p>
        <div className="emoji-marker-existing">
          {onDate.map((marker) => (
            <button key={marker.id} type="button" className="emoji-marker-existing-row"
              onClick={() => selectExisting(marker)}>
              <span className="emoji-marker-existing-symbol">{marker.emoji}</span>
              <span>{marker.label || 'Icon'}<small>{marker.repeatUnit ? 'Repeating' : 'One time'}</small></span>
              <span aria-hidden="true">Edit ›</span>
            </button>
          ))}
        </div>
        <div className="event-form-actions">
          <button type="button" className="event-form-cancel-button" onClick={onCancel}>Cancel</button>
          <button type="button" className="add-event-button" onClick={resetNew}>+ Add another icon</button>
        </div>
      </section>
    )
  }

  return (
    <form className="event-form emoji-marker-event-form emoji-marker-inline" onSubmit={(event) => void save(event)}>
      <p className="emoji-marker-mode-note">
        Icon Only adds a small symbol to a calendar date. It does not create an event, take an event slot, or notify anyone.
      </p>
      {editing ? (
        <p className="event-selected-date">
          Editing icon on <strong>{displayDate(dateKey)}</strong>
        </p>
      ) : (
        <label className="event-field">
          Date
          <input className="event-input" type="date" value={formDate} required
            onChange={(event) => {
              const nextDate = event.target.value
              setFormDate(nextDate)
              if (/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) {
                setRepeatWeekdays([new Date(nextDate + 'T12:00:00').getDay()])
              }
            }} />
        </label>
      )}

      <label className="event-field" htmlFor="add-event-emoji-icon">Icon</label>
      <input id="add-event-emoji-icon" className="event-input emoji-marker-emoji-input"
        type="text" value={emoji} maxLength={24} required autoComplete="off"
        aria-describedby="add-event-emoji-hint"
        onChange={(event) => setEmoji(event.target.value)} />
      <span id="add-event-emoji-hint" className="small-message">
        Pick an emoji or use your keyboard's emoji picker.
      </span>

      <div className="emoji-marker-quick-picker" aria-label="Suggested icons">
        {quickEmojis.map((item) => (
          <button key={item} type="button" aria-label={'Use ' + item}
            className={emoji === item ? 'selected' : ''}
            onClick={() => setEmoji(item)}>{item}</button>
        ))}
      </div>
      <label className="event-field" htmlFor="add-event-emoji-name">
        Name (optional)
      </label>
      <input id="add-event-emoji-name" className="event-input" type="text"
        maxLength={80} value={label} placeholder="e.g. Payday"
        onChange={(event) => setLabel(event.target.value)} />

      {editing?.repeatUnit && (
        <label className="event-field" htmlFor="add-event-emoji-scope">
          Apply changes to
          <select id="add-event-emoji-scope" className="event-input" value={scope}
            onChange={(event) => setScope(event.target.value as EditScope)}>
            <option value="series">Entire repeating series</option>
            <option value="occurrence">Only {displayDate(dateKey)}</option>
          </select>
        </label>
      )}

      {scope === 'series' && (
        <>
          <label className="event-field" htmlFor="add-event-emoji-repeat">
            Repeat
            <select id="add-event-emoji-repeat" className="event-input"
              value={repeatUnit === 'week' && interval === 2 ? 'two-weeks' : repeatUnit}
              onChange={(event) => changeRepeat(event.target.value)}>
              <option value="none">Does not repeat</option>
              <option value="day">Daily</option>
              <option value="week">Weekly</option>
              <option value="two-weeks">Every 2 weeks (payday)</option>
              <option value="month">Monthly</option>
              <option value="year">Yearly</option>
            </select>
          </label>
          {repeatUnit !== 'none' && (
            <>
              <label className="event-field" htmlFor="add-event-emoji-interval">
                Every how many {repeatUnit === 'day' ? 'days' :
                  repeatUnit === 'week' ? 'weeks' : repeatUnit === 'month' ? 'months' : 'years'}?
                <input id="add-event-emoji-interval" className="event-input"
                  type="number" min="1" max="365" required value={interval}
                  onChange={(event) => setInterval(Number(event.target.value))} />
              </label>
              {repeatUnit === 'week' && (
                <fieldset className="emoji-marker-weekdays">
                  <legend>On these days</legend>
                  {weekdays.map((name, index) => (
                    <label key={name}>
                      <input type="checkbox" checked={repeatWeekdays.includes(index)}
                        onChange={(event) =>
                          setRepeatWeekdays((current) => event.target.checked
                            ? [...current, index].sort()
                            : current.filter((value) => value !== index))} />
                      {name}
                    </label>
                  ))}
                </fieldset>
              )}
              {repeatUnit === 'month' && (
                <label className="event-field" htmlFor="add-event-emoji-month-pattern">
                  Monthly on
                  <select id="add-event-emoji-month-pattern" className="event-input"
                    value={monthPattern} onChange={(event) =>
                      setMonthPattern(event.target.value as typeof monthPattern)}>
                    <option value="date">The {startDay}{monthDaySuffix} (skip months without this date)</option>
                    <option value="nth-weekday">The {ordinal} {weekday}</option>
                    <option value="last-weekday">The last {weekday}</option>
                  </select>
                </label>
              )}
              <label className="event-field" htmlFor="add-event-emoji-end">
                Ends
                <select id="add-event-emoji-end" className="event-input"
                  value={endType} onChange={(event) =>
                    setEndType(event.target.value as EndType)}>
                  <option value="never">Never</option>
                  <option value="date">On a date</option>
                  <option value="count">After a number of occurrences</option>
                </select>
              </label>
              {endType === 'date' && (
                <label className="event-field">End date
                  <input className="event-input" type="date" min={selectedStartDate}
                    value={endDate} required
                    onChange={(event) => setEndDate(event.target.value)} />
                </label>
              )}
              {endType === 'count' && (
                <label className="event-field">Number of occurrences
                  <input className="event-input" type="number" min="1" max="1000"
                    value={endCount} required
                    onChange={(event) => setEndCount(Number(event.target.value))} />
                </label>
              )}
            </>
          )}
        </>
      )}

      {error && <p className="emoji-marker-error" role="alert">{error}</p>}
      <div className="event-form-actions">
        <button type="button" className="event-form-cancel-button" onClick={onCancel}
          disabled={busy}>Cancel</button>
        <button type="submit" className="add-event-button" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save Icon' : 'Add Icon'}
        </button>
      </div>
      {editing && (
        <div className="emoji-marker-delete-actions">
          {editing.repeatUnit ? (
            <>
              <button type="button" disabled={busy} onClick={() => void remove('day')}>Remove this day</button>
              <button type="button" disabled={busy} onClick={() => void remove('future')}>Remove this & future</button>
              <button type="button" disabled={busy} onClick={() => void remove('series')}>Delete entire series</button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => void remove('series')}>Delete icon</button>
          )}
        </div>
      )}
    </form>
  )
}
