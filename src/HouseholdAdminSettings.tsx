import { useCallback, useEffect, useState } from 'react'

type Invitation = { id: number; createdAt: number; expiresAt: number }
type ManagedHousehold = {
  householdId: string
  displayName: string
  state: 'pending' | 'routed' | 'approved-unrouted'
}
type Administration = { invitations: Invitation[]; households: ManagedHousehold[] }

function validAdministration(value: unknown): value is Administration {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<Administration>
  return Array.isArray(v.invitations) && v.invitations.every(item =>
    item && Number.isSafeInteger(item.id) &&
    Number.isFinite(item.createdAt) && Number.isFinite(item.expiresAt)) &&
    Array.isArray(v.households) && v.households.every(home =>
      home && typeof home.householdId === 'string' &&
      typeof home.displayName === 'string' &&
      ['pending', 'routed', 'approved-unrouted'].includes(home.state))
}

async function jsonRequest(url: string, method = 'GET', signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    method, signal, credentials: 'same-origin', cache: 'no-store',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
  })
  const json: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error('Request failed.')
    Object.assign(error, { status: response.status })
    throw error
  }
  return json
}

function timeLabel(timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

const descriptions: Record<ManagedHousehold['state'], string> = {
  pending: 'Registered — activation pending',
  routed: 'Configured in private gateway (verified on use)',
  'approved-unrouted': 'Approved — backend not connected',
}

/**
 * This panel is never permission authority. The private gateway requires a
 * centrally authenticated, server-allowlisted operator for EACH request.
 * Ordinary owners and legacy calendars receive 403/404 and see no panel.
 */
export default function HouseholdAdminSettings() {
  const [available, setAvailable] = useState(false)
  const [data, setData] = useState<Administration | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [link, setLink] = useState('')

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await jsonRequest('/api/households/independent-administration', 'GET', signal)
    if (!validAdministration(response)) throw new Error('Unexpected administrator response.')
    if (signal?.aborted) return
    setData(response)
    setAvailable(true)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    refresh(controller.signal).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      // 403 is normal for ordinary family accounts; 404 for LIVE/TEST until
      // this separately approved private feature is deployed.
      if (reason instanceof Error &&
          ('status' in reason) && (reason.status === 403 || reason.status === 404)) {
        setAvailable(false)
      } else {
        setAvailable(false)
      }
    })
    return () => {
      controller.abort()
      setLink('')
    }
  }, [refresh])

  async function issueInvitation() {
    if (!available || busy || window.location.protocol !== 'https:') return
    setBusy(true)
    setLink('')
    setError('')
    setNotice('')
    try {
      const payload = await jsonRequest('/api/households/independent-invitations', 'POST')
      if (!payload || typeof payload !== 'object' ||
          !('token' in payload) || typeof payload.token !== 'string' ||
          !/^[0-9a-f]{64}$/.test(payload.token)) {
        throw new Error('Unexpected invitation format.')
      }
      const url = new URL('/start-family#token=' + payload.token, window.location.origin)
      await refresh()
      setLink(url.href)
      setNotice('Separate-household invitation created. Copy the link now; it is shown only once.')
    } catch (reason) {
      setError(reason instanceof Error && 'status' in reason && reason.status === 429
        ? 'Invitation limit reached. Try again later.'
        : 'Could not create a new household invitation.')
    } finally {
      setBusy(false)
    }
  }

  async function revokeInvitation(id: number) {
    if (!available || busy ||
      !window.confirm('Revoke this new-household invitation? The link will stop working.')) return
    setBusy(true)
    setError('')
    setNotice('')
    setLink('')
    try {
      await jsonRequest('/api/households/independent-invitations/' +
        encodeURIComponent(String(id)) + '/revoke', 'POST')
      await refresh()
      setNotice('New-household invitation revoked.')
    } catch {
      setError('Could not revoke the invitation. Refresh and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function copyLink() {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setNotice('Separate-household invitation copied.')
      setError('')
    } catch {
      setError('Copy was blocked. Select the link to copy it manually.')
    }
  }

  if (!available || !data) return null
  return (
    <div className="household-settings-card" aria-label="Private family administrator controls">
      <h2>New family invitations</h2>
      <p>Administrator only. Invite someone to create their own independent
        household, not join yours. Their calendar stays separate.</p>
      <button type="button" className="household-settings-primary" disabled={busy ||
        window.location.protocol !== 'https:'} onClick={() => void issueInvitation()}>
        {busy ? 'Working…' : 'Create separate-family invitation'}
      </button>
      {window.location.protocol !== 'https:' && (
        <p>HTTPS is required to issue a separate-household invitation.</p>
      )}
      {link && <div className="household-settings-share">
        <label htmlFor="separate-family-link">One-time link</label>
        <input id="separate-family-link" readOnly value={link}
          onFocus={event => event.currentTarget.select()} />
        <button type="button" disabled={busy} onClick={() => void copyLink()}>Copy link</button>
        <p>The invited person becomes owner of a separate household.
          Activation is a separate operator-controlled step.</p>
      </div>}
      <h3>Pending separate-family invitations</h3>
      <div className="household-settings-list">
        {data.invitations.length === 0 && <p>No pending invitations.</p>}
        {data.invitations.map(invite => (
          <div className="household-settings-invite" key={invite.id}>
            <div><strong>Invitation #{invite.id}</strong>
              <span>Expires {timeLabel(invite.expiresAt)}</span></div>
            <button type="button" className="household-settings-danger"
              disabled={busy} onClick={() => void revokeInvitation(invite.id)}>Revoke</button>
          </div>
        ))}
      </div>
      <h3>Independent household activation</h3>
      <p>Status shows trusted gateway configuration, not a guarantee of
        current server health. Backends are verified before each calendar request.
        Activation itself is never available from the browser.</p>
      <div className="household-settings-list">
        {data.households.length === 0 && <p>No separate households registered yet.</p>}
        {data.households.map(home => (
          <div className="household-settings-invite" key={home.householdId}>
            <div><strong>{home.displayName}</strong>
              <span>{descriptions[home.state]}</span></div>
          </div>
        ))}
      </div>
      <button type="button" disabled={busy}
        onClick={() => void refresh().catch(() => setError('Could not refresh administrator status.'))}>
        Refresh status
      </button>
      {(error || notice) && <p role="status" aria-live="polite">{error || notice}</p>}
    </div>
  )
}
