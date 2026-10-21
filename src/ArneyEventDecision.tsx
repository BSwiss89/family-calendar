import { useRef, useState } from 'react'
import { selectionPreviewRequest } from './arneyEventSelection.mjs'
import './ArneyEventDecision.css'

type Option = {
  eventId: number
  title: string
  date: string
  time: string | null
  supported: boolean
}
export type PreviewRequest = {
  action: 'cancel' | 'reschedule'
  eventId?: number
  newDate?: string
  newTime?: string | null
}
type Selection = {
  status: 'needs_selection'
  readOnly: true
  requiresSelection: true
  action: 'cancel' | 'reschedule'
  options: Option[]
  previewRequest: Omit<PreviewRequest, 'eventId'>
}
export type Confirm = {
  eventId: number
  status: 'ready_for_confirmation'
  action: 'cancel' | 'reschedule'
  current: { title: string; date: string; time: string | null }
  proposed: { date: string; time: string | null } | null
  expiresAt: string
  previewToken: string
  requiresConfirmation: true
}
export type ArneyEventDecisionData = Selection | Confirm
type Props = {
  data: ArneyEventDecisionData
  onPreview: (request: PreviewRequest) => Promise<Confirm>
  onConfirm: (token: string) => Promise<void>
  onDismiss: () => void
}
const dateTime = (date: string, time: string | null) =>
  date + ' at ' + (time || 'All day')

/** Display-only selection and explicit confirm. All changes are server-authorized. */
export default function ArneyEventDecision({
  data, onPreview, onConfirm, onDismiss,
}: Props) {
  const [preview, setPreview] = useState<Confirm | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmationFailed, setConfirmationFailed] = useState(false)
  const activeRequest = useRef(false)
  const confirmed = confirmationFailed ? null : (preview ?? (data.status === 'ready_for_confirmation' ? data : null))

  async function choose(option: Option) {
    if (activeRequest.current || !option.supported || data.status !== 'needs_selection') return
    const request = selectionPreviewRequest(data, option.eventId)
    if (!request) return
    activeRequest.current = true
    setBusy(true)
    setError('')
    try {
      // Selection NEVER creates a token client-side. The backend rereads
      // and signs exactly this event in the authenticated household.
      const result = await onPreview(request)
      if (result.status !== 'ready_for_confirmation' || result.requiresConfirmation !== true ||
          !result.previewToken || result.action !== request.action) {
        throw Error('The selected event needs a fresh review.')
      }
      setPreview(result)
    } catch {
      setError('Could not preview this event. Please try again.')
    } finally {
      activeRequest.current = false
      setBusy(false)
    }
  }

  async function confirm() {
    if (!confirmed || busy || activeRequest.current) return
    if (!Number.isFinite(Date.parse(confirmed.expiresAt)) ||
        Date.now() >= Date.parse(confirmed.expiresAt)) {
      setConfirmationFailed(true)
      setError('This approval expired. Start a new request to review the event.')
      return
    }
    activeRequest.current = true
    setBusy(true)
    setError('')
    try {
      // Confirmation is a distinct user gesture, never performed by selecting.
      await onConfirm(confirmed.previewToken)
      onDismiss()
    } catch {
      setPreview(null)
      setConfirmationFailed(true)
      setError('The change could not be confirmed. Refresh your calendar before making another request.')
    } finally {
      activeRequest.current = false
      setBusy(false)
    }
  }

  return (
    <section className="arney-event-decision" aria-label="Arney event review">
      {confirmed ? (
        <>
          <h3>Confirm {confirmed.action === 'cancel' ? 'event cancellation' : 'event change'}</h3>
          <strong>{confirmed.current.title}</strong>
          <p>Current: {dateTime(confirmed.current.date, confirmed.current.time)}</p>
          {confirmed.proposed
            ? <p>Proposed: {dateTime(confirmed.proposed.date, confirmed.proposed.time)}</p>
            : <p>This event will be canceled.</p>}
          <p>This approval expires at {new Date(confirmed.expiresAt).toLocaleTimeString()}.</p>
          <div className="arney-event-decision-actions">
            <button type="button" disabled={busy} onClick={onDismiss}>Keep event</button>
            <button type="button" disabled={busy} onClick={() => void confirm()}>
              {busy ? 'Applying…' : confirmed.action === 'cancel' ? 'Cancel event' : 'Confirm change'}
            </button>
          </div>
        </>
      ) : data.status === 'needs_selection' ? (
        <>
          <h3>Which event do you mean?</h3>
          <p>Select one event to review. Nothing changes until you confirm.</p>
          <div className="arney-event-decision-options">
            {data.options.map(option => (
              <button key={option.eventId} type="button"
                disabled={busy || !option.supported} onClick={() => void choose(option)}>
                <strong>{option.title}</strong>
                <span>{dateTime(option.date, option.time)}</span>
                {!option.supported && <span>Manual editing required</span>}
              </button>
            ))}
          </div>
          <button type="button" disabled={busy} onClick={onDismiss}>Never mind</button>
        </>
      ) : null}
      {error && <p role="alert">{error}</p>}
      {confirmationFailed && <button type="button" onClick={onDismiss}>Close review</button>}
    </section>
  )
}
