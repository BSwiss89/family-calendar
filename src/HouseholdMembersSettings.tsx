import { useCallback, useEffect, useState } from 'react'
import './HouseholdMembersSettings.css'

type Household = {
  householdId: string
  displayName: string
  role: 'owner' | 'member'
}
type Member = {
  userId: number
  username: string
  displayName: string
  role: 'owner' | 'member'
}
type PendingInvite = {
  id: number
  createdAt: number
  expiresAt: number
}
type HouseholdResponse = {
  households: Household[]
  selectedHouseholdId: string | null
}

class HouseholdRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(init.method && init.method !== 'GET'
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...init.headers,
    },
  })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof data === 'object' && data !== null &&
      'error' in data && typeof data.error === 'string'
      ? data.error : 'Could not load household settings.'
    throw new HouseholdRequestError(message, response.status)
  }
  return data as T
}

function understandableError(error: unknown) {
  if (error instanceof HouseholdRequestError) {
    if (error.status === 401) return 'Sign in to manage your household.'
    if (error.status === 403) return 'You do not have permission to manage household members.'
    if (error.status === 404) return 'Household & Members is not available on this calendar yet.'
    if (error.status === 429) return 'Too many invitations. Please try again later.'
    return error.message
  }
  return 'Cannot reach the calendar. Check your connection and try again.'
}

function validMemberList(value: unknown): value is { members: Member[] } {
  if (typeof value !== 'object' || value === null || !('members' in value) ||
      !Array.isArray(value.members)) return false
  return value.members.every((member: unknown) =>
    typeof member === 'object' && member !== null &&
    'userId' in member && Number.isSafeInteger(member.userId) &&
    'username' in member && typeof member.username === 'string' &&
    'displayName' in member && typeof member.displayName === 'string' &&
    'role' in member && (member.role === 'owner' || member.role === 'member'))
}

function validInvites(value: unknown): value is { invitations: PendingInvite[] } {
  return typeof value === 'object' && value !== null &&
    'invitations' in value && Array.isArray(value.invitations) &&
    value.invitations.every((invite: unknown) =>
      typeof invite === 'object' && invite !== null &&
      'id' in invite && Number.isSafeInteger(invite.id) &&
      'createdAt' in invite && Number.isFinite(invite.createdAt) &&
      'expiresAt' in invite && Number.isFinite(invite.expiresAt))
}

