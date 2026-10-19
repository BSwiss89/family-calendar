import { useEffect, useState } from 'react'

export type CalendarAccount = {
  username: string
  displayName: string
  accountKind: 'person' | 'hub'
}

export type VerifiedEventCreator = {
  eventId: number
  username: string
  displayName: string
  accountKind: 'person' | 'hub'
  createdAt: number
}

function validAccountKind(value: unknown): value is 'person' | 'hub' {
  return value === 'person' || value === 'hub'
}

export function parseCalendarAccount(payload: unknown): CalendarAccount | null {
  if (!payload || typeof payload !== 'object' ||
    !('enabled' in payload) || payload.enabled !== true ||
    !('authenticated' in payload) || payload.authenticated !== true ||
    !('username' in payload) || typeof payload.username !== 'string' ||
    !/^[a-zA-Z0-9._-]{3,40}$/.test(payload.username) ||
    !('displayName' in payload) || typeof payload.displayName !== 'string' ||
    !payload.displayName.trim() || payload.displayName.length > 80 ||
    !('accountKind' in payload) || !validAccountKind(payload.accountKind)) {
    return null
  }
  return {
    username: payload.username,
    displayName: payload.displayName.trim(),
    accountKind: payload.accountKind,
  }
}

export function parseEventCreatorLabels(payload: unknown): VerifiedEventCreator[] {
  if (!payload || typeof payload !== 'object' ||
    !('creators' in payload) || !Array.isArray(payload.creators)) return []
  const seen = new Set<number>()
  const result: VerifiedEventCreator[] = []
  for (const item of payload.creators) {
    if (!item || typeof item !== 'object' ||
      !('eventId' in item) || !Number.isSafeInteger(item.eventId) ||
      (item.eventId as number) <= 0 || seen.has(item.eventId as number) ||
      !('username' in item) || typeof item.username !== 'string' ||
      !/^[a-zA-Z0-9._-]{3,40}$/.test(item.username) ||
      !('displayName' in item) || typeof item.displayName !== 'string' ||
      !item.displayName.trim() || item.displayName.length > 80 ||
      !('accountKind' in item) || !validAccountKind(item.accountKind) ||
      !('createdAt' in item) || !Number.isSafeInteger(item.createdAt) ||
      (item.createdAt as number) <= 0) continue
    const eventId = item.eventId as number
    seen.add(eventId)
    result.push({
      eventId,
      username: item.username,
      displayName: item.displayName.trim(),
      accountKind: item.accountKind,
      createdAt: item.createdAt as number,
    })
    if (result.length >= 5000) break
  }
  return result
}

/**
 * Legacy calendar authentication may be disabled; do not invent an actor
 * or trust browser-provided event owner names. The private gateway alone
 * signs in members and owns creation attribution.
 */
export function useAuthenticatedCalendarIdentity(eventsRevision: readonly unknown[]) {
  const [account, setAccount] = useState<CalendarAccount | null>(null)
  const [creators, setCreators] = useState<VerifiedEventCreator[]>([])

  useEffect(() => {
    let alive = true
    let controller: AbortController | null = null
    async function refreshIdentity() {
      controller?.abort()
      const current = new AbortController()
      controller = current
      try {
        const response = await fetch('/api/auth/status', {
          credentials: 'same-origin', cache: 'no-store', signal: current.signal,
        })
        const data: unknown = response.ok ? await response.json() : null
        if (!alive || current.signal.aborted) return
        setAccount(parseCalendarAccount(data))
      } catch {
        if (alive && !current.signal.aborted) setAccount(null)
      }
    }
    void refreshIdentity()
    window.addEventListener('focus', refreshIdentity)
    return () => {
      alive = false
      controller?.abort()
      window.removeEventListener('focus', refreshIdentity)
    }
  }, [])

  useEffect(() => {
    let alive = true
    async function refreshCreators() {
      try {
        const response = await fetch('/api/event-creators', {
          credentials: 'same-origin', cache: 'no-store',
        })
        if (!response.ok ||
          !(response.headers.get('content-type') ?? '').includes('application/json')) {
          if (alive) setCreators([])
          return
        }
        const payload: unknown = await response.json()
        if (alive) setCreators(parseEventCreatorLabels(payload))
      } catch {
        if (alive) setCreators([])
      }
    }
    void refreshCreators()
    return () => { alive = false }
  }, [eventsRevision])

  return { account, creators }
}
