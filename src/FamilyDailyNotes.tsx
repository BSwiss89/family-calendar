import { useEffect, useRef, useState } from 'react'
import './FamilyDailyNotes.css'

type DailyNote = { day: string; text: string; revision: number }

function isDailyNote(value: unknown): value is DailyNote {
  if (!value || typeof value !== 'object') return false
  const note = value as Partial<DailyNote>
  return typeof note.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(note.day) &&
    typeof note.text === 'string' && typeof note.revision === 'number'
}

export default function FamilyDailyNotes({ disabled = false }: { disabled?: boolean }) {
  const [snapshot, setSnapshot] = useState<DailyNote | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const currentRef = useRef<DailyNote | null>(null)
  const dirtyRef = useRef(false)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    async function refresh() {
      try {
        const response = await fetch('/api/family-daily-note', {
          credentials: 'same-origin', cache: 'no-store',
        })
        if (!response.ok) throw new Error('Could not reach family notes.')
        const value: unknown = await response.json()
        if (!isDailyNote(value)) throw new Error('Unexpected family notes response.')
        if (!mountedRef.current) return
        // A midnight rollover always wins. Otherwise leave a person's unshared
        // draft alone until they explicitly share or reload it.
        if (!currentRef.current || currentRef.current.day !== value.day || !dirtyRef.current) {
          const previousDay = currentRef.current?.day
          currentRef.current = value
          dirtyRef.current = false
          setSnapshot(value)
          setDraft(value.text)
          if (previousDay && previousDay !== value.day) setMessage('New day — notes cleared.')
        }
        setLoading(false)
      } catch {
        if (mountedRef.current) {
          setLoading(false)
          setMessage('Family notes are temporarily unavailable.')
        }
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => { mountedRef.current = false; window.clearInterval(timer) }
  }, [])

  async function share() {
    const active = currentRef.current
    if (!active || saving) return
    setSaving(true)
    setMessage('')
    try {
      const response = await fetch('/api/family-daily-note', {
        method: 'PUT',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: draft, day: active.day, revision: active.revision }),
      })
      if (response.status === 409) {
        setMessage('Someone updated this note. Copy your changes, then tap Reload to see theirs.')
        return
      }
      if (!response.ok) throw new Error('Could not share family notes.')
      const value: unknown = await response.json()
      if (!isDailyNote(value)) throw new Error('Unexpected family notes response.')
      currentRef.current = value
      dirtyRef.current = false
      setSnapshot(value)
      setDraft(value.text)
      setMessage('Shared with family for today.')
    } catch {
      setMessage('Could not share. Your draft is still here.')
    } finally {
      setSaving(false)
    }
  }

  async function reload() {
    setLoading(true)
    try {
      const response = await fetch('/api/family-daily-note', {
        credentials: 'same-origin', cache: 'no-store',
      })
      if (!response.ok) throw new Error('Unable to reload.')
      const value: unknown = await response.json()
      if (!isDailyNote(value)) throw new Error('Invalid response.')
      currentRef.current = value
      dirtyRef.current = false
      setSnapshot(value)
      setDraft(value.text)
      setMessage('Showing the latest family note.')
    } catch {
      setMessage('Could not reload family notes.')
    } finally {
      setLoading(false)
    }
  }

  const changed = snapshot !== null && draft !== snapshot.text
  return (
    <div className="family-daily-notes" data-home-no-hold>
      <textarea
        aria-label="Shared family note for today"
        value={draft}
        onChange={(event) => {
          const value = event.target.value
          setDraft(value)
          dirtyRef.current = value !== currentRef.current?.text
          setMessage('')
        }}
        placeholder={loading ? 'Loading today’s notes…' : 'Add a note for today…'}
        maxLength={1200}
        readOnly={disabled || loading || snapshot === null || saving}
        rows={3}
      />
      <div className="family-daily-notes-bottom">
        <span>Shared today · clears at midnight or server restart</span>
        {changed && !disabled && (
          <button type="button" onClick={() => void share()} disabled={saving || loading}>
            {saving ? 'Sharing…' : 'Share changes'}
          </button>
        )}
      </div>
      {message && (
        <div className="family-daily-notes-message" role="status">
          {message}
          {message.includes('Someone updated') && (
            <button type="button" onClick={() => void reload()} disabled={loading}>Reload</button>
          )}
        </div>
      )}
    </div>
  )
}
