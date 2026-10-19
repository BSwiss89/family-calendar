import { formatSharedDate, formatSharedTime, sharedEventsInRange, type AcceptedSharedEvent } from './sharedEventOverlay'
import './SharedEventsOverlay.css'

type Props = {
  events: readonly AcceptedSharedEvent[]
  startDate: string
  endDate: string
}

/**
 * A read-only overlay within the recipient's calendar, NOT a subscription
 * to the sender's calendar. No source event IDs or editable local event IDs.
 */
export default function SharedEventsOverlay({ events, startDate, endDate }: Props) {
  const visible = sharedEventsInRange(events, startDate, endDate)
  if (visible.length === 0) return null

  return (
    <section className="received-shared-events" aria-label="Events shared with our household">
      <div className="received-shared-events-heading">
        <strong>Shared with our family</strong>
        <span>Only events others specifically shared with us</span>
      </div>
      <div className="received-shared-events-scroll">
        {visible.map(event => (
          <article className="received-shared-event" key={event.shareId}
            aria-label={`${event.title}, shared by ${event.sharedBy}`}>
            <span className="received-shared-event-date">
              {formatSharedDate(event.date)}
              {event.endDate && event.endDate !== event.date
                ? ` – ${formatSharedDate(event.endDate)}`
                : ''}
              {' · '}{formatSharedTime(event.time)}
            </span>
            <strong className="received-shared-event-title">{event.title}</strong>
            <span className="received-shared-event-source">
              Shared by {event.sharedBy} · Read only
            </span>
          </article>
        ))}
      </div>
    </section>
  )
}
