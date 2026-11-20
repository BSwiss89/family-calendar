import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { emojiMarkerOccursOnDate, type EmojiMarkerData } from './emojiMarkerRules.mjs'
import './EmojiCalendarMarkers.css'

export function useCalendarEmojiMarkers() {
  const [markers, setMarkers] = useState<EmojiMarkerData[]>([])
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
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
  useEffect(() => {
    if (selectedDate) void reload().catch(() => {})
  }, [selectedDate, reload])
  return { markers, selectedDate, setSelectedDate, reload }
}

export function EmojiMarkerDayButton({
  dateKey, markers, onOpen,
}: {
  dateKey: string
  markers: EmojiMarkerData[]
  onOpen: (date: string) => void
}) {
  const visible = markers.filter((marker) => emojiMarkerOccursOnDate(marker, dateKey))
  const description = visible.length
    ? visible.map((marker) => marker.label ? marker.emoji + ' ' + marker.label : marker.emoji).join(', ')
    : 'Add emoji marker'
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
      {visible.length ? (
        <>
          {visible.slice(0, 2).map((marker) => (
            <span key={marker.id} aria-hidden="true">{marker.emoji}</span>
          ))}
          {visible.length > 2 && <small>+{visible.length - 2}</small>}
        </>
      ) : <span className="emoji-marker-day-add" aria-hidden="true">+</span>}
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

export function EmojiMarkerEditor({
  dateKey, markers, onClose, onChanged,
}: {
  dateKey: string
  markers: EmojiMarkerData[]
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const onDate = markers.filter((marker) => emojiMarkerOccursOnDate(marker, dateKey))
  const [editing, setEditing] = useState<EmojiMarkerData | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [emoji, setEmoji] = useState('💵')
  const [label, setLabel] = useState('')
  const [repeatUnit, setRepeatUnit] = useState<RepeatUnit>('none')
  const [interval, setInterval] = useState(1)
  const [repeatWeekdays, setRepeatWeekdays] = useState<number[]>([])
  const [monthPattern, setMonthPattern] = useState<'date' | 'nth-weekday' | 'last-weekday'>('date')
  const [endType, setEndType] = useState<EndType>('never')
  const [endDate, setEndDate] = useState('')
  const [endCount, setEndCount] = useState(10)
  const [scope, setScope] = useState<EditScope>('series')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = oldOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  function openForm(marker: EmojiMarkerData | null) {
    const sourceDate = marker?.date ?? dateKey
    const [year, month, day] = sourceDate.split('-').map(Number)
    setEditing(marker)
    setEmoji(marker?.emoji ?? '💵')
    setLabel(marker?.label ?? '')
    setRepeatUnit(marker?.repeatUnit ?? 'none')
    setInterval(marker?.repeatInterval ?? 1)
    setRepeatWeekdays(marker?.repeatWeekdays ?? [new Date(year, month - 1, day).getDay()])
    setMonthPattern(marker?.repeatMonthPattern ?? 'date')
    setEndType(marker?.repeatEndType ?? 'never')
    setEndDate(marker?.repeatEndDate ?? '')
    setEndCount(marker?.repeatCount ?? 10)
    setScope('series')
    setError('')
    setFormOpen(true)
  }

  function chooseRepeat(value: string) {
    if (value === 'two-weeks') {
      setRepeatUnit('week')
      setInterval(2)
    } else {
      setRepeatUnit(value as RepeatUnit)
      setInterval(1)
    }
  }

  async function save() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (editing && scope === 'occurrence' && editing.repeatUnit) {
        await markerRequest('/api/emoji-markers/' + editing.id + '/change-occurrence', 'POST', {
          occurrenceDate: dateKey, emoji, label,
        })
      } else {
        const payload = {
          date: editing?.date ?? dateKey, emoji, label,
          repeatUnit: repeatUnit === 'none' ? null : repeatUnit,
          repeatInterval: interval,
          repeatWeekdays: repeatUnit === 'week' ? repeatWeekdays : null,
          repeatMonthPattern: repeatUnit === 'month' ? monthPattern : null,
          repeatEndType: endType,
          repeatEndDate: endType === 'date' ? endDate : null,
          repeatCount: endType === 'count' ? endCount : null,
        }
        await markerRequest(editing ? '/api/emoji-markers/' + editing.id : '/api/emoji-markers',
          editing ? 'PUT' : 'POST', payload)
      }
      await onChanged()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save marker.')
    } finally { setBusy(false) }
  }

  async function removeMarker(choice: 'day' | 'future' | 'series') {
    if (!editing || busy) return
    setBusy(true)
    setError('')
    try {
      const base = '/api/emoji-markers/' + editing.id
      if (!editing.repeatUnit || choice === 'series') {
        await markerRequest(base, 'DELETE')
      } else if (choice === 'day') {
        await markerRequest(base + '/exceptions', 'POST', { occurrenceDate: dateKey })
      } else {
        await markerRequest(base + '/truncate', 'POST', { occurrenceDate: dateKey })
      }
      await onChanged()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete marker.')
    } finally { setBusy(false) }
  }

  const repeatingSeries = Boolean(editing?.repeatUnit)
  const originalDate = editing?.date ?? dateKey
  const [startY, startM, startD] = originalDate.split('-').map(Number)
  const startDate = new Date(startY, startM - 1, startD)
  const ordinal = ['first', 'second', 'third', 'fourth', 'fifth'][Math.floor((startD - 1) / 7)]
  const fullWeekday = startDate.toLocaleDateString(undefined, { weekday: 'long' })

  return createPortal(
    <div className="emoji-marker-backdrop" onClick={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="emoji-marker-dialog-title"
        className="emoji-marker-sheet" onClick={(event) => event.stopPropagation()}>
        <header className="emoji-marker-sheet-header">
          <div>
            <h2 id="emoji-marker-dialog-title">Day emoji markers</h2>
            <p>{displayDate(dateKey)}</p>
          </div>
          <button type="button" className="emoji-marker-close" aria-label="Close" onClick={onClose}>×</button>
        </header>
        {!formOpen ? (
          <>
            {onDate.length > 0 && <div className="emoji-marker-existing">
              {onDate.map((marker) => (
                <button type="button" key={marker.id} className="emoji-marker-existing-row"
                  onClick={() => openForm(marker)}>
                  <span className="emoji-marker-existing-symbol">{marker.emoji}</span>
                  <span>{marker.label || 'Emoji marker'}<small>{marker.repeatUnit ? 'Repeating' : 'One time'}</small></span>
                  <span aria-hidden="true">Edit ›</span>
                </button>
              ))}
            </div>}
            <button type="button" className="emoji-marker-primary" onClick={() => openForm(null)}>+ Add an emoji</button>
          </>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); void save() }}>
            <label className="emoji-marker-field-label" htmlFor="emoji-marker-input">Emoji</label>
            <input id="emoji-marker-input" className="emoji-marker-text-input emoji-marker-emoji-input"
              type="text" value={emoji} maxLength={24} onChange={(event) => setEmoji(event.target.value)}
              autoComplete="off" aria-describedby="emoji-marker-hint" required />
            <div id="emoji-marker-hint" className="emoji-marker-hint">Choose any single emoji, including ones from your keyboard.</div>
            <div className="emoji-marker-quick-picker">
              {quickEmojis.map((item) => (
                <button key={item} type="button" aria-label={'Use ' + item}
                  className={emoji === item ? 'selected' : ''} onClick={() => setEmoji(item)}>{item}</button>
              ))}
            </div>

            <label className="emoji-marker-field-label" htmlFor="emoji-marker-label">Name (optional)</label>
            <input id="emoji-marker-label" type="text" className="emoji-marker-text-input"
              maxLength={80} placeholder="e.g. Payday" value={label} onChange={(event) => setLabel(event.target.value)} />

            {repeatingSeries && (
              <div className="emoji-marker-edit-scope">
                <label className="emoji-marker-field-label" htmlFor="emoji-marker-scope">Apply changes to</label>
                <select id="emoji-marker-scope" value={scope}
                  onChange={(event) => setScope(event.target.value as EditScope)}>
                  <option value="series">Entire repeating series</option>
                  <option value="occurrence">Only {displayDate(dateKey)}</option>
                </select>
              </div>
            )}
            {scope === 'series' && (
              <>
                <label className="emoji-marker-field-label" htmlFor="emoji-marker-repeat">Repeat</label>
                <select id="emoji-marker-repeat" value={repeatUnit === 'week' && interval === 2 ? 'two-weeks' : repeatUnit}
                  onChange={(event) => chooseRepeat(event.target.value)}>
                  <option value="none">Does not repeat</option>
                  <option value="day">Daily</option>
                  <option value="week">Weekly</option>
                  <option value="two-weeks">Every 2 weeks (payday)</option>
                  <option value="month">Monthly</option>
                  <option value="year">Yearly</option>
                </select>
                {repeatUnit !== 'none' && (
                  <>
                    <label className="emoji-marker-field-label" htmlFor="emoji-marker-interval">
                      Every how many {repeatUnit === 'day' ? 'days' : repeatUnit === 'week' ? 'weeks' : repeatUnit === 'month' ? 'months' : 'years'}?
                    </label>
                    <input id="emoji-marker-interval" type="number" min={1} max={365} value={interval}
                      className="emoji-marker-text-input" onChange={(event) => setInterval(Number(event.target.value))} />
                    {repeatUnit === 'week' && <fieldset className="emoji-marker-weekdays">
                      <legend>On these days</legend>
                      {weekdays.map((day, index) => (
                        <label key={day}>
                          <input type="checkbox" checked={repeatWeekdays.includes(index)}
                            onChange={(event) => setRepeatWeekdays((current) =>
                              event.target.checked ? [...current, index].sort() : current.filter((item) => item !== index))} />
                          {day}
                        </label>
                      ))}
                    </fieldset>}
                    {repeatUnit === 'month' && <>
                      <label className="emoji-marker-field-label" htmlFor="emoji-marker-month-pattern">Monthly on</label>
                      <select id="emoji-marker-month-pattern" value={monthPattern}
                        onChange={(event) => setMonthPattern(event.target.value as typeof monthPattern)}>
                        <option value="date">The {startD}{startD % 10 === 1 && startD !== 11 ? 'st' : startD % 10 === 2 && startD !== 12 ? 'nd' : startD % 10 === 3 && startD !== 13 ? 'rd' : 'th'}</option>
                        <option value="nth-weekday">The {ordinal} {fullWeekday}</option>
                        <option value="last-weekday">The last {fullWeekday}</option>
                      </select>
                    </>}
                    <label className="emoji-marker-field-label" htmlFor="emoji-marker-end">Ends</label>
                    <select id="emoji-marker-end" value={endType} onChange={(event) => setEndType(event.target.value as EndType)}>
                      <option value="never">Never</option>
                      <option value="date">On a date</option>
                      <option value="count">After a number of occurrences</option>
                    </select>
                    {endType === 'date' && <input aria-label="Repeat end date" className="emoji-marker-text-input"
                      type="date" min={originalDate} value={endDate} onChange={(event) => setEndDate(event.target.value)} />}
                    {endType === 'count' && <input aria-label="Number of occurrences" className="emoji-marker-text-input"
                      type="number" min={1} max={1000} value={endCount} onChange={(event) => setEndCount(Number(event.target.value))} />}
                  </>
                )}
              </>
            )}

            {error && <p className="emoji-marker-error" role="alert">{error}</p>}
            <div className="emoji-marker-actions">
              <button type="button" className="emoji-marker-secondary" onClick={() => { setFormOpen(false); setEditing(null) }}
                disabled={busy}>Back</button>
              <button type="submit" className="emoji-marker-primary" disabled={busy}>{busy ? 'Saving…' : 'Save emoji'}</button>
            </div>
            {editing && <div className="emoji-marker-delete-actions">
              {editing.repeatUnit ? (
                <>
                  <button type="button" disabled={busy} onClick={() => void removeMarker('day')}>Remove this day</button>
                  <button type="button" disabled={busy} onClick={() => void removeMarker('future')}>Remove this & future</button>
                  <button type="button" disabled={busy} onClick={() => void removeMarker('series')}>Delete entire series</button>
                </>
              ) : <button type="button" disabled={busy} onClick={() => void removeMarker('series')}>Delete emoji</button>}
            </div>}
          </form>
        )}
      </section>
    </div>,
    document.body
  )
}
