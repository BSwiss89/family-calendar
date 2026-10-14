import { useEffect, useRef, useState } from 'react'
import { arneyReplyAudioActive, arneySpeechAvailable, beginArneySpeech, type ArneySpeechSession } from './arneySpeech'
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
  // The listener stays enabled while a command is being handled, but no
  // microphone session runs until processing and spoken output have finished.
  const commandPendingRef = useRef(false)
  const sessionRef = useRef<ArneySpeechSession | null>(null)
  const timerRef = useRef<number | null>(null)

  function stopWake() {
    activeRef.current = false
    waitingRef.current = false
    commandPendingRef.current = false
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

  function resumeWhenReplyFinishes() {
    if (!activeRef.current || commandPendingRef.current) return
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    // A brief delay also allows browser speech synthesis to start after Arney
    // queues its reply. The poll keeps listening off while speech is playing.
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      if (!activeRef.current || commandPendingRef.current) return
      if (document.visibilityState !== 'visible') {
        stopWake()
        return
      }
      if (arneyReplyAudioActive()) {
        setStatus('Waiting for Arney to finish speaking…')
        resumeWhenReplyFinishes()
        return
      }
      setWakeFeedback('')
      listenRound(false)
    }, 650)
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

      // The recognition adapter has already stopped this audio session.
      // Stay opted-in, but do not open a new microphone session until Arney
      // finishes processing the command (and any spoken reply).
      commandPendingRef.current = true
      waitingRef.current = false
      setStatus('Arney is processing your command…')
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
    commandPendingRef.current = false
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
    // Only an accepted desktop wake-word command triggers this event. Manual
    // Stop, browser tab hiding, or disabling consent prevents automatic resume.
    const onCommandFinished = () => {
      if (!activeRef.current || !commandPendingRef.current) return
      commandPendingRef.current = false
      setStatus('Preparing to listen again…')
      resumeWhenReplyFinishes()
    }
    window.addEventListener('arney:command-finished', onCommandFinished)
    return () => window.removeEventListener('arney:command-finished', onCommandFinished)
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
