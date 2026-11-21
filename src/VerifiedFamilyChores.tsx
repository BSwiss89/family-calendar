import { useCallback, useEffect, useState, type FormEvent } from 'react'
import './VerifiedFamilyChores.css'

export type VerifiedChoresCapability = {
  enabled: true
  linkedPersonId: number | null
  canManage: boolean
  canCompleteOwn: boolean
}

type AssignedTask = {
  taskId: number
  title: string
  assignedPersonId: number
  createdAt: number
  completedAt: number | null
}

type ChoresProps = {
  capability: VerifiedChoresCapability
  people: Array<{ id: number; name: string }>
}

const BASE = '/api/family-assigned-tasks'

function safeCapability(input: unknown): VerifiedChoresCapability | null {
  if (!input || typeof input !== 'object') return null
  const c = input as Record<string, unknown>
  if (c.enabled !== true ||
      (c.linkedPersonId !== null &&
        (!Number.isSafeInteger(c.linkedPersonId) || (c.linkedPersonId as number) < 1)) ||
      typeof c.canManage !== 'boolean' || typeof c.canCompleteOwn !== 'boolean') {
    return null
  }
  return {
    enabled: true,
    linkedPersonId: c.linkedPersonId as number | null,
    canManage: c.canManage,
    canCompleteOwn: c.canCompleteOwn,
  }
}

/**
 * The installed calendars do not publish the capability route, so this
 * returns null and preserves their existing disabled Chores navigation.
 * A People avatar never supplies the account identity or an HTTP actor.
 */
export function useVerifiedChoresCapability(authEnabled: boolean) {
  const [capability, setCapability] = useState<VerifiedChoresCapability | null>(null)
  useEffect(() => {
    let active = true
    setCapability(null)
    if (!authEnabled) return () => { active = false }
    fetch(BASE + '/capability', {
      credentials: 'same-origin', cache: 'no-store',
    })
      .then(async response => {
        if (!response.ok) return null
        return safeCapability(await response.json())
      })
      .then(value => { if (active) setCapability(value) })
      .catch(() => { if (active) setCapability(null) })
    return () => { active = false }
  }, [authEnabled])
  return capability
}

function safeTasks(input: unknown): AssignedTask[] {
  if (!input || typeof input !== 'object') throw new Error('Invalid task response.')
  const rows = (input as { tasks?: unknown }).tasks
  if (!Array.isArray(rows)) throw new Error('Invalid task response.')
  return rows.filter((row): row is AssignedTask => {
    if (!row || typeof row !== 'object') return false
    const t = row as Record<string, unknown>
    return Number.isSafeInteger(t.taskId) && (t.taskId as number) > 0 &&
      typeof t.title === 'string' &&
      Number.isSafeInteger(t.assignedPersonId) && (t.assignedPersonId as number) > 0 &&
      Number.isSafeInteger(t.createdAt) &&
      (t.completedAt === null || Number.isSafeInteger(t.completedAt))
  })
}

