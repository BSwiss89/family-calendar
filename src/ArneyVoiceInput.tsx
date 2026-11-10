import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { arneySpeechAvailable, beginArneySpeech, type ArneySpeechResult, type ArneySpeechSession } from './arneySpeech'
import { readArneyPreferences } from './arneyPreferences'

type Props = {
  busy: boolean
  onTranscript: (text: string) => void
}

/**
 * One explicit press/hold/release voice attempt. Transcription only fills the
 * existing Arney editor; it NEVER sends a command or changes calendar data.
 * Browser recognizers may use third-party services, so require informed opt-in.
 */
export default function ArneyVoiceInput({ busy, onTranscript }: Props) {
  const [consented, setConsented] = useState(() => readArneyPreferences().browserSpeechEnabled)
  const [supported] = useState(arneySpeechAvailable)
  const [listening, setListening] = useState(false)
  const [message, setMessage] = useState('')
  const [failures, setFailures] = useState(0)
  const sessionRef = useRef<ArneySpeechSession | null>(null)
  const pointerRef = useRef<number | null>(null)
  const attemptRef = useRef(0)
  const releasedRef = useRef(false)
  const pendingRef = useRef<ArneySpeechResult | null>(null)

  function cancel(messageText: string) {
    attemptRef.current += 1
    pointerRef.current = null
    releasedRef.current = true
    pendingRef.current = null
    sessionRef.current?.cancel()
    sessionRef.current = null
    setListening(false)
    setMessage(messageText)
  }

  useEffect(() => {
    const onPreferences = () => {
      const enabled = readArneyPreferences().browserSpeechEnabled
      setConsented(enabled)
      if (!enabled && sessionRef.current) {
        attemptRef.current += 1
        sessionRef.current.cancel()
        sessionRef.current = null
        pointerRef.current = null
        pendingRef.current = null
        releasedRef.current = true
        setListening(false)
        setMessage('Listening stopped because browser speech was disabled.')
      }
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible' && sessionRef.current) {
        attemptRef.current += 1
        sessionRef.current.cancel()
        sessionRef.current = null
        pointerRef.current = null
        pendingRef.current = null
        releasedRef.current = true
        setListening(false)
        setMessage('Listening canceled when the page was hidden.')
      }
    }
    window.addEventListener('arney:preferences-changed', onPreferences)
    window.addEventListener('storage', onPreferences)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('arney:preferences-changed', onPreferences)
      window.removeEventListener('storage', onPreferences)
      document.removeEventListener('visibilitychange', onVisibility)
      attemptRef.current += 1
      sessionRef.current?.cancel()
      sessionRef.current = null
    }
  }, [])

  function deliver(result: ArneySpeechResult) {
    sessionRef.current = null
    pendingRef.current = null
    pointerRef.current = null
    setListening(false)
    if (result.kind === 'transcript' && result.text.trim()) {
      setFailures(0)
      onTranscript(result.text.trim().slice(0, 2000))
      setMessage('Speech captured. Review or edit the command, then choose Send.')
    } else {
      setFailures(current => current + 1)
      setMessage(result.kind === 'error'
        ? 'Speech recognition failed (' + result.reason + '). No command was sent.'
        : 'No words recognized. No command was sent.')
    }
  }

  function start(event: PointerEvent<HTMLButtonElement>) {
    if (busy || !consented || !supported || !event.isPrimary || event.button !== 0 ||
        sessionRef.current || pointerRef.current !== null) return
    event.preventDefault()
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* optional */ }
    const attempt = ++attemptRef.current
    pointerRef.current = event.pointerId
    releasedRef.current = false
    pendingRef.current = null
    setMessage('Listening. Release to finish.')
    const session = beginArneySpeech(result => {
      if (attempt !== attemptRef.current) return
      if (!releasedRef.current) {
        pendingRef.current = result
        setMessage('Speech captured. Release to review it.')
        return
      }
      deliver(result)
    })
    if (!session) {
      releasedRef.current = true
      pointerRef.current = null
      if (pendingRef.current) deliver(pendingRef.current)
      else {
        setFailures(current => current + 1)
        setMessage('This browser could not start speech recognition.')
      }
      return
    }
    if (attempt !== attemptRef.current) {
      session.cancel()
      return
    }
    sessionRef.current = session
    setListening(true)
  }

  function release(event: PointerEvent<HTMLButtonElement>) {
    if (event.pointerId !== pointerRef.current) return
    releasedRef.current = true
    pointerRef.current = null
    if (pendingRef.current) {
      deliver(pendingRef.current)
      return
    }
    setMessage('Processing speech…')
    sessionRef.current?.stop()
  }

  function interrupt(event: PointerEvent<HTMLButtonElement>) {
    if (event.pointerId === pointerRef.current) cancel('Voice attempt canceled. Nothing was sent.')
  }

  return (
    <div style={{ display: 'grid', gap: 8, marginBottom: 12 }} aria-label="Arney voice input">
      <button
        type="button"
        onPointerDown={start}
        onPointerUp={release}
        onPointerCancel={interrupt}
        disabled={busy || !consented || !supported}
        aria-pressed={listening}
        style={{
          touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
          borderRadius: 12, border: '1px solid #6366f1', minHeight: 48,
          padding: '10px 16px', fontWeight: 700,
          background: listening ? '#312e81' : '#eef2ff',
          color: listening ? '#fff' : '#312e81',
        }}
      >
        {listening ? '🎙 Listening — release to finish' : '🎙 Hold to talk to Arney'}
      </button>
      {!supported && <span>Speech recognition is unavailable in this browser. Use the text box instead.</span>}
      {!consented && supported && (
        <span>
          Browser speech is off by default. Audio may be processed by your browser provider.
          {' '}
          <button type="button" onClick={() => window.dispatchEvent(
            new Event('family-calendar:open-arney-settings')
          )}>Review speech settings</button>
        </span>
      )}
      {message && <span role="status" aria-live="polite">{message}</span>}
      {failures >= 3 && <span>Voice failed three times. You can type your request in the box below.</span>}
    </div>
  )
}

