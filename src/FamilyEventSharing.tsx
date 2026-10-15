import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  parseTrustedShareRecipients, parseOutgoingInvitations,
  type TrustedShareRecipient, type OutgoingEventInvitation,
} from './eventSharingUiModel'
import { isCalendarDateKey, formatSharedDate, formatSharedTime } from './sharedEventOverlay'
import './FamilyEventSharing.css'

type LocalEventChoice = {
  id: number
  title: string
  date: string
  time: string | null
  repeatUnit: string | null
}

type Props = {
  event: LocalEventChoice
}

async function readShareApi(url: string): Promise<unknown> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
  if (!response.ok ||
    !(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    throw new Error('Event sharing is unavailable.')
  }
  return response.json() as Promise<unknown>
}

async function postShareApi(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    if (response.status === 409) {
      throw new Error('An invitation already exists for this event and family.')
    }
    throw new Error('The invitation could not be updated. Try refreshing.')
  }
}

export default function FamilyEventSharing({ event }: Props) {
  const [supported, setSupported] = useState(false)
  const [open, setOpen] = useState(false)
  const [recipients, setRecipients] = useState<TrustedShareRecipient[]>([])
  const [outgoing, setOutgoing] = useState<OutgoingEventInvitation[]>([])
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([])
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const generation = useRef(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const dialogId = useId()
  const titleId = useId()

  const eligible = Number.isSafeInteger(event.id) && event.id > 0 &&
    typeof event.title === 'string' && event.title.trim().length > 0 &&
    isCalendarDateKey(event.date) &&
    (!event.repeatUnit || event.repeatUnit === 'none')

  async function refresh() {
    const current = ++generation.current
    try {
      const [recipientData, sentData] = await Promise.all([
        readShareApi('/api/shared-events/recipients'),
        readShareApi('/api/shared-events/sent'),
      ])
      if (!recipientData || typeof recipientData !== 'object' ||
        !('recipients' in recipientData) || !Array.isArray(recipientData.recipients) ||
        !sentData || typeof sentData !== 'object' ||
        !('shares' in sentData) || !Array.isArray(sentData.shares)) {
        throw new Error('The sharing service did not return a valid response.')
      }
      if (!mounted.current || current !== generation.current) return
      setRecipients(parseTrustedShareRecipients(recipientData))
      setOutgoing(parseOutgoingInvitations(sentData).filter(share =>
        share.sourceEventId === event.id))
      setSupported(true)
    } catch {
      if (!mounted.current || current !== generation.current) return
      setSupported(false)
      setRecipients([])
      setOutgoing([])
      setSelectedRecipients([])
      setOpen(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      generation.current += 1
    }
  }, [event.id])

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') {
        keyEvent.preventDefault()
        keyEvent.stopPropagation()
        setOpen(false)
        return
      }
      if (keyEvent.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(element => element.getClientRects().length > 0)
      if (!focusables.length) {
        keyEvent.preventDefault()
        dialog.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (keyEvent.shiftKey && (document.activeElement === first ||
        !dialog.contains(document.activeElement))) {
        keyEvent.preventDefault()
        last.focus()
      } else if (!keyEvent.shiftKey && (document.activeElement === last ||
        !dialog.contains(document.activeElement))) {
        keyEvent.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      triggerRef.current?.focus()
    }
  }, [open])

  const activeStatusByHousehold = new Map<string, 'pending' | 'accepted'>()
  for (const share of outgoing) {
    if (share.status === 'accepted' || share.status === 'pending') {
      const current = activeStatusByHousehold.get(share.recipientHouseholdId)
      if (current !== 'accepted') {
        activeStatusByHousehold.set(share.recipientHouseholdId, share.status)
      }
    }
  }
  const existingTargets = new Set(outgoing.map(share => share.recipientHouseholdId))
  const selectedValid = selectedRecipients.filter(id =>
    recipients.some(contact => contact.householdId === id) &&
    !activeStatusByHousehold.has(id))
  const priorRecipients = selectedValid.filter(id => existingTargets.has(id))
  const displayedOutgoing = recipients.map(contact => {
    const history = outgoing.filter(share => share.recipientHouseholdId === contact.householdId)
    const preferred = history.find(share => share.status === 'accepted') ??
      history.find(share => share.status === 'pending') ??
      history[history.length - 1]
    return preferred ? preferred : null
  }).filter((share): share is OutgoingEventInvitation => share !== null)
  const sendable = selectedValid.length > 0 && selectedValid.length <= 8 &&
    eligible && !busy
  async function send() {
    if (!sendable) return
    const names = recipients.filter(item => selectedValid.includes(item.householdId))
      .map(item => item.displayName)
    const previouslySent = recipients.filter(contact =>
      priorRecipients.includes(contact.householdId)).map(contact => contact.displayName)
    if (!window.confirm(
      (previouslySent.length > 0
        ? 'Previously sent to ' + previouslySent.join(', ') +
          '. Send an invitation to ' + names.join(', ') + ' again? ' +
          'This only sends a new invitation because the previous one is no longer pending or accepted. '
        : 'Share "' + event.title + '" with ' + names.join(', ') + '? ') +
      'Only your family name and this event title/date/time will be visible; ' +
      'private notes, people and photos stay private.'
    )) return

    setBusy(true)
    setError('')
    setMessage('')
    try {
      await postShareApi('/api/shared-events/invite', {
        eventIds: [event.id],
        recipientHouseholdIds: selectedValid,
        allowResend: priorRecipients.length > 0,
      })
      if (!mounted.current) return
      setSelectedRecipients([])
      setMessage(priorRecipients.length > 0
        ? 'Invitation sent again. The family must accept or decline it.'
        : 'Event invitation sent. The family must accept it.')
      await refresh()
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error
        ? reason.message : 'Could not send event invitation.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function revoke(share: OutgoingEventInvitation) {
    if (busy || !window.confirm(
      'Stop sharing "' + share.title + '" with ' +
      share.recipientDisplayName + '? Other recipients are unaffected.'
    )) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await postShareApi('/api/shared-events/' + share.shareId + '/revoke', {})
      if (!mounted.current) return
      setMessage('That event share was revoked.')
      await refresh()
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error
        ? reason.message : 'Could not revoke the share.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  // No calendar-wide sharing button. Only a valid individual event has a trigger.
  if (!supported || !eligible) return null

  return (
    <div className="family-event-sharing">
      <button type="button" className="family-event-sharing-toggle"
        ref={triggerRef} aria-haspopup="dialog" aria-controls={dialogId}
        aria-expanded={open}
        onClick={() => {
          setOpen(true)
          setError('')
          setMessage('')
          setSelectedRecipients([])
          void refresh()
        }}>
        <span aria-hidden="true">↗</span> Share Event
      </button>

      {open && createPortal(
        <div className="family-sharing-dialog-layer">
          <button type="button" className="family-sharing-dialog-backdrop"
            aria-label="Close sharing window" onClick={() => setOpen(false)} />
          <div id={dialogId} ref={dialogRef} role="dialog" aria-modal="true"
            aria-labelledby={titleId} tabIndex={-1}
            className="family-event-sharing-panel">
            <div className="family-event-sharing-panel-header">
              <div>
                <h3 id={titleId}>Share Event</h3>
                <p>Only this event will be shared. No other calendar events are included.</p>
              </div>
              <button type="button" className="family-event-sharing-close"
                onClick={() => setOpen(false)} aria-label="Close event sharing">×</button>
            </div>
            <div className="family-sharing-single-event">
              <strong>{event.title}</strong>
              <span>{formatSharedDate(event.date)} · {formatSharedTime(event.time)}</span>
            </div>
            <fieldset className="family-sharing-recipient-fieldset" disabled={busy}>
              <legend>Choose families to invite (up to 8)</legend>
              <div className="family-sharing-options" role="group"
                aria-label="Recipient families for this event">
                {recipients.map(contact => (
                  <label className="family-sharing-choice" key={contact.householdId}>
                    <input type="checkbox"
                      checked={selectedValid.includes(contact.householdId)}
                      disabled={activeStatusByHousehold.has(contact.householdId)}
                      onChange={() => setSelectedRecipients(current =>
                        current.includes(contact.householdId)
                          ? current.filter(id => id !== contact.householdId)
                          : current.length < 8
                            ? [...current, contact.householdId] : current
                      )} />
                    <span>
                      <strong>{contact.displayName}</strong>
                      {activeStatusByHousehold.get(contact.householdId) === 'accepted' ? (
                        <small>Already on their calendar</small>
                      ) : activeStatusByHousehold.get(contact.householdId) === 'pending' ? (
                        <small>Invitation already waiting</small>
                      ) : existingTargets.has(contact.householdId) ? (
                        <small>Previously invited — you can resend</small>
                      ) : null}
                    </span>
                  </label>
                ))}
                {recipients.length === 0 && (
                  <p className="family-sharing-empty">No trusted family contacts are connected yet.</p>
                )}
              </div>
            </fieldset>
            <button type="button" className="family-sharing-send" disabled={!sendable}
              onClick={() => { void send() }}>
              {busy ? 'Processing…' : priorRecipients.length > 0 ? 'Send Invitation Again' : 'Send Event Invitation'}
            </button>
            {displayedOutgoing.length > 0 && (
              <section className="family-sharing-sent" aria-label="Existing shares for this event">
                <h4>Invitation history</h4>
                {displayedOutgoing.map(share => (
                  <div className="family-sharing-invitation" key={share.shareId}>
                    <strong>{share.recipientDisplayName}</strong>
                    <div className="family-sharing-actions">
                      <span className="family-sharing-status">
                        {share.status === 'accepted' ? 'Accepted' :
                          share.status === 'pending' ? 'Awaiting acceptance' :
                          share.status === 'declined' ? 'Declined' :
                          share.status === 'revoked' ? 'Stopped sharing' : 'Previous event deleted'}
                        
                      </span>
                      {(share.status === 'pending' || share.status === 'accepted') && (
                        <button type="button" disabled={busy}
                          onClick={() => { void revoke(share) }}>
                          Stop sharing
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </section>
            )}
            {error && <p role="alert" className="family-sharing-error">{error}</p>}
            {message && <p role="status" className="family-sharing-message">{message}</p>}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
