import { useEffect, useState } from 'react'
import './FamilyMemberAccessSettings.css'

type PinPolicy = { pinEnabled: boolean }

function isPinPolicy(value: unknown): value is PinPolicy {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).pinEnabled === 'boolean'
}

async function requestHomePinPolicy(
  method: 'GET' | 'POST', body?: { pinEnabled: boolean; ownerPassword: string },
  signal?: AbortSignal,
): Promise<PinPolicy> {
  const response = await fetch('/api/households/home-pin', {
    method, signal, credentials: 'same-origin', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok || !isPinPolicy(data)) {
    const message = data && typeof data === 'object' && 'error' in data &&
      typeof data.error === 'string' ? data.error : 'Home PIN preference unavailable.'
    throw Object.assign(new Error(message), { status: response.status })
  }
  return data
}

/**
 * PRIVATE multi-household pilot only. This configures the future Home PIN
 * requirement; the verified kiosk/PIN actor workflow is not yet activated.
 * The service performs authenticated Owner/password checks for every save.
 */
export default function SharedHomePinSettings({
  ownerPassword, clearOwnerPassword,
}: {
  ownerPassword: string
  clearOwnerPassword: () => void
}) {
  const [saved, setSaved] = useState<boolean | null>(null)
  const [draft, setDraft] = useState(true)
  const [saving, setSaving] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void requestHomePinPolicy('GET', undefined, controller.signal).then(policy => {
      if (controller.signal.aborted) return
      setSaved(policy.pinEnabled)
      setDraft(policy.pinEnabled)
    }).catch((problem: unknown) => {
      if (controller.signal.aborted) return
      if (problem && typeof problem === 'object' && 'status' in problem &&
        problem.status === 404) setHidden(true)
      else setError(problem instanceof Error ? problem.message : 'Home PIN preference unavailable.')
    })
    return () => controller.abort()
  }, [])

  async function save() {
    if (saving || saved === null || saved === draft) return
    if (!ownerPassword) {
      setError('Enter your Owner account password before changing the PIN setting.')
      return
    }
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const policy = await requestHomePinPolicy('POST', {
        pinEnabled: draft, ownerPassword,
      })
      setSaved(policy.pinEnabled)
      setDraft(policy.pinEnabled)
      clearOwnerPassword()
      setNotice('Shared Home PIN preference saved.')
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not save Home PIN preference.')
    } finally {
      setSaving(false)
    }
  }

  if (hidden) return null
  return (
    <section className="family-member-access-member" aria-label="Shared Home PIN requirement">
      <div className="family-member-access-heading">
        <strong>Shared Home PIN</strong>
      </div>
      <p>Choose whether the shared calendar display will ask for a four-digit PIN
        for routine actions. This does not add a PIN prompt to personal phones.
        Owner-only account settings will still require your password.</p>
      <p>The shared-device PIN verification feature is not active yet.
        This saves the setting for that later feature; it does not unlock
        existing permissions or bypass current identity checks.</p>
      {saved !== null && (
        <div className="family-member-access-field">
          <label htmlFor="family-home-pin-required">
            Require PIN on shared Home
          </label>
          <input id="family-home-pin-required" type="checkbox"
            checked={draft} disabled={saving}
            onChange={event => { setDraft(event.target.checked); setNotice('') }} />
          <button type="button"
            disabled={saving || saved === draft}
            onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save PIN preference'}
          </button>
        </div>
      )}
      {error && <p role="alert" className="household-settings-message is-error">{error}</p>}
      {notice && <p role="status" className="household-settings-message">{notice}</p>}
    </section>
  )
}
