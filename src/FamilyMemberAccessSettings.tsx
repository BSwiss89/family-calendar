import { useCallback, useEffect, useState } from 'react'
import './FamilyMemberAccessSettings.css'
import SharedHomePinSettings from './SharedHomePinSettings'

type MemberType = 'owner' | 'adult' | 'child' | null
type AccessMember = {
  userId: number
  username: string
  displayName: string
  memberType: MemberType
  linkedPersonId: number | null
  linkedPersonName: string | null
  allowedActions: string[]
}
type Person = { id: number; name: string }
type AccessResponse = { members: AccessMember[]; availablePeople: Person[] }
type Permission = { action: string; label: string; adultOnly?: boolean }

const PERMISSIONS: Permission[] = [
  { action: 'calendar.view', label: 'View calendar' },
  { action: 'events.create', label: 'Create events' },
  { action: 'events.edit', label: 'Edit events' },
  { action: 'events.delete', label: 'Delete events' },
  { action: 'lists.view', label: 'View shopping lists' },
  { action: 'lists.edit', label: 'Edit shopping lists' },
  { action: 'tasks.view', label: 'View tasks' },
  { action: 'tasks.completeAssigned', label: 'Complete assigned tasks' },
  { action: 'tasks.manage', label: 'Manage family tasks' },
  { action: 'recipes.view', label: 'View recipes' },
  { action: 'recipes.edit', label: 'Edit recipes' },
  { action: 'settings.manage', label: 'Manage routine settings', adultOnly: true },
  { action: 'members.invite', label: 'Invite members', adultOnly: true },
]

function canConfigure(memberType: MemberType, permission: Permission): boolean {
  return memberType === 'adult' || (memberType === 'child' && !permission.adultOnly)
}

function validResponse(value: unknown): value is AccessResponse {
  if (!value || typeof value !== 'object') return false
  const payload = value as Record<string, unknown>
  if (!Array.isArray(payload.members) || !Array.isArray(payload.availablePeople)) return false
  return payload.members.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false
    const m = item as Record<string, unknown>
    return Number.isSafeInteger(m.userId) && (m.userId as number) > 0 &&
      typeof m.username === 'string' && typeof m.displayName === 'string' &&
      (m.memberType === null || ['owner', 'adult', 'child'].includes(String(m.memberType))) &&
      (m.linkedPersonId === null || Number.isSafeInteger(m.linkedPersonId)) &&
      (m.linkedPersonName === null || typeof m.linkedPersonName === 'string') &&
      Array.isArray(m.allowedActions) && m.allowedActions.every(a => typeof a === 'string')
  }) && payload.availablePeople.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false
    const p = item as Record<string, unknown>
    return Number.isSafeInteger(p.id) && (p.id as number) > 0 && typeof p.name === 'string'
  })
}

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    ...init, credentials: 'same-origin', cache: 'no-store',
    headers: {
      ...(init.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload &&
      typeof payload.error === 'string'
      ? payload.error : 'The family account change could not be saved.'
    throw Object.assign(new Error(error), { status: response.status })
  }
  return payload
}

type PermissionDraft = { action: string; enabled: boolean }

/**
 * Existing account/People information is displayed only on a private
 * authenticated household gateway. A 404 means the public legacy calendar
 * does not yet support this safe Owner management experience: stay hidden.
 * This page NEVER grants authority itself; the server checks the identity,
 * household membership, Owner password and requested action on each write.
 */