export default function VerifiedFamilyChores({ capability, people }: ChoresProps) {
  const [tasks, setTasks] = useState<AssignedTask[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState('')

  const loadTasks = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(BASE, {
        credentials: 'same-origin', cache: 'no-store', signal,
      })
      if (!response.ok) throw new Error('Unable to load family tasks.')
      const body: unknown = await response.json()
      const next = safeTasks(body)
      if (!signal?.aborted) setTasks(next)
    } catch {
      if (!signal?.aborted) {
        setTasks([])
        setError('Tasks are unavailable. Your session or permissions may have changed.')
      }
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadTasks(controller.signal)
    return () => controller.abort()
  }, [loadTasks])

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!capability.canManage || !title.trim() || !assignee || creating) return
    const assignedPersonId = Number(assignee)
    if (!people.some(person => person.id === assignedPersonId)) return
    setCreating(true)
    setError('')
    try {
      const response = await fetch(BASE, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), assignedPersonId }),
      })
      if (!response.ok) throw new Error('Cannot assign task')
      setTitle('')
      setAssignee('')
      await loadTasks()
    } catch {
      setTasks([])
      setError('Could not assign the task. Check your household permissions.')
    } finally {
      setCreating(false)
    }
  }

  async function updateTask(taskId: number, action: 'complete' | 'reopen') {
    if (busyId !== null || creating) return
    setBusyId(taskId)
    setError('')
    try {
      const response = await fetch(BASE + '/' + taskId + '/' + action, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (!response.ok) throw new Error('Task action not allowed')
      await loadTasks()
    } catch {
      setTasks([])
      setError('Could not change the task. Check your session and permissions.')
    } finally {
      setBusyId(null)
    }
  }

  const displayName = (id: number) =>
    people.find(person => person.id === id)?.name ?? 'Household member'

  const remaining = tasks.filter(task => task.completedAt === null)
  const completed = tasks.filter(task => task.completedAt !== null)

  return (
    <section className="verified-chores-page" aria-labelledby="verified-chores-heading">
      <div className="verified-chores-heading">
        <div>
          <span className="verified-chores-eyebrow">Family tasks</span>
          <h2 id="verified-chores-heading">Chores</h2>
          <p>{capability.canManage
            ? 'Assign everyday tasks and see what your household has finished.'
            : 'See your assigned tasks and mark them done.'}</p>
        </div>
        <button type="button" className="verified-chores-refresh"
          disabled={loading || busyId !== null || creating}
          onClick={() => void loadTasks()}>Refresh</button>
      </div>

      {capability.canManage && (
        <form className="verified-chores-add" onSubmit={event => void submitTask(event)}>
          <label>
            Task
            <input required maxLength={200} value={title}
              onChange={event => setTitle(event.target.value)}
              placeholder="Example: Take out the trash" />
          </label>
          <label>
            Assign to
            <select required value={assignee} onChange={event => setAssignee(event.target.value)}>
              <option value="">Choose a person</option>
              {people.map(person => (
                <option key={person.id} value={person.id}>{person.name}</option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={creating || busyId !== null ||
            !title.trim() || !assignee}>
            {creating ? 'Assigning…' : 'Assign task'}
          </button>
        </form>
      )}

      {error && <p className="verified-chores-error" role="alert">{error}</p>}
      {loading ? (
        <p className="verified-chores-empty" role="status">Loading tasks…</p>
      ) : (
        <>
          <section aria-labelledby="verified-chores-open-heading">
            <h3 id="verified-chores-open-heading">To do <span>({remaining.length})</span></h3>
            {remaining.length === 0 ? (
              <p className="verified-chores-empty">No unfinished tasks to show.</p>
            ) : (
              <ul className="verified-chores-list">
                {remaining.map(task => {
                  const own = task.assignedPersonId === capability.linkedPersonId
                  const canComplete = own && capability.canCompleteOwn
                  return <li key={task.taskId}>
                    <div className="verified-chores-detail">
                      <strong>{task.title}</strong>
                      <small>Assigned to {displayName(task.assignedPersonId)}</small>
                    </div>
                    {canComplete && <button type="button" disabled={busyId !== null || creating}
                      onClick={() => void updateTask(task.taskId, 'complete')}>
                      {busyId === task.taskId ? 'Saving…' : 'Mark done'}
                    </button>}
                    {!canComplete && <span className="verified-chores-assigned">Assigned</span>}
                  </li>
                })}
              </ul>
            )}
          </section>
          {completed.length > 0 && (
            <section aria-labelledby="verified-chores-done-heading">
              <h3 id="verified-chores-done-heading">Completed <span>({completed.length})</span></h3>
              <ul className="verified-chores-list verified-chores-completed">
                {completed.map(task => <li key={task.taskId}>
                  <div className="verified-chores-detail">
                    <strong>{task.title}</strong>
                    <small>{displayName(task.assignedPersonId)} · Done</small>
                  </div>
                  {capability.canManage ? (
                    <button type="button" disabled={busyId !== null || creating}
                      onClick={() => void updateTask(task.taskId, 'reopen')}>
                      {busyId === task.taskId ? 'Saving…' : 'Reopen'}
                    </button>
                  ) : <span className="verified-chores-assigned">✓ Done</span>}
                </li>)}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  )
}
