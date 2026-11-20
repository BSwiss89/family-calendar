import { useCallback, useEffect, useState } from 'react'

type RecoveryRequest = {
  id: number
  username: string
  displayName: string
  createdAt: number
  expiresAt: number
}

function validPending(value: unknown): value is { requests: RecoveryRequest[] } {
  if (!value || typeof value !== 'object' || !('requests' in value) ||
      !Array.isArray(value.requests)) return false
  return value.requests.every((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false
    const row = entry as Record<string, unknown>
    return Number.isSafeInteger(row.id) && (row.id as number) > 0 &&
      typeof row.username === 'string' && typeof row.displayName === 'string' &&
      typeof row.createdAt === 'number' && typeof row.expiresAt === 'number'
  })
}
async function send(url: string, body?: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(url, {
    credentials: 'same-origin', cache: 'no-store',
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const result: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const reason = result && typeof result === 'object' && 'error' in result &&
      typeof result.error === 'string' ? result.error : 'Recovery administration unavailable.'
    throw Object.assign(new Error(reason), { status: response.status })
  }
  return result
}

/** Operator-only, never an alternative to server allowlisted permissions. */
export default function SystemRecoveryAdminSettings() {
  const [available, setAvailable] = useState(false)
  const [requests, setRequests] = useState<RecoveryRequest[]>([])
  const [password, setPassword] = useState('')
  const [verified, setVerified] = useState(false)
  const [oneTimeLink, setOneTimeLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/admin/recovery/requests', {
      signal, credentials: 'same-origin', cache: 'no-store',
    })
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      setAvailable(false)
      return
    }
    if (!response.ok) throw new Error('Could not read recovery requests.')
    const data: unknown = await response.json()
    if (signal?.aborted || !validPending(data)) return
    setRequests(data.requests)
    setAvailable(true)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal).catch(() => {
      if (!controller.signal.aborted) setAvailable(false)
    })
    return () => {
      controller.abort()
      setOneTimeLink('')
    }
  }, [refresh])

  async function decide(request: RecoveryRequest, action: 'issue' | 'deny') {
    if (!available || busy || !password) {
      setError('Enter your administrator password first.')
      return
    }
    if (action === 'issue' && !verified) {
      setError('Verify this person through an existing trusted contact channel first.')
      return
    }
    if (action === 'deny' &&
        !window.confirm('Deny this recovery request? This cannot be undone.')) return
    setError('')
    setMessage('')
    setOneTimeLink('')
    setBusy(true)
    try {
      const payload: Record<string, unknown> = action === 'issue'
        ? { ownerPassword: password, verifiedOutOfBand: true }
        : { ownerPassword: password }
      const response = await send(
        '/api/admin/recovery/requests/' + encodeURIComponent(String(request.id)) +
          '/' + action, payload,
      )
      if (action === 'issue') {
        if (!response || typeof response !== 'object' || !('resetUrl' in response) ||
            typeof response.resetUrl !== 'string' ||
            !response.resetUrl.startsWith(window.location.origin + '/reset-password#token=')) {
          throw new Error('Unexpected one-time reset link.')
        }
        setOneTimeLink(response.resetUrl)
        setMessage('Link issued once. Share it privately with the verified person before it expires.')
      } else {
        setMessage('Recovery request denied.')
      }
      setPassword('')
      setVerified(false)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not review recovery request.')
    } finally {
      setBusy(false)
    }
  }

  if (!available) return null
  return (
    <section className="household-settings-card" aria-label="System administrator password recovery">
      <h2>Password recovery — system administrator</h2>
      <p>Only your allowlisted administrator account can review these requests.
        Verify a person's identity using a contact method you already trust
        before issuing a single-use link. You cannot view their password.</p>
      <label htmlFor="system-recovery-admin-password">Your administrator password</label>
      <input id="system-recovery-admin-password" type="password"
        autoComplete="current-password" value={password}
        onChange={event => setPassword(event.target.value)} maxLength={200}
        placeholder="Required for every action" />
      <label>
        <input type="checkbox" checked={verified}
          onChange={event => setVerified(event.target.checked)} />
        I independently verified the intended account holder.
      </label>
      <div className="household-settings-list">
        {requests.length === 0 && <p>No pending password recovery requests.</p>}
        {requests.map(request => (
          <div className="household-settings-invite" key={request.id}>
            <div>
              <strong>{request.displayName} (@{request.username})</strong>
              <span>Requested {new Date(request.createdAt).toLocaleString()}</span>
              <span>Expires {new Date(request.expiresAt).toLocaleString()}</span>
            </div>
            <button type="button" disabled={busy || !password || !verified}
              onClick={() => void decide(request, 'issue')}>Issue reset link</button>
            <button type="button" className="household-settings-danger"
              disabled={busy || !password}
              onClick={() => void decide(request, 'deny')}>Deny</button>
          </div>
        ))}
      </div>
      {oneTimeLink && (
        <div className="household-settings-share">
          <label htmlFor="system-recovery-one-time-link">One-time private reset link</label>
          <input id="system-recovery-one-time-link" readOnly value={oneTimeLink}
            onFocus={event => event.currentTarget.select()} />
          <button type="button" onClick={() => void navigator.clipboard.writeText(oneTimeLink)
            .then(() => setMessage('Reset link copied.'))
            .catch(() => setError('Select and copy the link manually.'))}>Copy link</button>
          <p>This link is displayed only now; it is never mailed automatically.</p>
        </div>
      )}
      <button type="button" disabled={busy}
        onClick={() => void refresh().catch(() => setError('Could not refresh recovery requests.'))}>
        Refresh recovery requests
      </button>
      {message && <p role="status" aria-live="polite">{message}</p>}
      {error && <p role="alert" aria-live="polite">{error}</p>}
    </section>
  )
}
