import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  formatSharedTime,
  type AcceptedSharedEvent,
} from './sharedEventOverlay'
import './SharedEventDetails.css'

type Props = {
  event: AcceptedSharedEvent | null
  onClose: () => void
}

function longDate(value: string) {
  return new Date(value + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Details for a received event snapshot: never use local event IDs/edit APIs. */
export default function SharedEventDetails({ event, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setRemoving(false)
    setError('')
  }, [event?.shareId])

  async function removeFromMyCalendar() {
    if (!event || removing) return
    if (!window.confirm(
      'Remove "' + event.title + '" from your family calendar? ' +
      'This will not delete the sending family\'s event or affect anyone else. ' +
      'The sender can invite your family again later.'
    )) return
    setRemoving(true)
    setError('')
    try {
      // shareId refers to a centrally authorized received snapshot, never
      // a household-local /api/events ID or the sender's calendar database.
      const response = await fetch('/api/shared-events/' + event.shareId + '/received', {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
      })
      const validJson = (response.headers.get('content-type') ?? '')
        .toLowerCase().includes('application/json')
      if (!response.ok || !validJson) throw new Error('Could not remove shared event.')
      const result: unknown = await response.json()
      if (!result || typeof result !== 'object' ||
        !('shareId' in result) || result.shareId !== event.shareId ||
        !('status' in result) || result.status !== 'removed') {
        throw new Error('The sharing service did not confirm removal.')
      }
      window.dispatchEvent(new Event('family-calendar:shared-events-changed'))
      onClose()
    } catch {
      setError('Could not remove the shared event. Refresh and try again.')
    } finally {
      setRemoving(false)
    }
  }

  useEffect(() => {
    if (!event) return
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKeyDown = (key: KeyboardEvent) => {
      if (key.key === 'Escape') {
        key.preventDefault()
        key.stopPropagation()
        onClose()
      } else if (key.key === 'Tab') {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(
          '.shared-details-panel button:not([disabled])'
        ))
        if (!buttons.length) return
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        if (key.shiftKey && (document.activeElement === first ||
          !buttons.includes(document.activeElement as HTMLButtonElement))) {
          key.preventDefault()
          last.focus()
        } else if (!key.shiftKey && document.activeElement === last) {
          key.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    }
  }, [event, onClose])

  if (!event) return null
  return createPortal(
    <div className="shared-details-layer">
      <button type="button" className="shared-details-backdrop"
        aria-label="Close shared event details" onClick={onClose} />
      <section className="shared-details-panel" role="dialog" aria-modal="true"
        aria-labelledby="shared-details-title">
        <header className="shared-details-header">
          <div>
            <span className="shared-details-label">Shared event · Read only</span>
            <h2 id="shared-details-title">{event.title}</h2>
            <p>Shared by {event.sharedBy}</p>
          </div>
          <button ref={closeRef} type="button" className="shared-details-close"
            aria-label="Close shared event details" onClick={onClose}>×</button>
        </header>
        <dl className="shared-details-rows">
          <div><dt>Date</dt><dd>{longDate(event.date)}
            {event.endDate && event.endDate !== event.date
              ? ' – ' + longDate(event.endDate)
              : ''}</dd></div>
          <div><dt>Time</dt><dd>{formatSharedTime(event.time)}
            {event.endTime ? ' – ' + formatSharedTime(event.endTime) : ''}</dd></div>
          <div><dt>From</dt><dd>{event.sharedBy}</dd></div>
        </dl>
        <p className="shared-details-footnote">
          You cannot edit or delete the sending family's event.
          You can remove this shared copy from your own family calendar.
          The sending family and all other events stay unaffected.
        </p>
        {error && <p role="alert" className="shared-details-error">{error}</p>}
        <div className="shared-details-actions">
          <button type="button" className="shared-details-remove"
            disabled={removing}
            onClick={() => { void removeFromMyCalendar() }}>
            {removing ? 'Removing…' : 'Remove from My Calendar'}
          </button>
          <button type="button" className="shared-details-done"
            onClick={onClose}>Close</button>
        </div>
      </section>
    </div>, document.body
  )
}
