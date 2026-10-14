import { useState } from 'react'
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
        <span><strong>Enable wake words</strong><span style={{ display: 'block' }}>Hey Arney, Arney, Computer. Works only while this page is active and you explicitly start listening; the browser may use cloud speech processing. No background or screen-locked listening.</span></span>
      </label>
      <label style={{ display: 'flex', gap: 10 }}>
        <input
          type="checkbox"
          checked={preferences.confirmBeforeChanges}
          onChange={(event) => update({ confirmBeforeChanges: event.target.checked })}
        />
        <span><strong>Confirm before making changes</strong><span style={{ display: 'block' }}>Destructive actions will always require confirmation.</span></span>
      </label>
      <p style={{ margin: 0, opacity: 0.75 }}>Preferences are saved on this device only.</p>
      {error && <p role="alert">Could not save Arney settings on this device.</p>}
    </section>
  )
}
