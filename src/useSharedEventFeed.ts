import { useEffect, useState } from 'react'
import { parseAcceptedSharedEvents, type AcceptedSharedEvent } from './sharedEventOverlay'

/**
 * Read-only inbox. No event-sharing endpoint exists in the legacy server,
 * so an HTML fallback, 404, non-JSON response, logout or network failure
 * produces no overlay and never interrupts the normal family calendar.
 */
export function useSharedEventFeed(enabled: boolean): AcceptedSharedEvent[] {
  const [events, setEvents] = useState<AcceptedSharedEvent[]>([])

  useEffect(() => {
    if (!enabled) {
      setEvents([])
      return
    }

    let disposed = false
    let request: AbortController | null = null

    async function refresh() {
      request?.abort()
      const current = new AbortController()
      request = current
      try {
        const response = await fetch('/api/shared-events/accepted', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: current.signal,
        })
        const contentType = response.headers.get('content-type') ?? ''
        if (!response.ok || !contentType.toLowerCase().includes('application/json')) {
          if (!disposed && !current.signal.aborted) setEvents([])
          return
        }
        const data: unknown = await response.json()
        if (!disposed && !current.signal.aborted) {
          setEvents(parseAcceptedSharedEvents(data))
        }
      } catch {
        // Fail closed rather than continuing to show revoked sharing data.
        if (!disposed && !current.signal.aborted) setEvents([])
      }
    }

    const refreshOnFocus = () => { void refresh() }
    const refreshOnVisibility = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    void refresh()
    const interval = window.setInterval(refreshOnFocus, 30000)
    window.addEventListener('focus', refreshOnFocus)
    document.addEventListener('visibilitychange', refreshOnVisibility)

    return () => {
      disposed = true
      request?.abort()
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshOnFocus)
      document.removeEventListener('visibilitychange', refreshOnVisibility)
    }
  }, [enabled])

  return enabled ? events : []
}
