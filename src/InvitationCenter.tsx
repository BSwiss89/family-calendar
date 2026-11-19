import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { IncomingEventInvitation } from './eventSharingUiModel'
import type { AssignmentNotice, AssignmentChangeField } from './useAssignmentInbox'
import type { FamilyEventInvitation } from './useFamilyEventInvitations'
import { formatSharedDate, formatSharedTime } from './sharedEventOverlay'
import './InvitationCenter.css'

type AssignmentEventDetails = {
  title: string
  date: string
  endDate: string | null
  time: string | null
  endTime: string | null
  location: string | null
  notes: string | null
  repeatUnit: string | null
  repeatInterval: number | null
  repeatEndType: string | null
  repeatEndDate: string | null
  repeatCount: number | null
}
const repeatChangeFields = new Set<AssignmentChangeField>([
  'repeatUnit','repeatInterval','repeatEndType','repeatEndDate','repeatCount',
])
function repeatDescription(event: AssignmentEventDetails) {
  const unit = event.repeatUnit?.toLowerCase()
  if (!unit || unit === 'none') return 'No longer repeating'
  const labels: Record<string,string> = {
    daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year',
  }
  const period = labels[unit]
  if (!period) return 'Repeat settings updated — open event to review'
  const interval = event.repeatInterval && event.repeatInterval > 0
    ? event.repeatInterval : 1
  let value = interval === 1 ? 'Every ' + period
    : 'Every ' + interval + ' ' + period + 's'
  if (event.repeatEndType === 'date' && event.repeatEndDate) {
    value += ' until ' + formatSharedDate(event.repeatEndDate)
  } else if (event.repeatEndType === 'count' && event.repeatCount) {
    value += ' for ' + event.repeatCount + ' occurrences'
  }
  return value
}
function assignmentChangeDetail(field: AssignmentChangeField,
  event: AssignmentEventDetails): {label: string; value: string} {
  switch (field) {
    case 'title': return {label:'Event name',value:event.title}
    case 'date': return {label:'Start date',value:formatSharedDate(event.date)}
    case 'endDate': return {label:'End date',value:event.endDate
      ? formatSharedDate(event.endDate) : 'End date removed'}
    case 'time': return {label:'Start time',value:formatSharedTime(event.time)}
    case 'endTime': return {label:'End time',value:event.endTime
      ? formatSharedTime(event.endTime) : 'End time removed'}
    case 'location': return {label:'Location',value:event.location?.trim() || 'Location removed'}
    case 'notes': return {label:'Notes',value:event.notes?.trim()
      ? 'Notes updated — open the event to read them' : 'Notes removed'}
    case 'occurrences': return {label:'Recurring dates',
      value:'One or more occurrences changed — open the event to review'}
    default: return {label:'Repeats',value:repeatDescription(event)}
  }
}

