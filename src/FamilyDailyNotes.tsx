import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import './FamilyDailyNotes.css'

type DailyNote = { day: string; text: string; revision: number }

function isDailyNote(value: unknown): value is DailyNote {
  if (!value || typeof value !== 'object') return false
  const note = value as Partial<DailyNote>
  return typeof note.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(note.day) &&
    typeof note.text === 'string' && typeof note.revision === 'number'
}

// Keep every note readable on small cards. Favor larger type when content fits;
// at 16px leave the textarea scrollable rather than clipping or zooming iOS.
function fitNoteFont(textarea: HTMLTextAreaElement) {
  if (textarea.clientWidth < 1 || textarea.clientHeight < 1) return
  for (let size = 26; size >= 16; size -= 1) {
    textarea.style.fontSize = `${size}px`
    if (textarea.scrollHeight <= textarea.clientHeight + 1) return
  }
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fitFont = useCallback(() => {
    if (textareaRef.current) fitNoteFont(textareaRef.current)
  }, [])

  useLayoutEffect(() => { fitFont() }, [draft, message, fitFont])
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const observer = new ResizeObserver(fitFont)
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [fitFont])

  // Successful shares are briefly acknowledged, not permanent footer text.
  useEffect(() => {
    if (message !== 'Shared with family for today.' &&
        message !== 'Showing the latest family note.' &&
        message !== 'New day — notes cleared.') return
    const timer = window.setTimeout(() => {
      setMessage((current) => current === message ? '' : current)
    }, 2600)
    return () => window.clearTimeout(timer)
  }, [message])

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
  const showControls = Boolean(message) || (changed && !disabled)
  return (
    <div className="family-daily-notes" data-home-no-hold>
      <textarea
        ref={textareaRef}
        className={showControls ? 'family-daily-notes-has-controls' : undefined}
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
      {showControls && (
        <div className="family-daily-notes-controls">
          {message && (
            <div className="family-daily-notes-message" role="status">
              {message}
              {message.includes('Someone updated') && (
                <button type="button" onClick={() => void reload()} disabled={loading}>Reload</button>
              )}
            </div>
          )}
          {changed && !disabled && (
            <button type="button" onClick={() => void share()} disabled={saving || loading}>
              {saving ? 'Sharing…' : 'Share changes'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
