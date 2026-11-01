import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import {
  profileStorageKey, resolveProfileSelection, serializeProfileSelection,
  type HouseholdProfileSelection,
} from './householdProfileSelection.mjs'
import './HouseholdProfilePicker.css'

type ProfilePerson = {
  id: number
  name: string
  color: string
  image: string | null
}

type Props = {
  switchRequest: number
  onProfileChange: (name: string | null) => void
}

type Screen = 'checking' | 'choose' | 'ready' | 'error'

function isProfilePerson(value: unknown): value is ProfilePerson {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return Number.isSafeInteger(item.id) && (item.id as number) > 0 &&
    typeof item.name === 'string' && item.name.trim().length > 0 &&
    typeof item.color === 'string' &&
    (item.image === null || typeof item.image === 'string')
}

function PersonPicture({ person }: { person: ProfilePerson }) {
  const [imageFailed, setImageFailed] = useState(false)
  const fallbackStyle: CSSProperties = {
    backgroundColor: /^#[0-9a-f]{3,8}$/i.test(person.color) ? person.color : '#64748b',
  }
  if (person.image && !imageFailed) {
    return (
      <img className="household-profile-avatar" src={'/uploads/' + encodeURIComponent(person.image)}
        alt="" onError={() => setImageFailed(true)} />
    )
  }
  return (
    <span className="household-profile-avatar household-profile-initial" style={fallbackStyle}
      aria-hidden="true">{person.name.charAt(0).toUpperCase()}</span>
  )
}

/**
 * A profile is an identification preference for this browser. It never changes
 * server authentication, permissions, People, event assignments or shared data.
 */
export default function HouseholdProfilePicker({ switchRequest, onProfileChange }: Props) {
  const [screen, setScreen] = useState<Screen>('checking')
  const [people, setPeople] = useState<ProfilePerson[]>([])
  const [storageKey, setStorageKey] = useState<string | null>(null)
  const [errorText, setErrorText] = useState('')
  const [notSaved, setNotSaved] = useState(false)

  const refresh = useCallback(async (forcePicker = false) => {
    setScreen('checking')
    setErrorText('')
    try {
      const authResponse = await fetch('/api/auth/status', {
        credentials: 'same-origin', cache: 'no-store',
      })
      if (!authResponse.ok) throw new Error('Could not verify your login.')
      const auth: unknown = await authResponse.json()
      if (!auth || typeof auth !== 'object' || !('enabled' in auth) ||
        auth.enabled !== true) {
        // Legacy, authentication-disabled calendars retain their existing UI.
        onProfileChange(null)
        setScreen('ready')
        return
      }
      if (!('authenticated' in auth) || auth.authenticated !== true) {
        // A saved Home/person selection is never a substitute for authentication.
        window.location.assign('/login')
        return
      }
      const key = profileStorageKey('username' in auth ? auth.username : null,
        'householdId' in auth ? auth.householdId : null)
      if (key === null) throw new Error('The account could not be identified.')
      const peopleResponse = await fetch('/api/people', {
        credentials: 'same-origin', cache: 'no-store',
      })
      if (peopleResponse.status === 401 || peopleResponse.status === 403) {
        window.location.assign('/login')
        return
      }
      if (!peopleResponse.ok) throw new Error('Could not load family profiles.')
      const payload: unknown = await peopleResponse.json()
      if (!Array.isArray(payload) || !payload.every(isProfilePerson)) {
        throw new Error('Family profiles could not be read safely.')
      }
      const records: ProfilePerson[] = payload
      setPeople(records)
      setStorageKey(key)

      let remembered: string | null = null
      try {
        remembered = window.localStorage.getItem(key)
      } catch {
        setNotSaved(true)
      }
      // Set up a wall device once using /?display=home after sign-in.
      // An existing selection always takes precedence, including an invalid
      // one that should require re-selection after a person was deleted.
      const wallSetup = new URLSearchParams(window.location.search).get('display') === 'home'
      const selection = resolveProfileSelection(remembered, records, wallSetup)
      if (selection && !forcePicker) {
        if (remembered === null && wallSetup) {
          try { window.localStorage.setItem(key, 'home') } catch { setNotSaved(true) }
        }
        const person = selection.kind === 'person'
          ? records.find((item) => item.id === selection.personId) : null
        onProfileChange(person?.name ?? 'Home')
        setScreen('ready')
      } else {
        setScreen('choose')
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Could not open family profiles.')
      setScreen('error')
    }
  }, [onProfileChange])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (switchRequest > 0) void refresh(true)
  }, [switchRequest, refresh])

  function selectProfile(selection: HouseholdProfileSelection) {
    if (screen !== 'choose' || !storageKey) return
    const person = selection.kind === 'person'
      ? people.find((entry) => entry.id === selection.personId) : null
    if (selection.kind === 'person' && !person) return
    const value = serializeProfileSelection(selection)
    if (value === null) return
    try {
      window.localStorage.setItem(storageKey, value)
      setNotSaved(false)
    } catch {
      setNotSaved(true)
    }
    onProfileChange(person?.name ?? 'Home')
    setScreen('ready')
  }

  if (screen === 'ready') {
    return notSaved ? <div className="household-profile-save-warning" role="status">
      Profile selected, but this browser cannot remember it. Check browser storage settings.
    </div> : null
  }

  return (
    <div className="household-profile-backdrop">
      <section className="household-profile-dialog" role="dialog" aria-modal="true"
        aria-labelledby="household-profile-title" aria-describedby="household-profile-description">
        <div className="household-profile-header">
          <span className="household-profile-eyebrow">Family Calendar</span>
          <h1 id="household-profile-title">
            {screen === 'choose' ? "Who's using the calendar?" : 'Opening your calendar'}
          </h1>
          <p id="household-profile-description">
            {screen === 'choose'
              ? 'Choose a profile for this device. Everyone can still see the shared family calendar.'
              : screen === 'error' ? errorText : 'Checking your household and family profiles…'}
          </p>
        </div>
        {screen === 'choose' && (
          <>
            <div className="household-profile-grid">
              <button className="household-profile-card" type="button"
                onClick={() => selectProfile({ kind: 'home' })}>
                <span className="household-profile-avatar household-profile-house" aria-hidden="true">🏠</span>
                <strong>Home</strong>
                <small>Shared family display</small>
              </button>
              {people.map((person) => (
                <button type="button" className="household-profile-card" key={person.id}
                  onClick={() => selectProfile({ kind: 'person', personId: person.id })}>
                  <PersonPicture key={person.id + ':' + person.image} person={person} />
                  <strong>{person.name}</strong>
                  <small>Personal profile</small>
                </button>
              ))}
            </div>
            <p className="household-profile-footnote">
              Switch profiles anytime in Settings. Profiles do not change access or event assignments.
            </p>
          </>
        )}
        {screen === 'checking' && <div className="household-profile-loading" role="status">Loading profiles…</div>}
        {screen === 'error' && (
          <button className="household-profile-retry" type="button"
            onClick={() => void refresh(true)}>Retry</button>
        )}
      </section>
    </div>
  )
}
