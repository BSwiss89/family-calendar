import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { IncomingEventInvitation } from './eventSharingUiModel'
import type { AssignmentNotice } from './useAssignmentInbox'
import { formatSharedDate, formatSharedTime } from './sharedEventOverlay'
import './InvitationCenter.css'

type Props = {
  available: boolean
  invitations: readonly IncomingEventInvitation[]
  respondingId: number | null
  error: string
  suppress?: boolean
  respond: (shareId: number, decision: 'accepted' | 'declined') => Promise<boolean>
  assignmentAvailable?: boolean
  assignmentNotifications?: readonly AssignmentNotice[]
  acknowledgingId?: number | null
  assignmentError?: string
  acknowledge?: (notificationId: number) => Promise<boolean>
  titleForEvent?: (eventId: number) => string | null
  openEvent?: (eventId: number) => void
}

function InvitationCards({
  invitations, respondingId, respond,
}: Pick<Props, 'invitations' | 'respondingId' | 'respond'>) {
  return (
    <div className="invitation-center-items">
      {invitations.map(invite => (
        <article key={invite.shareId} className="invitation-center-item">
          <span className="invitation-center-source">From {invite.sharedBy}</span>
          <strong>{invite.title}</strong>
          <span className="invitation-center-date">
            {formatSharedDate(invite.date)} · {formatSharedTime(invite.time)}
          </span>
          <div className="invitation-center-actions">
            <button type="button" disabled={respondingId !== null}
              className="invitation-accept"
              onClick={() => { void respond(invite.shareId, 'accepted') }}>
              {respondingId === invite.shareId ? 'Saving…' : 'Accept'}
            </button>
            <button type="button" disabled={respondingId !== null}
              className="invitation-decline"
              onClick={() => { void respond(invite.shareId, 'declined') }}>
              Decline
            </button>
          </div>
        </article>
      ))}
    </div>
  )
}

function AssignmentCards({
  items,acknowledgingId,acknowledge,titleForEvent,openEvent,
}: {
  items: readonly AssignmentNotice[]
  acknowledgingId?: number | null
  acknowledge?: (id: number) => Promise<boolean>
  titleForEvent?: (eventId: number) => string | null
  openEvent?: (eventId: number) => void
}) {
  const kindLabel: Record<AssignmentNotice['kind'],string> = {
    assigned: 'You've been assigned an event',
    changed: 'An assigned event was updated',
    unassigned: 'You were removed from an event',
    cancelled: 'An assigned event was cancelled',
  }
  return <div className="invitation-center-items">
    {items.map(item => <article className="invitation-center-item" key={'assignment-' + item.id}>
      <span className="invitation-center-source">Calendar notification</span>
      <strong>{kindLabel[item.kind]}</strong>
      <span className="invitation-center-date">
        {titleForEvent?.(item.eventId) || 'Event #' + item.eventId}
      </span>
      <div className="invitation-center-actions">
        {titleForEvent?.(item.eventId) && openEvent && <button type="button"
          className="invitation-decline"
          onClick={() => openEvent(item.eventId)}>View Event</button>}
        <button type="button" className="invitation-accept"
          disabled={acknowledgingId !== null && acknowledgingId !== undefined}
          onClick={() => { void acknowledge?.(item.id) }}>
          {acknowledgingId === item.id ? 'Saving…' : 'Acknowledge'}
        </button>
      </div>
    </article>)}
  </div>
}

/** Persistent desktop/tablet sidebar destination; never a calendar-wide share action. */
export function DesktopInvitations({
  available, invitations, respondingId, error, respond,
  assignmentAvailable = false, assignmentNotifications = [],
  acknowledgingId = null, assignmentError = '', acknowledge, titleForEvent, openEvent,
}: Props) {
  return (
    <section className="invitation-center-page" aria-label="Invitations">
      <header>
        <h2>Invitations</h2>
        <p>Review invitations and assigned-event updates in one place.</p>
      </header>
      <h3>Event invitations</h3>
      {!available || invitations.length === 0 ? (
        <p className="invitation-center-empty">No event invitations awaiting a response.</p>
      ) : <InvitationCards invitations={invitations}
          respondingId={respondingId} respond={respond} />}
      {error && <p role="alert" className="invitation-center-error">{error}</p>}
      <h3>Calendar notifications</h3>
      {!assignmentAvailable || assignmentNotifications.length === 0 ? (
        <p className="invitation-center-empty">No new calendar notifications.</p>
      ) : <AssignmentCards items={assignmentNotifications} acknowledgingId={acknowledgingId}
          acknowledge={acknowledge} titleForEvent={titleForEvent} openEvent={openEvent} />}
      {assignmentError && <p role="alert" className="invitation-center-error">{assignmentError}</p>}
    </section>
  )
}

