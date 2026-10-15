import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { IncomingEventInvitation } from './eventSharingUiModel'
import { formatSharedDate, formatSharedTime } from './sharedEventOverlay'
import './InvitationCenter.css'

type Props = {
  available: boolean
  invitations: readonly IncomingEventInvitation[]
  respondingId: number | null
  error: string
  respond: (shareId: number, decision: 'accepted' | 'declined') => Promise<boolean>
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

/** Persistent desktop/tablet sidebar destination; never a calendar-wide share action. */
export function DesktopInvitations({
  available, invitations, respondingId, error, respond,
}: Props) {
  return (
    <section className="invitation-center-page" aria-label="Invitations">
      <header>
        <h2>Invitations</h2>
        <p>Review only the events other families have invited your calendar to.</p>
      </header>
      {!available ? (
        <p className="invitation-center-empty">
          Invitations are not available on this calendar.
        </p>
      ) : invitations.length === 0 ? (
        <p className="invitation-center-empty">No invitations awaiting a response.</p>
      ) : (
        <InvitationCards invitations={invitations}
          respondingId={respondingId} respond={respond} />
      )}
      {error && <p role="alert" className="invitation-center-error">{error}</p>}
    </section>
  )
}

/**
 * Remind Later does NOT decline or acknowledge an invitation on the server.
 * Hiding it lasts until the app is reloaded/reopened or returns from background.
 * Other browsers and devices retain their own independent reminder behavior.
 */
export function MobileInvitationReminder({
  available, invitations, respondingId, error, respond,
}: Props) {
  const [mobile, setMobile] = useState(() =>
    window.matchMedia('(max-width: 760px)').matches)
  const [remindLater, setRemindLater] = useState(false)
  const wasHidden = useRef(false)
  const seenInviteIds = useRef(new Set<number>())
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
    const incoming = new Set(invitations.map(item => item.shareId))
    const hasNew = invitations.some(item => !seenInviteIds.current.has(item.shareId))
    seenInviteIds.current = incoming
    if (hasNew) setRemindLater(false)
  }, [invitations])

  const visible = mobile && available && invitations.length > 0 && !remindLater

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
              {invitations.length === 1 ? 'You have an invitation' :
                'You have ' + invitations.length + ' invitations'}
            </h2>
          </div>
          <button type="button" onClick={() => setRemindLater(true)}
            aria-label="Remind me later about these events">×</button>
        </div>
        <p className="mobile-invitations-description">
          Accept an event to add a read-only copy to your family's calendar,
          or decline it. No other calendar events are shared.
        </p>
        <InvitationCards invitations={invitations}
          respondingId={respondingId} respond={respond} />
        {error && <p role="alert" className="invitation-center-error">{error}</p>}
        <button className="mobile-invitations-remind" type="button"
          onClick={() => setRemindLater(true)}>
          Remind Later
        </button>
        <p className="mobile-invitations-footnote">
          Pending invitations will be shown again when you next open the app.
        </p>
      </div>
    </div>,
    document.body
  )
}
