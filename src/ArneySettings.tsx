import { useState } from 'react'
import { getArneySpeechDiagnostics } from './arneySpeech'
import {
  readArneyPreferences,
  saveArneyPreferences,
  type ArneyPreferences,
  type ArneyVoiceResponseMode,
} from './arneyPreferences'

type Props = {
  onChange?: (preferences: ArneyPreferences) => void
}

const responseModes: { value: ArneyVoiceResponseMode; title: string; description: string }[] = [
  { value: 'always', title: 'Always speak', description: 'Arney responds aloud to every command.' },
  { value: 'needed', title: 'Speak when needed', description: 'Speak for clarifications and important confirmations.' },
  { value: 'silent', title: 'Silent', description: 'Display results without spoken replies.' },
]

export default function ArneySettings({ onChange }: Props) {
  const [preferences, setPreferences] = useState(readArneyPreferences)
  const [error, setError] = useState(false)
  const [speechEvents, setSpeechEvents] = useState(getArneySpeechDiagnostics)

  // Read-only capability checks. Never request microphone permission here.
  const browser = typeof window === 'undefined' ? null : window
  const navigatorInfo = typeof navigator === 'undefined' ? null : navigator
  const speechStandard = !!browser && 'SpeechRecognition' in browser
  const speechWebkit = !!browser && 'webkitSpeechRecognition' in browser
  const microphoneApi = !!navigatorInfo?.mediaDevices?.getUserMedia
  const secureContext = browser?.isSecureContext === true

  function update(changes: Partial<ArneyPreferences>) {
    const next = { ...preferences, ...changes }
    if (!saveArneyPreferences(next)) {
      setError(true)
      return
    }
    setError(false)
    setPreferences(next)
    onChange?.(next)
    window.dispatchEvent(new Event('arney:preferences-changed'))
  }

  return (
    <section aria-labelledby="arney-settings-heading" style={{ display: 'grid', gap: 16 }}>
      <h2 id="arney-settings-heading">Arney voice settings</h2>
      <fieldset style={{ display: 'grid', gap: 12 }}>
        <legend>Voice response mode</legend>
        {responseModes.map((mode) => (
          <label key={mode.value} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <input
              type="radio"
              name="arney-response-mode"
              value={mode.value}
              checked={preferences.responseMode === mode.value}
              onChange={() => update({ responseMode: mode.value })}
            />
            <span><strong>{mode.title}</strong><span style={{ display: 'block' }}>{mode.description}</span></span>
          </label>
        ))}
      </fieldset>
      <label style={{ display: 'flex', gap: 10 }}>
        <input
          type="checkbox"
          checked={preferences.browserSpeechEnabled}
          onChange={(event) => update({ browserSpeechEnabled: event.target.checked })}
        />
        <span>
          <strong>Allow browser speech recognition</strong>
          <span style={{ display: 'block' }}>
            Optional. Your browser may send microphone audio to a cloud speech provider
            for transcription. The calendar does not control that service. Leave off for
            local-only use; no voice listening starts until you actively hold + or start
            wake-word listening.
          </span>
        </span>
      </label>
      <label style={{ display: 'flex', gap: 10 }}>
        <input
          type="checkbox"
          checked={preferences.wakeWordsEnabled}
          onChange={(event) => update({ wakeWordsEnabled: event.target.checked })}
        />
        <span><strong>Enable wake words</strong><span style={{ display: 'block' }}>Hey Arney, Arney, Computer, Calendar, Hey Calendar. Works only while this page is active and you explicitly start listening; the browser may use cloud speech processing. No background or screen-locked listening.</span></span>
      </label>
      <label style={{ display: 'flex', gap: 10 }}>
        <input
          type="checkbox"
          checked={preferences.confirmBeforeChanges}
          onChange={(event) => update({ confirmBeforeChanges: event.target.checked })}
        />
        <span><strong>Confirm before making changes</strong><span style={{ display: 'block' }}>Destructive actions will always require confirmation.</span></span>
      </label>
      <details>
        <summary>Browser voice diagnostics</summary>
        <div style={{ display: 'grid', gap: 6, marginTop: 10, overflowWrap: 'anywhere' }}>
          <div>Secure context: {secureContext ? 'Yes' : 'No'}</div>
          <div>Connection: {browser?.location.protocol ?? 'Unknown'}</div>
          <div>SpeechRecognition: {speechStandard ? 'Available' : 'Unavailable'}</div>
          <div>webkitSpeechRecognition: {speechWebkit ? 'Available' : 'Unavailable'}</div>
          <div>Microphone API (getUserMedia): {microphoneApi ? 'Available' : 'Unavailable'}</div>
          <small>Read-only checks. No microphone permission is requested and no audio is captured.</small>
          <div style={{ marginTop: 12 }}>
            <strong>Last voice attempt</strong>
            <p style={{ margin: '6px 0' }}>Browser events only. No audio or spoken words are saved.</p>
            <button type="button" onClick={() => setSpeechEvents(getArneySpeechDiagnostics())}>
              Refresh voice attempt log
            </button>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, marginTop: 8 }}>
              {speechEvents.length ? speechEvents.join('\n') : 'No attempt recorded in this tab yet.'}
            </pre>
          </div>
        </div>
      </details>
      <p style={{ margin: 0, opacity: 0.75 }}>Preferences are saved on this device only.</p>
      {error && <p role="alert">Could not save Arney settings on this device.</p>}
    </section>
  )
}
