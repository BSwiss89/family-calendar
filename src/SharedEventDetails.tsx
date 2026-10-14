import { useEffect, useRef } from 'react'
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
        // Close is the only focusable item in this read-only dialog.
        key.preventDefault()
        closeRef.current?.focus()
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
          This is a view-only invitation. You cannot edit or delete the
          sending family's event, and their other events stay private.
        </p>
        <button type="button" className="shared-details-done"
          onClick={onClose}>Close</button>
      </section>
    </div>, document.body
  )
}
