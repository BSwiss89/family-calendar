import { useEffect, useRef, useState } from 'react'

// Only consumed from the authenticated, single-household TEST pilot. These
// numbers describe assignments for the server-selected device profile; they
// are not verified personal identities or Web Push subscriptions.
export type AssignmentNotice = {
  id: number
  eventId: number
  kind: 'assigned' | 'changed' | 'unassigned' | 'cancelled'
  createdAt: number
  acknowledged: boolean
}

const kinds = new Set(['assigned','changed','unassigned','cancelled'])
function parseNotice(input: unknown): AssignmentNotice | null {
  if (!input || typeof input !== 'object') return null
  const row = input as Record<string,unknown>
  if (!Number.isSafeInteger(row.id) || (row.id as number) <= 0 ||
    !Number.isSafeInteger(row.eventId) || (row.eventId as number) <= 0 ||
    typeof row.kind !== 'string' || !kinds.has(row.kind) ||
    !Number.isSafeInteger(row.createdAt) || (row.createdAt as number) <= 0 ||
    typeof row.acknowledged !== 'boolean') return null
  return {
    id: row.id as number,
    eventId: row.eventId as number,
    kind: row.kind as AssignmentNotice['kind'],
    createdAt: row.createdAt as number,
    acknowledged: row.acknowledged as boolean,
  }
}

export function useAssignmentInbox(personId: number | null) {
  const [available,setAvailable] = useState(false)
  const [notifications,setNotifications] = useState<AssignmentNotice[]>([])
  const [acknowledgingId,setAcknowledgingId] = useState<number | null>(null)
  const [error,setError] = useState('')
  const currentRequest = useRef(0)
  const responding = useRef(false)

  async function refresh() {
    const req = ++currentRequest.current
    if (!personId || !Number.isSafeInteger(personId)) {
      setNotifications([])
      setAvailable(false)
      return
    }
    try {
      // Do not trigger reconciliation unless this pilot is enabled and the
      // current server session is actually scoped to the selected person.
      const first = await fetch('/api/test-notification-pilot',{
        credentials:'same-origin',cache:'no-store',
      })
      if (!first.ok) throw new Error('Assignment inbox unavailable.')
      const identity: unknown = await first.json()
      if (!identity || typeof identity !== 'object' ||
        (identity as {personId?:unknown}).personId !== personId) {
        throw new Error('Selected profile differs from the server session.')
      }
      const reconciled = await fetch('/test-notification-pilot/refresh',{
        method:'POST',credentials:'same-origin',cache:'no-store',
      })
      if (!reconciled.ok) throw new Error('Could not refresh assigned events.')
      const latest = await fetch('/api/test-notification-pilot',{
        credentials:'same-origin',cache:'no-store',
      })
      if (!latest.ok) throw new Error('Assignment inbox unavailable.')
      const payload: unknown = await latest.json()
      if (!payload || typeof payload !== 'object' ||
        (payload as {personId?:unknown}).personId !== personId ||
        !Array.isArray((payload as {notifications?:unknown}).notifications)) {
        throw new Error('Invalid assignment inbox response.')
      }
      if (currentRequest.current !== req) return
      const rows = (payload as {notifications:unknown[]}).notifications
      setNotifications(rows.map(parseNotice).filter((n):n is AssignmentNotice=>n!==null)
        .filter(n=>!n.acknowledged).slice(0,50))
      setAvailable(true)
      setError('')
    } catch {
      if (currentRequest.current !== req) return
      setNotifications([])
      setAvailable(false)
    }
  }

  useEffect(()=>{
    void refresh()
    const check = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus',check)
    document.addEventListener('visibilitychange',check)
    const timer=window.setInterval(check,30000)
    return ()=> {
      currentRequest.current++
      window.clearInterval(timer)
      window.removeEventListener('focus',check)
      document.removeEventListener('visibilitychange',check)
    }
    // Only rebind on verified profile identity change, not every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[personId])

  async function acknowledge(id: number): Promise<boolean> {
    if (responding.current || !available ||
      !notifications.some(note=>note.id===id)) return false
    responding.current = true
    setAcknowledgingId(id)
    setError('')
    try {
      const response=await fetch('/api/test-notification-pilot/'+id+'/acknowledge',{
        method:'POST',credentials:'same-origin',cache:'no-store',
      })
      if(!response.ok) throw new Error('Could not acknowledge this notification.')
      setNotifications(current=>current.filter(n=>n.id!==id))
      return true
    }catch(e) {
      setError(e instanceof Error ? e.message : 'Could not acknowledge this notification.')
      return false
    }finally{
      responding.current = false
      setAcknowledgingId(null)
    }
  }

  return {available,notifications,acknowledgingId,error,acknowledge,refresh}
}
