import { useEffect, useRef, useState } from 'react'
import { arneySpeechAvailable, beginArneySpeech, type ArneySpeechSession } from './arneySpeech'
import { extractArneyWakeCommand } from './arneyWakePhrase'
import { readArneyPreferences } from './arneyPreferences'
import './ArneyWakeControl.css'

/**
 * Foreground-only, explicitly started browser recognition.
 * This is NOT an offline wake-word engine; browser transcription can use cloud.
 */
export default function ArneyWakeControl() {
  const [preferences, setPreferences] = useState(readArneyPreferences)
  const [active, setActive] = useState(false)
  const [status, setStatus] = useState('Off')
  const [wakeFeedback, setWakeFeedback] = useState('')
  const activeRef = useRef(false)
  const waitingRef = useRef(false)
  const sessionRef = useRef<ArneySpeechSession | null>(null)
  const timerRef = useRef<number | null>(null)

  function stopWake() {
    activeRef.current = false
    waitingRef.current = false
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    sessionRef.current?.cancel()
    sessionRef.current = null
    setActive(false)
    setStatus('Off')
  }

  function scheduleRound(waitingForCommand: boolean) {
    if (!activeRef.current) return
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      if (activeRef.current) listenRound(waitingForCommand)
    }, 350)
  }

  function listenRound(waitingForCommand: boolean) {
    if (!activeRef.current || document.visibilityState !== 'visible') {
      stopWake()
      return
    }
    setStatus(waitingForCommand ? 'Say your command…' : 'Listening for Arney…')
    sessionRef.current = beginArneySpeech(result => {
      sessionRef.current = null
      if (!activeRef.current) return
      if (result.kind === 'error') {
        stopWake()
        setStatus('Speech recognition stopped: ' + result.reason)
        setWakeFeedback('Browser recognition error: ' + result.reason)
        return
      }
      if (result.kind !== 'transcript') {
        setWakeFeedback('No speech recognized in the last listening round.')
        scheduleRound(waitingForCommand)
        return
      }

      const command = waitingForCommand
        ? result.text.trim()
        : extractArneyWakeCommand(result.text)

      if (command === null) {
        setWakeFeedback('Speech recognized, but the wake phrase did not match.')
        scheduleRound(false)
        return
      }
      if (!command) {
        setWakeFeedback('Wake phrase recognized. Now say your command.')
        waitingRef.current = true
        scheduleRound(true)
        return
      }
      setWakeFeedback('Wake phrase and command recognized.')

      // Stop recognition before handing the command to Arney, so it cannot
      // hear its own synthesized reply or submit the same command again.
      stopWake()
      window.dispatchEvent(new CustomEvent<string>('arney:voice-command', {
        detail: command,
      }))
    }, undefined, { finishOnFinalResult: true })
    if (!sessionRef.current && activeRef.current) {
      stopWake()
      setStatus('Speech recognition could not start')
    }
  }

  function startWake() {
    const prefs = readArneyPreferences()
    if (!prefs.browserSpeechEnabled || !prefs.wakeWordsEnabled || !arneySpeechAvailable()) {
      setStatus('Enable browser speech and wake words in Arney settings first')
      return
    }
    if (document.visibilityState !== 'visible') return
    activeRef.current = true
    waitingRef.current = false
    setWakeFeedback('')
    setActive(true)
    listenRound(false)
  }

  useEffect(() => {
    const refresh = () => setPreferences(readArneyPreferences())
    window.addEventListener('arney:preferences-changed', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('arney:preferences-changed', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  useEffect(() => {
    if (activeRef.current && (!preferences.browserSpeechEnabled || !preferences.wakeWordsEnabled)) {
      stopWake()
    }
  }, [preferences.browserSpeechEnabled, preferences.wakeWordsEnabled])

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState !== 'visible' && activeRef.current) stopWake()
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      activeRef.current = false
      sessionRef.current?.cancel()
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  if (!preferences.wakeWordsEnabled) return null
  const available = arneySpeechAvailable()
  const allowed = preferences.browserSpeechEnabled && available

  return (
    <div className="arney-wake-control" aria-live="polite">
      <button
        type="button"
        onClick={active ? stopWake : startWake}
        disabled={!allowed}
        aria-pressed={active}
        className={active ? 'arney-wake-active' : ''}
      >
        {active ? '■ Stop Arney listening' : '🎙 Start Arney wake words'}
      </button>
      <span>{available ? status : 'Speech unavailable in this browser'}</span>
      {wakeFeedback && <span>{wakeFeedback}</span>}
      {!preferences.browserSpeechEnabled && <span>Allow browser speech in Arney settings</span>}
    </div>
  )
}
