import { useEffect, useRef, useState } from 'react'
import {
  parseIncomingInvitations,
  type IncomingEventInvitation,
} from './eventSharingUiModel'

type InboxState = {
  available: boolean
  invitations: IncomingEventInvitation[]
  respondingId: number | null
  error: string
  respond: (shareId: number, decision: 'accepted' | 'declined') => Promise<boolean>
  refresh: () => Promise<void>
}

export function useInvitationInbox(): InboxState {
  const [available, setAvailable] = useState(false)
  const [invitations, setInvitations] = useState<IncomingEventInvitation[]>([])
  const [respondingId, setRespondingId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const mounted = useRef(true)
  const pendingRequest = useRef(false)

  async function refresh() {
    const current = ++generation.current
    try {
      const response = await fetch('/api/shared-events/invitations', {
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok ||
        !(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
        throw new Error('Invitation service is unavailable.')
      }
      const payload: unknown = await response.json()
      if (!payload || typeof payload !== 'object' ||
        !('invitations' in payload) || !Array.isArray(payload.invitations)) {
        throw new Error('Invalid invitation response.')
      }
      if (!mounted.current || current !== generation.current) return
      setInvitations(parseIncomingInvitations(payload))
      setAvailable(true)
      setError('')
    } catch {
      if (!mounted.current || current !== generation.current) return
      // Fail closed across logout, household changes and network errors.
      setInvitations([])
      setAvailable(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void refresh()
    const whenVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    const whenFocused = () => { void refresh() }
    window.addEventListener('focus', whenFocused)
    document.addEventListener('visibilitychange', whenVisible)
    const timer = window.setInterval(whenFocused, 30000)
    return () => {
      mounted.current = false
      generation.current++
      window.clearInterval(timer)
      window.removeEventListener('focus', whenFocused)
      document.removeEventListener('visibilitychange', whenVisible)
    }
  }, [])

  async function respond(shareId: number, decision: 'accepted' | 'declined') {
    if (!available || pendingRequest.current ||
      !Number.isSafeInteger(shareId) || shareId <= 0 ||
      !invitations.some(invitation => invitation.shareId === shareId)) return false
    pendingRequest.current = true
    setRespondingId(shareId)
    setError('')
    try {
      const response = await fetch('/api/shared-events/' + shareId + '/respond', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      if (!response.ok) {
        throw new Error('Could not respond to this invitation. Try again.')
      }
      if (mounted.current) {
        // Never merge a sender's local event ID into our editable event array.
        setInvitations(current => current.filter(invite => invite.shareId !== shareId))
        window.dispatchEvent(new Event('family-calendar:shared-events-changed'))
        await refresh()
      }
      return true
    } catch (reason) {
      if (mounted.current) setError(
        reason instanceof Error ? reason.message : 'Could not update invitation.'
      )
      return false
    } finally {
      pendingRequest.current = false
      if (mounted.current) setRespondingId(null)
    }
  }

  return { available, invitations, respondingId, error, respond, refresh }
}