function dateLabel(time: number) {
  return new Date(time).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

export default function HouseholdMembersSettings() {
  const [household, setHousehold] = useState<Household | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<PendingInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [generatedLink, setGeneratedLink] = useState('')

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const info = await getJson<HouseholdResponse>('/api/households', { signal })
    if (!Array.isArray(info.households) || info.households.length !== 1 ||
      info.households.some(home =>
        !home || typeof home.householdId !== 'string' ||
        typeof home.displayName !== 'string' ||
        !['owner', 'member'].includes(home.role))) {
      throw new Error('This account does not have exactly one active household.')
    }
    const selected = info.households[0]
    if (selected.role === 'owner') {
      const [memberData, inviteData] = await Promise.all([
        getJson<unknown>('/api/households/members', { signal }),
        getJson<unknown>('/api/households/member-invitations', { signal }),
      ])
      if (!validMemberList(memberData) || !validInvites(inviteData)) {
        throw new Error('Unexpected household response.')
      }
      if (signal?.aborted) return
      setMembers(memberData.members)
      setInvitations(inviteData.invitations)
    } else {
      if (signal?.aborted) return
      // A member never receives private member-directory or invite metadata.
      setMembers([])
      setInvitations([])
    }
    setHousehold(selected)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    refresh(controller.signal).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      setHousehold(null)
      setError(understandableError(reason))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => {
      controller.abort()
      // An invite token must never survive closing the Settings page.
      setGeneratedLink('')
    }
  }, [refresh])

  async function createInvitation() {
    if (!household || household.role !== 'owner' || busy ||
      location.protocol !== 'https:') return
    setBusy(true)
    setError('')
    setNotice('')
    setGeneratedLink('')
    try {
      const invite = await getJson<{ token: string }>(
        '/api/households/member-invitations', { method: 'POST' })
      if (!/^[a-f0-9]{64}$/.test(invite.token)) throw new Error('Bad invite format.')
      // Build from the current trusted HTTPS origin, never a forwarded Host
      // supplied by a browser, and put the bearer secret only in the fragment.
      const link = new URL('/join#token=' + invite.token, window.location.origin)
      setGeneratedLink(link.href)
      await refresh()
      setNotice('Invitation created. Copy the link now; it is only shown once.')
    } catch (reason) {
      setError(understandableError(reason))
    } finally {
      setBusy(false)
    }
  }

  async function copyInvite() {
    if (!generatedLink) return
    try {
      await navigator.clipboard.writeText(generatedLink)
      setNotice('Invitation link copied.')
      setError('')
    } catch {
      setError('Copy was blocked. Select the link above and copy it manually.')
    }
  }

  async function revokeInvitation(invitationId: number) {
    if (busy || household?.role !== 'owner') return
    if (!window.confirm('Revoke this pending invitation? It will no longer work.')) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await getJson('/api/households/member-invitations/' +
        encodeURIComponent(String(invitationId)) + '/revoke', { method: 'POST' })
      setGeneratedLink('')
      await refresh()
      setNotice('Invitation revoked.')
    } catch (reason) {
      setError(understandableError(reason))
    } finally {
      setBusy(false)
    }
  }

  async function removeMember(member: Member) {
    if (busy || household?.role !== 'owner' || member.role !== 'member') return
    if (!window.confirm('Remove ' + member.displayName +
      ' from this household? Their login and existing calendar data will not be deleted.')) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await getJson('/api/households/members/' +
        encodeURIComponent(String(member.userId)) + '/remove', { method: 'POST' })
      await refresh()
      setNotice('Member access removed.')
    } catch (reason) {
      setError(understandableError(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="household-settings-page" aria-label="Household & Members settings">
      <header className="household-settings-heading">
        <span className="household-settings-eyebrow">Settings</span>
        <h1>Household &amp; Members</h1>
        <p>Manage who has access to your family calendar.</p>
      </header>

      {loading && <p role="status">Loading your household…</p>}
      {!loading && !household && (
        <div className="household-settings-card" role="status">
          <p>{error || 'No active household is available to this account.'}</p>
          <a href="/account">Account settings</a>
        </div>
      )}
      {household && (
        <>
          <div className="household-settings-card">
            <div className="household-settings-section-head">
              <div>
                <h2>{household.displayName}</h2>
                <p>You belong to this household as a {household.role}.</p>
              </div>
              <span className="household-settings-role">{household.role}</span>
            </div>
            <a href="/account" className="household-settings-account-link">
              Your account and trusted devices
            </a>
          </div>

          {household.role === 'owner' ? (
            <>
              <div className="household-settings-card">
                <div className="household-settings-section-head">
                  <div>
                    <h2>Members</h2>
                    <p>Only active people in this household are shown.</p>
                  </div>
                  <span className="household-settings-count">{members.length}</span>
                </div>
                <div className="household-settings-list">
                  {members.map(member => (
                    <div className="household-settings-member" key={member.userId}>
                      <span className="household-settings-avatar" aria-hidden="true">
                        {member.displayName.trim().charAt(0).toUpperCase() || '•'}
                      </span>
                      <div className="household-settings-member-info">
                        <strong>{member.displayName}</strong>
                        <span>@{member.username} · {member.role}</span>
                      </div>
                      {member.role === 'member' && (
                        <button type="button" className="household-settings-danger"
                          disabled={busy} onClick={() => void removeMember(member)}
                          aria-label={'Remove ' + member.displayName}>
                          Remove
                        </button>
                      )}
                      {member.role === 'owner' &&
                        <span className="household-settings-owner-label">Owner</span>}
                    </div>
                  ))}
                </div>
              </div>

              <div className="household-settings-card">
                <h2>Invite a household member</h2>
                <p>Send a private one-time link. It expires after 72 hours and lets
                  someone create a member account for this household only.</p>
                <button type="button" className="household-settings-primary"
                  disabled={busy || window.location.protocol !== 'https:'}
                  onClick={() => void createInvitation()}>
                  {busy ? 'Working…' : 'Create invitation link'}
                </button>
                {window.location.protocol !== 'https:' &&
                  <p>HTTPS is required to create an invitation.</p>}
                {generatedLink && (
                  <div className="household-settings-share">
                    <label htmlFor="household-settings-new-link">One-time invitation link</label>
                    <input id="household-settings-new-link" type="text"
                      readOnly value={generatedLink}
                      onFocus={event => event.currentTarget.select()}
                      aria-describedby="household-settings-link-hint" />
                    <button type="button" disabled={busy}
                      onClick={() => void copyInvite()}>Copy link</button>
                    <p id="household-settings-link-hint">
                      Share privately. Anyone with this link can use it once.
                    </p>
                  </div>
                )}
                <h3>Pending invitations</h3>
                <div className="household-settings-list">
                  {invitations.length === 0 && <p>No pending invitations.</p>}
                  {invitations.map(invite => (
                    <div className="household-settings-invite" key={invite.id}>
                      <div>
                        <strong>Invitation #{invite.id}</strong>
                        <span>Expires {dateLabel(invite.expiresAt)}</span>
                      </div>
                      <button type="button" className="household-settings-danger"
                        disabled={busy} onClick={() => void revokeInvitation(invite.id)}>
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="household-settings-card">
              <h2>Membership</h2>
              <p>Your household owner manages invitations and member access.
                You can use your shared family calendar normally.</p>
            </div>
          )}
        </>
      )}
      {(notice || (household && error)) && (
        <p className={'household-settings-message ' + (error ? 'is-error' : '')}
          role="status" aria-live="polite">
          {error || notice}
        </p>
      )}
    </section>
  )
}
