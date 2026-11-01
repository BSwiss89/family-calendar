import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import {
  profileStorageKey, resolveProfileSelection, serializeProfileSelection, validateNewProfileInput,
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

type Screen = 'checking' | 'choose' | 'create' | 'ready' | 'error'

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
  const [newProfileName, setNewProfileName] = useState('')
  const [newProfileColor, setNewProfileColor] = useState('#477EBD')
  const [newProfilePhoto, setNewProfilePhoto] = useState<File | null>(null)
  const [creatingProfile, setCreatingProfile] = useState(false)
  const [createError, setCreateError] = useState('')

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


  async function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (screen !== 'create' || !storageKey || creatingProfile) return
    const name = newProfileName.trim()
    const validation = validateNewProfileInput(name, newProfileColor, newProfilePhoto)
    if (validation) {
      setCreateError(validation)
      return
    }
    setCreateError('')
    setCreatingProfile(true)
    try {
      const data = new FormData()
      data.append('name', name)
      data.append('color', newProfileColor)
      if (newProfilePhoto) data.append('image', newProfilePhoto, newProfilePhoto.name)
      const response = await fetch('/api/people', {
        method: 'POST',
        credentials: 'same-origin',
        body: data,
      })
      if (response.status === 401) {
        window.location.assign('/login')
        return
      }
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        if (response.status === 409) {
          throw new Error('That name already exists. Select the existing profile or use a different name.')
        }
        const serverError = payload && typeof payload === 'object' &&
          'error' in payload && typeof payload.error === 'string' ? payload.error : null
        throw new Error(serverError ?? 'Could not create the profile. Please try again.')
      }
      if (!isProfilePerson(payload)) {
        throw new Error('Profile saved, but the response could not be verified. Return to profiles to select it.')
      }
      const newPerson: ProfilePerson = payload
      setPeople((current) => [...current, newPerson])
      const savedSelection = serializeProfileSelection({ kind: 'person', personId: newPerson.id })
      let persisted = false
      try {
        if (savedSelection && storageKey) {
          window.localStorage.setItem(storageKey, savedSelection)
          persisted = true
          setNotSaved(false)
        }
      } catch {
        setNotSaved(true)
      }
      onProfileChange(newPerson.name)
      setScreen('ready')
      // Reload just the browser UI to refresh People everywhere (event assignment
      // picker, sliders, and Settings). No server restart or database migration.
      if (persisted) window.location.reload()
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create the profile.')
    } finally {
      setCreatingProfile(false)
    }
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
            {screen === 'choose' ? "Who's using the calendar?"
              : screen === 'create' ? 'Create your profile' : 'Opening your calendar'}
          </h1>
          <p id="household-profile-description">
            {screen === 'choose'
              ? 'Choose a profile for this device. Everyone can still see the shared family calendar.'
              : screen === 'create' ? 'Add a person to this household and start using the shared calendar.'
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
              <button type="button" className="household-profile-card household-profile-create-card"
                onClick={() => {
                  setCreateError('')
                  setScreen('create')
                }}>
                <span className="household-profile-avatar household-profile-add" aria-hidden="true">+</span>
                <strong>Create Profile</strong>
                <small>New household member</small>
              </button>
            </div>
            <p className="household-profile-footnote">
              Switch profiles anytime in Settings. Profiles do not change access or event assignments.
            </p>
          </>
        )}
        {screen === 'create' && (
          <form className="household-profile-create-form" onSubmit={(event) => { void createProfile(event) }}>
            <label htmlFor="household-new-profile-name">Profile name</label>
            <input id="household-new-profile-name" type="text" maxLength={50}
              autoComplete="name" autoFocus required disabled={creatingProfile}
              placeholder="First name or nickname" value={newProfileName}
              onChange={(event) => setNewProfileName(event.target.value)} />
            <label htmlFor="household-new-profile-color">Profile color</label>
            <input id="household-new-profile-color" type="color"
              value={newProfileColor} disabled={creatingProfile}
              onChange={(event) => setNewProfileColor(event.target.value)} />
            <label htmlFor="household-new-profile-photo">Profile photo (optional)</label>
            <input id="household-new-profile-photo" type="file"
              accept="image/jpeg,image/png,image/webp" disabled={creatingProfile}
              onChange={(event) => setNewProfilePhoto(event.target.files?.[0] ?? null)} />
            <p className="household-profile-photo-help">JPG, PNG or WebP, up to 20 MB. You can add a photo later.</p>
            {createError && <p className="household-profile-form-error" role="alert">{createError}</p>}
            <div className="household-profile-form-buttons">
              <button type="button" disabled={creatingProfile} className="household-profile-back"
                onClick={() => {
                  setCreateError('')
                  setScreen('choose')
                }}>Back to profiles</button>
              <button type="submit" disabled={creatingProfile || !newProfileName.trim()}
                className="household-profile-retry">
                {creatingProfile ? 'Creating…' : 'Create & Continue'}
              </button>
            </div>
          </form>
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
