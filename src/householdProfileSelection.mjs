// Profile selection is a browser preference, never a server-side permission.
export const HOME_SELECTION = 'home'

export function profileStorageKey(username, householdId = null) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,40}$/.test(username)) return null
  const household = typeof householdId === 'string' && /^[a-z0-9-]{3,40}$/.test(householdId)
    ? householdId : 'legacy'
  return 'family-calendar.profile.v1.' + encodeURIComponent(household) + '.' +
    encodeURIComponent(username.toLowerCase())
}

export function parseProfileSelection(raw) {
  if (raw === HOME_SELECTION) return { kind: 'home' }
  if (typeof raw !== 'string' || !/^person:[1-9][0-9]*$/.test(raw)) return null
  const id = Number(raw.slice(7))
  return Number.isSafeInteger(id) && id > 0 ? { kind: 'person', personId: id } : null
}

export function serializeProfileSelection(selection) {
  if (selection?.kind === 'home') return HOME_SELECTION
  if (selection?.kind === 'person' &&
    Number.isSafeInteger(selection.personId) && selection.personId > 0) {
    return 'person:' + selection.personId
  }
  return null
}

export function resolveProfileSelection(raw, people, defaultHome = false) {
  if (raw === null && defaultHome) return { kind: 'home' }
  const selection = parseProfileSelection(raw)
  if (!selection) return null
  if (selection.kind === 'home') return selection
  if (!Array.isArray(people) ||
    !people.some(person => person?.id === selection.personId)) return null
  return selection
}