/**
 * Remind Later does NOT decline or acknowledge an invitation on the server.
 * Hiding it lasts until the app is reloaded/reopened or returns from background.
 * Other browsers and devices retain their own independent reminder behavior.
 */
export function MobileInvitationReminder({
  available, invitations, respondingId, error, respond, suppress = false,
  assignmentAvailable = false, assignmentNotifications = [],
  acknowledgingId = null, assignmentError = '', acknowledge, titleForEvent, openEvent,
}: Props) {
  const [mobile, setMobile] = useState(() =>
    window.matchMedia('(max-width: 760px)').matches)
  const [remindLater, setRemindLater] = useState(false)
  const wasHidden = useRef(false)
  const seenInviteIds = useRef(new Set<string>())
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const update = () => setMobile(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        wasHidden.current = true
      } else if (wasHidden.current) {
        wasHidden.current = false
        setRemindLater(false)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // A genuinely new invitation (including a confirmed resend with a fresh ID)
  // must be visible, even if a previous reminder was dismissed on this device.
  useEffect(() => {
    const ids = [
      ...invitations.map(item => 'invite:' + item.shareId),
      ...assignmentNotifications.map(item => 'notification:' + item.id),
    ]
    const incoming = new Set(ids)
    const hasNew = ids.some(id => !seenInviteIds.current.has(id))
    seenInviteIds.current = incoming
    if (hasNew) setRemindLater(false)
  }, [invitations, assignmentNotifications])

  // The full inbox must be accessible after Remind Later without a duplicate
  // modal covering it. Pending invitations remain on the server until answered.
  const visible = mobile && ((available && invitations.length > 0) ||
    (assignmentAvailable && assignmentNotifications.length > 0)) && !remindLater && !suppress

  useEffect(() => {
    if (!visible) return
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement
    document.body.style.overflow = 'hidden'
    dialog.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setRemindLater(true)
        return
      }
      if (event.key !== 'Tab' || !dialog.current) return
      const buttons = Array.from(dialog.current.querySelectorAll<HTMLButtonElement>(
        'button:not([disabled])'
      ))
      if (!buttons.length) return
      const first = buttons[0]
      const last = buttons[buttons.length - 1]
      if (event.shiftKey && (document.activeElement === first ||
        !dialog.current.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last ||
        !dialog.current.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    }
  }, [visible])

  if (!visible) return null
  return createPortal(
    <div className="mobile-invitations-layer">
      <div className="mobile-invitations-backdrop" />
      <div role="dialog" aria-modal="true" aria-labelledby="mobile-invite-title"
        className="mobile-invitations-dialog" tabIndex={-1} ref={dialog}>
        <div className="mobile-invitations-header">
          <div>
            <span>Family Calendar</span>
            <h2 id="mobile-invite-title">
              {invitations.length + assignmentNotifications.length === 1
                ? 'You have a new notification'
                : 'You have ' + (invitations.length + assignmentNotifications.length) + ' new items'}
            </h2>
          </div>
          <button type="button" onClick={() => setRemindLater(true)}
            aria-label="Remind me later about these events">×</button>
        </div>
        <p className="mobile-invitations-description">
          Please respond to invitations or acknowledge calendar updates. You can ask again later without accepting or declining.
        </p>
        {invitations.length > 0 && <>
          <h3>Invitations</h3>
          <InvitationCards invitations={invitations}
            respondingId={respondingId} respond={respond} />
        </>}
        {assignmentNotifications.length > 0 && <>
          <h3>Calendar notifications</h3>
          <AssignmentCards items={assignmentNotifications} acknowledgingId={acknowledgingId}
            acknowledge={acknowledge} titleForEvent={titleForEvent} openEvent={openEvent} />
        </>}
        {error && <p role="alert" className="invitation-center-error">{error}</p>}
        {assignmentError && <p role="alert" className="invitation-center-error">{assignmentError}</p>}
        <button className="mobile-invitations-remind" type="button"
          onClick={() => setRemindLater(true)}>
          Ask Again Later
        </button>
        <p className="mobile-invitations-footnote">
          Pending invitations and unacknowledged updates stay in Invitations and will be shown again when you reopen the app.
        </p>
      </div>
    </div>,
    document.body
  )
}