type Props = {
  available: boolean
  invitations: readonly IncomingEventInvitation[]
  respondingId: number | null
  error: string
  suppress?: boolean
  respond: (shareId: number, decision: 'accepted' | 'declined') => Promise<boolean>
  familyInvitesAvailable?: boolean
  familyInvitations?: readonly FamilyEventInvitation[]
  respondingFamilyId?: number | null
  familyInvitationError?: string
  respondFamily?: (id: number, decision: 'accepted' | 'declined') => Promise<boolean>
  assignmentAvailable?: boolean
  assignmentNotifications?: readonly AssignmentNotice[]
  acknowledgingId?: number | null
  assignmentError?: string
  acknowledge?: (notificationId: number) => Promise<boolean>
  detailsForEvent?: (eventId: number) => AssignmentEventDetails | null
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

function HouseholdInvitationCards({
  invitations,respondingId,respond,
}: {
  invitations: readonly FamilyEventInvitation[]
  respondingId?: number | null
  respond?: (id:number,decision:'accepted'|'declined') => Promise<boolean>
}) {
  return <div className="invitation-center-items">
    {invitations.map(invite => <article key={'family-'+invite.id}
      className="invitation-center-item">
      <span className="invitation-center-source">From {invite.invitedBy || 'your family'}</span>
      <strong>{invite.title}</strong>
      <span className="invitation-center-date">{invite.date}{invite.time ? ' · '+invite.time : ''}</span>
      <p>You're invited to participate in this event.</p>
      <div className="invitation-center-actions">
        <button type="button" className="invitation-accept"
          disabled={respondingId !== null && respondingId !== undefined}
          onClick={()=>{void respond?.(invite.id,'accepted')}}>
          {respondingId===invite.id?'Saving…':'Accept'}
        </button>
        <button type="button" className="invitation-decline"
          disabled={respondingId !== null && respondingId !== undefined}
          onClick={()=>{void respond?.(invite.id,'declined')}}>
          Decline
        </button>
      </div>
    </article>)}
  </div>
}

function AssignmentCards({
  items,acknowledgingId,acknowledge,detailsForEvent,openEvent,compact = false,
}: {
  items: readonly AssignmentNotice[]
  acknowledgingId?: number | null
  acknowledge?: (id: number) => Promise<boolean>
  detailsForEvent?: (eventId: number) => AssignmentEventDetails | null
  openEvent?: (eventId: number) => void
  compact?: boolean
}) {
  const kindLabel: Record<AssignmentNotice['kind'],string> = {
    assigned: 'Added to an event',
    changed: 'Event updated',
    unassigned: 'Removed from an event',
    cancelled: 'Event cancelled',
  }
  return <div className="invitation-center-items">
    {items.map(item => {
      const event = detailsForEvent?.(item.eventId)
      const firstRepeatIndex = item.changedFields.findIndex(field => repeatChangeFields.has(field))
      const changedFields = item.changedFields.filter((field,index) =>
        !repeatChangeFields.has(field) || index === firstRepeatIndex)
      const changeLabels = event ? changedFields.map(field => {
        const detail = assignmentChangeDetail(field,event)
        return field === 'title' || field === 'date' || field === 'time'
          ? detail.label : detail.label + ': ' + detail.value
      }) : []
      return <article className={`invitation-center-item${compact ? ' assignment-notice-compact' : ''}`}
        key={'assignment-' + item.id}>
        {!compact && <strong className="assignment-notice-kind">{kindLabel[item.kind]}</strong>}
        <div className="assignment-event-summary">
          {event ? <>
            <b>{event.title}</b>
            <span>{formatSharedDate(event.date)} · {formatSharedTime(event.time)}</span>
          </> : <span>Event details unavailable</span>}
        </div>
        {item.kind === 'changed' && changeLabels.length > 0 && <p className="assignment-event-changes">
          <b>Changed:</b> {changeLabels.join(' · ')}
        </p>}
        <div className="invitation-center-actions">
          {event && openEvent && <button type="button" className="invitation-view-event"
            onClick={() => openEvent(item.eventId)}>View Event</button>}
          <button type="button" className="invitation-accept"
            disabled={acknowledgingId !== null && acknowledgingId !== undefined}
            onClick={() => { void acknowledge?.(item.id) }}>
            {acknowledgingId === item.id ? 'Saving…' : 'Acknowledge'}
          </button>
        </div>
      </article>
    })}
  </div>
}

/** Persistent desktop/tablet sidebar destination; never a calendar-wide share action. */
export function DesktopInvitations({
  available, invitations, respondingId, error, respond,
  familyInvitesAvailable = false, familyInvitations = [],
  respondingFamilyId = null, familyInvitationError = '', respondFamily,
  assignmentAvailable = false, assignmentNotifications = [],
  acknowledgingId = null, assignmentError = '', acknowledge, detailsForEvent, openEvent,
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
      <h3>Household invitations</h3>
      {!familyInvitesAvailable || familyInvitations.length === 0 ? (
        <p className="invitation-center-empty">No household invitations awaiting a response.</p>
      ) : <HouseholdInvitationCards invitations={familyInvitations}
          respondingId={respondingFamilyId} respond={respondFamily} />}
      {familyInvitationError && <p role="alert" className="invitation-center-error">
        {familyInvitationError}</p>}
      <h3>Calendar notifications</h3>
      {!assignmentAvailable || assignmentNotifications.length === 0 ? (
        <p className="invitation-center-empty">No new calendar notifications.</p>
      ) : <AssignmentCards items={assignmentNotifications} acknowledgingId={acknowledgingId}
          acknowledge={acknowledge} detailsForEvent={detailsForEvent} openEvent={openEvent} />}
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
  familyInvitesAvailable = false, familyInvitations = [],
  respondingFamilyId = null, familyInvitationError = '', respondFamily,
  assignmentAvailable = false, assignmentNotifications = [],
  acknowledgingId = null, assignmentError = '', acknowledge, detailsForEvent, openEvent,
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
      ...familyInvitations.map(item => 'household:' + item.id),
      ...assignmentNotifications.map(item => 'notification:' + item.id),
    ]
    const incoming = new Set(ids)
    const hasNew = ids.some(id => !seenInviteIds.current.has(id))
    seenInviteIds.current = incoming
    if (hasNew) setRemindLater(false)
  }, [invitations, familyInvitations, assignmentNotifications])

  const noticeCount = invitations.length + familyInvitations.length + assignmentNotifications.length
  const onlyAssignment = assignmentNotifications.length === 1 &&
    invitations.length === 0 && familyInvitations.length === 0
  const kindHeading: Record<AssignmentNotice['kind'],string> = {
    assigned: 'Added to an event', changed: 'Event updated',
    unassigned: 'Removed from an event', cancelled: 'Event cancelled',
  }
  const popupTitle = onlyAssignment ? kindHeading[assignmentNotifications[0].kind]
    : noticeCount === 1 ? 'Notification' : noticeCount + ' notifications'
  const multipleTypes = [
    invitations.length > 0, familyInvitations.length > 0,
    assignmentNotifications.length > 0,
  ].filter(Boolean).length > 1
  // View Event must dismiss this higher-z-index reminder without acknowledging.
  const viewAssignmentEvent = openEvent ? (eventId: number) => {
    setRemindLater(true)
    openEvent(eventId)
  } : undefined

  // The full inbox must be accessible after Remind Later without a duplicate
  // modal covering it. Pending invitations remain on the server until answered.
  const visible = mobile && ((available && invitations.length > 0) ||
    (familyInvitesAvailable && familyInvitations.length > 0) ||
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
          <h2 id="mobile-invite-title">{popupTitle}</h2>
          <button type="button" onClick={() => setRemindLater(true)}
            aria-label="Ask again later">×</button>
        </div>
        {invitations.length > 0 && <>
          {multipleTypes && <h3>Invitations</h3>}
          <InvitationCards invitations={invitations}
            respondingId={respondingId} respond={respond} />
        </>}
        {familyInvitations.length > 0 && <>
          {multipleTypes && <h3>Household invitations</h3>}
          <HouseholdInvitationCards invitations={familyInvitations}
            respondingId={respondingFamilyId} respond={respondFamily} />
        </>}
        {familyInvitationError && <p role="alert" className="invitation-center-error">{familyInvitationError}</p>}
        {assignmentNotifications.length > 0 && <>
          {multipleTypes && <h3>Event updates</h3>}
          <AssignmentCards items={assignmentNotifications} acknowledgingId={acknowledgingId}
            acknowledge={acknowledge} detailsForEvent={detailsForEvent}
            openEvent={viewAssignmentEvent} compact={onlyAssignment} />
        </>}
        {error && <p role="alert" className="invitation-center-error">{error}</p>}
        {assignmentError && <p role="alert" className="invitation-center-error">{assignmentError}</p>}
        <button className="mobile-invitations-remind" type="button"
          onClick={() => setRemindLater(true)}>
          Ask Again Later
        </button>
      </div>
    </div>,
    document.body
  )
}