export default function FamilyMemberAccessSettings() {
  const [state, setState] = useState<'loading' | 'ready' | 'hidden' | 'error'>('loading')
  const [data, setData] = useState<AccessResponse | null>(null)
  const [ownerPassword, setOwnerPassword] = useState('')
  const [roleDrafts, setRoleDrafts] = useState<Record<number, string>>({})
  const [personDrafts, setPersonDrafts] = useState<Record<number, string>>({})
  const [permissionDrafts, setPermissionDrafts] = useState<Record<number, PermissionDraft>>({})
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await requestJson('/api/households/member-access', { signal })
      if (signal?.aborted) return
      if (!validResponse(result)) throw new Error('The household member response was invalid.')
      setData(result)
      setRoleDrafts(Object.fromEntries(result.members.map(m => [m.userId, m.memberType ?? ''])))
      setPersonDrafts(Object.fromEntries(result.members.map(m => [
        m.userId, m.linkedPersonId === null ? '' : String(m.linkedPersonId),
      ])))
      setPermissionDrafts(Object.fromEntries(result.members.flatMap(member => {
        const first = PERMISSIONS.find(p => canConfigure(member.memberType, p))
        return first ? [[member.userId, {
          action: first.action, enabled: member.allowedActions.includes(first.action),
        }]] : []
      })))
      setState('ready')
    } catch (problem) {
      if (signal?.aborted) return
      if (problem && typeof problem === 'object' && 'status' in problem && problem.status === 404) {
        setState('hidden')
      } else {
        setState('error')
        setError(problem instanceof Error ? problem.message : 'Member access is unavailable.')
      }
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  async function save(member: AccessMember, kind: 'type' | 'person' | 'permission') {
    if (busyId !== null) return
    if (!ownerPassword) {
      setError('Enter your Owner account password before saving changes.')
      return
    }
    let body: Record<string, unknown> = { ownerPassword }
    if (kind === 'type') {
      const memberType = roleDrafts[member.userId]
      if (memberType !== 'adult' && memberType !== 'child') return
      body = { ...body, memberType }
    } else if (kind === 'person') {
      const selected = personDrafts[member.userId] ?? ''
      body = { ...body, personId: selected === '' ? null : Number(selected) }
    } else {
      const permission = permissionDrafts[member.userId]
      if (!permission) return
      body = { ...body, action: permission.action, enabled: permission.enabled }
    }
    setBusyId(member.userId)
    setError('')
    setNotice('')
    try {
      await requestJson('/api/households/members/' + encodeURIComponent(String(member.userId)) +
        '/' + kind, { method: 'POST', body: JSON.stringify(body) })
      setOwnerPassword('')
      await load()
      setNotice('Account setting saved for ' + member.displayName + '.')
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not save member setting.')
    } finally {
      setBusyId(null)
    }
  }

  if (state === 'hidden' || state === 'loading') return null
  if (state === 'error') return (
    <div className="household-settings-card" role="status">
      <h2>Family account permissions</h2>
      <p>{error}</p>
      <button type="button" className="household-settings-primary"
        onClick={() => { setError(''); setState('loading'); void load() }}>Retry</button>
    </div>
  )
  if (!data) return null

  return (
    <div className="household-settings-card family-member-access" aria-label="Family member account permissions">
      <h2>Account roles and People links</h2>
      <p>Only your Owner account can change these settings. Your password is checked for each
        saved change. Personal phones do not need a four-digit Calendar PIN.</p>
      <label className="family-member-access-password">
        Owner account password
        <input type="password" autoComplete="current-password" value={ownerPassword}
          onChange={event => setOwnerPassword(event.target.value)}
          placeholder="Required to save changes" maxLength={200} />
      </label>
      <SharedHomePinSettings ownerPassword={ownerPassword}
        clearOwnerPassword={() => setOwnerPassword('')} />
      {data.members.map(member => {
        const kind = member.memberType
        const chosen = permissionDrafts[member.userId]
        const configured = PERMISSIONS.filter(permission => canConfigure(kind, permission))
        const role = roleDrafts[member.userId] ?? ''
        const person = personDrafts[member.userId] ?? ''
        const isBusy = busyId !== null
        return (
          <section className="family-member-access-member" key={member.userId}
            aria-label={'Account settings for ' + member.displayName}>
            <div className="family-member-access-heading">
              <strong>{member.displayName}</strong>
              <span>@{member.username} · {kind ?? 'Not configured'}</span>
            </div>
            {kind !== 'owner' && (
              <div className="family-member-access-field">
                <label htmlFor={'family-member-role-' + member.userId}>Account type</label>
                <select id={'family-member-role-' + member.userId}
                  value={role} disabled={isBusy}
                  onChange={event => setRoleDrafts(previous => ({
                    ...previous, [member.userId]: event.target.value,
                  }))}>
                  <option value="" disabled>Choose Adult or Child</option>
                  <option value="adult">Adult</option>
                  <option value="child">Child</option>
                </select>
                <button type="button" disabled={isBusy || !role || role === kind}
                  onClick={() => void save(member, 'type')}>Save type</button>
              </div>
            )}
            <div className="family-member-access-field">
              <label htmlFor={'family-member-person-' + member.userId}>Linked Person</label>
              <select id={'family-member-person-' + member.userId}
                value={person} disabled={isBusy || kind === null}
                onChange={event => setPersonDrafts(previous => ({
                  ...previous, [member.userId]: event.target.value,
                }))}>
                <option value="">Not linked</option>
                {data.availablePeople.map(profile => (
                  <option key={profile.id} value={profile.id}
                    disabled={data.members.some(other =>
                      other.userId !== member.userId && other.linkedPersonId === profile.id)}>
                    {profile.name}
                  </option>
                ))}
              </select>
              <button type="button" disabled={isBusy || kind === null ||
                  person === (member.linkedPersonId === null ? '' : String(member.linkedPersonId))}
                onClick={() => void save(member, 'person')}>Save Person</button>
            </div>
            {(kind === 'adult' || kind === 'child') && chosen && (
              <div className="family-member-access-field">
                <label htmlFor={'family-member-action-' + member.userId}>Permission</label>
                <select id={'family-member-action-' + member.userId} disabled={isBusy}
                  value={chosen.action}
                  onChange={event => setPermissionDrafts(previous => ({
                    ...previous,
                    [member.userId]: {
                      action: event.target.value,
                      enabled: member.allowedActions.includes(event.target.value),
                    },
                  }))}>
                  {configured.map(permission => (
                    <option key={permission.action} value={permission.action}>
                      {permission.label}
                    </option>
                  ))}
                </select>
                <select disabled={isBusy} aria-label={'Permission setting for ' + member.displayName}
                  value={chosen.enabled ? 'allowed' : 'blocked'}
                  onChange={event => setPermissionDrafts(previous => ({
                    ...previous, [member.userId]: { ...chosen, enabled: event.target.value === 'allowed' },
                  }))}>
                  <option value="allowed">Allow</option>
                  <option value="blocked">Restrict</option>
                </select>
                <button type="button" disabled={isBusy ||
                    member.allowedActions.includes(chosen.action) === chosen.enabled}
                  onClick={() => void save(member, 'permission')}>Save permission</button>
              </div>
            )}
          </section>
        )
      })}
      {error && <p role="alert" className="household-settings-message is-error">{error}</p>}
      {notice && <p role="status" className="household-settings-message">{notice}</p>}
    </div>
  )
}
