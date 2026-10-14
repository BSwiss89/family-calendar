import { useEffect, useMemo, useRef, useState } from 'react'
import {
  parseTrustedShareRecipients, parseIncomingInvitations,
  parseOutgoingInvitations,
  type TrustedShareRecipient, type IncomingEventInvitation,
  type OutgoingEventInvitation,
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
  events: readonly LocalEventChoice[]
}

async function readSharingJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (!response.ok ||
    !(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    throw new Error('Sharing service is not available for this calendar.')
  }
  return response.json() as Promise<unknown>
}

async function writeSharingJson(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    if (response.status === 409) {
      throw new Error('One of these invitations already exists. Review sent invitations before trying again.')
    }
    throw new Error('Unable to complete that request. Refresh your invitations before retrying.')
  }
  return response
}

function formatChoiceDate(date: string, time: string | null): string {
  return formatSharedDate(date) + ' · ' + formatSharedTime(time)
}

/**
 * A progressive enhancement for the PRIVATE authenticated gateway.
 * The legacy one-family backend doesn't support these endpoints, so the
 * entire control stays hidden instead of showing misleading sharing UI.
 * No form sends a household selection, source DB path, calendar subscription
 * or full event details. Only explicit event IDs and named contact IDs.
 */
export default function FamilyEventSharing({ events }: Props) {
  const [supported, setSupported] = useState(false)
  const [open, setOpen] = useState(false)
  const [recipients, setRecipients] = useState<TrustedShareRecipient[]>([])
  const [incoming, setIncoming] = useState<IncomingEventInvitation[]>([])
  const [outgoing, setOutgoing] = useState<OutgoingEventInvitation[]>([])
  const [selectedEvents, setSelectedEvents] = useState<number[]>([])
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const loadGeneration = useRef(0)

  const eligibleEvents = useMemo(() => events.filter(event =>
    Number.isSafeInteger(event.id) && event.id > 0 &&
    typeof event.title === 'string' && event.title.trim().length > 0 &&
    isCalendarDateKey(event.date) &&
    (!event.repeatUnit || event.repeatUnit === 'none')
  ).sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.time ?? '').localeCompare(b.time ?? '') || a.id - b.id
  ), [events])

  async function refresh() {
    const generation = ++loadGeneration.current
    try {
      const [recipientData, invitationData, sentData] = await Promise.all([
        readSharingJson('/api/shared-events/recipients'),
        readSharingJson('/api/shared-events/invitations'),
        readSharingJson('/api/shared-events/sent'),
      ])
      // Treat malformed endpoints as unavailable; never assume they grant
      // permission to send information to arbitrary other households.
      if (typeof recipientData !== 'object' || !recipientData ||
        !('recipients' in recipientData) ||
        !Array.isArray(recipientData.recipients) ||
        typeof invitationData !== 'object' || !invitationData ||
        !('invitations' in invitationData) ||
        !Array.isArray(invitationData.invitations) ||
        typeof sentData !== 'object' || !sentData ||
        !('shares' in sentData) ||
        !Array.isArray(sentData.shares)) {
        throw new Error('Sharing service returned an unexpected response.')
      }
      if (!mounted.current || generation !== loadGeneration.current) return
      setRecipients(parseTrustedShareRecipients(recipientData))
      setIncoming(parseIncomingInvitations(invitationData))
      setOutgoing(parseOutgoingInvitations(sentData))
      setSupported(true)
      setError('')
    } catch {
      if (!mounted.current || generation !== loadGeneration.current) return
      setSupported(false)
      setRecipients([])
      setIncoming([])
      setOutgoing([])
      setSelectedEvents([])
      setSelectedRecipients([])
      setOpen(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    const timer = window.setInterval(onFocus, 30000)
    return () => {
      mounted.current = false
      loadGeneration.current += 1
      window.removeEventListener('focus', onFocus)
      window.clearInterval(timer)
    }
  }, [])

  function toggleEvent(id: number) {
    setSelectedEvents(current =>
      current.includes(id) ? current.filter(other => other !== id) :
      current.length < 20 ? [...current, id] : current
    )
  }

  function toggleRecipient(id: string) {
    setSelectedRecipients(current =>
      current.includes(id) ? current.filter(other => other !== id) :
      current.length < 8 ? [...current, id] : current
    )
  }

  const filteredEvents = eligibleEvents.filter(event =>
    (event.title + ' ' + event.date).toLowerCase().includes(search.trim().toLowerCase())
  ).slice(0, 80)

  const sendableIds = selectedEvents.filter(id =>
    eligibleEvents.some(event => event.id === id)
  )
  const sendableRecipients = selectedRecipients.filter(id =>
    recipients.some(recipient => recipient.householdId === id)
  )
  const canSend = sendableIds.length > 0 && sendableRecipients.length > 0 &&
    sendableIds.length * sendableRecipients.length <= 80 && !busy

  async function sendInvitations() {
    if (!canSend) return
    const names = recipients
      .filter(recipient => sendableRecipients.includes(recipient.householdId))
      .map(recipient => recipient.displayName)
    if (!window.confirm(
      'Share ' + sendableIds.length + ' selected event(s) with ' + names.join(', ') +
      '? Only those event titles and dates/times will be shared after acceptance. ' +
      'Your other calendar events, people, notes and photos stay private.'
    )) return

    setBusy(true)
    setError('')
    setMessage('')
    try {
      await writeSharingJson('/api/shared-events/invite', {
        eventIds: sendableIds,
        recipientHouseholdIds: sendableRecipients,
      })
      if (!mounted.current) return
      setSelectedEvents([])
      setSelectedRecipients([])
      setMessage('Invitations sent. The receiving households must accept them.')
      await refresh()
    } catch (reason) {
      if (mounted.current) setError(
        reason instanceof Error ? reason.message : 'Unable to send invitations.'
      )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function respond(shareId: number, decision: 'accepted' | 'declined') {
    if (!Number.isSafeInteger(shareId) || shareId <= 0 || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await writeSharingJson(
        '/api/shared-events/' + shareId + '/respond', { decision }
      )
      if (!mounted.current) return
      setMessage(decision === 'accepted'
        ? 'Event accepted. It will appear on your calendar.'
        : 'Invitation declined.')
      // Tell the existing read-only calendar overlay to reload now, without
      // ever adding the sender's event to our editable local event array.
      window.dispatchEvent(new Event('family-calendar:shared-events-changed'))
      await refresh()
    } catch (reason) {
      if (mounted.current) setError(
        reason instanceof Error ? reason.message : 'Unable to respond.'
      )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function revoke(share: OutgoingEventInvitation) {
    if (busy || !window.confirm(
      'Stop sharing "' + share.title + '" with ' +
      share.recipientDisplayName + '? Other event invitations will be unaffected.'
    )) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await writeSharingJson('/api/shared-events/' + share.shareId + '/revoke', {})
      if (!mounted.current) return
      setMessage('That individual event share was revoked.')
      await refresh()
    } catch (reason) {
      if (mounted.current) setError(
        reason instanceof Error ? reason.message : 'Unable to revoke that share.'
      )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  if (!supported) return null

  return (
    <section className="family-event-sharing" aria-label="Individual event sharing">
      <button type="button" className="family-event-sharing-toggle"
        aria-expanded={open} aria-controls="family-event-sharing-panel"
        onClick={() => {
          setOpen(wasOpen => !wasOpen)
          setError('')
          setMessage('')
          void refresh()
        }}>
        <span aria-hidden="true">↗</span>
        Share events &amp; invitations
        {incoming.length > 0 && (
          <span className="family-event-sharing-count">
            {incoming.length} pending
          </span>
        )}
      </button>

      {open && (
        <div id="family-event-sharing-panel" className="family-event-sharing-panel">
          <div className="family-event-sharing-panel-header">
            <div>
              <h3>Share specific events</h3>
              <p>Select only the events and households you intend to share with.
                No other family calendar information is shared.</p>
            </div>
            <button type="button" onClick={() => setOpen(false)}
              className="family-event-sharing-close" aria-label="Close event sharing">×</button>
          </div>
          <div className="family-event-sharing-grid">
            <fieldset disabled={busy}>
              <legend>1. Choose your events (up to 20)</legend>
              {eligibleEvents.length === 0 ? (
                <p className="family-sharing-empty">No non-recurring events are available.</p>
              ) : (
                <>
                  <label htmlFor="family-share-search">Find an event by name or date</label>
                  <input id="family-share-search" type="search"
                    placeholder="Search your calendar events"
                    value={search} onChange={event => setSearch(event.target.value)} />
                  <div className="family-sharing-options" role="group" aria-label="Events to share">
                    {filteredEvents.map(event => (
                      <label className="family-sharing-choice" key={event.id}>
                        <input type="checkbox" checked={sendableIds.includes(event.id)}
                          onChange={() => toggleEvent(event.id)} />
                        <span>
                          <strong>{event.title}</strong>
                          <small>{formatChoiceDate(event.date, event.time)}</small>
                        </span>
                      </label>
                    ))}
                    {filteredEvents.length === 0 && (
                      <p className="family-sharing-empty">No matching events.</p>
                    )}
                  </div>
                </>
              )}
              <small>{sendableIds.length} events selected. Recurring events
                are unavailable until occurrence-level sharing is supported.</small>
            </fieldset>

            <fieldset disabled={busy}>
              <legend>2. Choose recipient families (up to 8)</legend>
              <div className="family-sharing-options" role="group" aria-label="Families receiving events">
                {recipients.map(recipient => (
                  <label className="family-sharing-choice" key={recipient.householdId}>
                    <input type="checkbox"
                      checked={sendableRecipients.includes(recipient.householdId)}
                      onChange={() => toggleRecipient(recipient.householdId)} />
                    <span><strong>{recipient.displayName}</strong></span>
                  </label>
                ))}
                {recipients.length === 0 && (
                  <p className="family-sharing-empty">No trusted family contacts yet.
                    A family must be connected by an administrator before you can share.</p>
                )}
              </div>
              <small>{sendableRecipients.length} families selected.
                Invitations give access only to selected events, never entire calendars.</small>
            </fieldset>
          </div>

          <button type="button" className="family-sharing-send" disabled={!canSend}
            onClick={() => { void sendInvitations() }}>
            {busy ? 'Processing…' : 'Send selected event invitations'}
          </button>
          {sendableIds.length * sendableRecipients.length > 80 && (
            <p className="family-sharing-error">
              Reduce your selection to at most 80 event/recipient combinations.</p>
          )}

          <div className="family-event-sharing-lists">
            <section aria-label="Incoming event invitations">
              <h4>Invitations from other families ({incoming.length})</h4>
              {incoming.length === 0 && (
                <p className="family-sharing-empty">No invitations awaiting your response.</p>
              )}
              {incoming.map(invite => (
                <div className="family-sharing-invitation" key={invite.shareId}>
                  <strong>{invite.title}</strong>
                  <small>{formatChoiceDate(invite.date, invite.time)} · From {invite.sharedBy}</small>
                  <div className="family-sharing-actions">
                    <button type="button" disabled={busy}
                      onClick={() => { void respond(invite.shareId, 'accepted') }}>Accept event</button>
                    <button type="button" disabled={busy}
                      onClick={() => { void respond(invite.shareId, 'declined') }}>Decline</button>
                  </div>
                </div>
              ))}
            </section>
            <section aria-label="Sent event invitations">
              <h4>Events you shared ({outgoing.length})</h4>
              {outgoing.length === 0 && (
                <p className="family-sharing-empty">No active event invitations sent.</p>
              )}
              {outgoing.map(share => (
                <div className="family-sharing-invitation" key={share.shareId}>
                  <strong>{share.title}</strong>
                  <small>{formatChoiceDate(share.date, share.time)} · To {share.recipientDisplayName}</small>
                  <div className="family-sharing-actions">
                    <span className="family-sharing-status">
                      {share.status === 'accepted' ? 'Accepted' : 'Awaiting acceptance'}
                    </span>
                    <button type="button" disabled={busy}
                      onClick={() => { void revoke(share) }}>Stop sharing</button>
                  </div>
                </div>
              ))}
            </section>
          </div>

          {error && <p className="family-sharing-error" role="alert">{error}</p>}
          {message && <p className="family-sharing-message" role="status">{message}</p>}
        </div>
      )}
    </section>
  )
}
