// Manually curated only for meaningful calendar releases. Never tie this ID
// to a deploy SHA: frequent TEST auto-deploys should not create popups.
// Update the ID and items together when shipping the NEXT feature release.
export const CURRENT_RELEASE = Object.freeze({
  id: '2026-11-home-notes-settings',
  title: "What's new in Family Calendar",
  intro: 'Here are a few things to check out:',
  highlights: Object.freeze([
    'Home card titles now sit closer to the top, with your saved box sizes unchanged.',
    'Settings has moved into the blue + Quick Add menu, beneath Event, List, Recipe, and Photo.',
    'Family Notes is now editable and shared. Text fits your box, and notes clear daily.',
  ]),
})

// Remember acknowledgement only in this browser, scoped to the authenticated
// household/account and chosen person. The shared Home/wall profile is skipped.
export function releaseAcknowledgementKey(accountKey, personId, releaseId = CURRENT_RELEASE.id) {
  if (typeof accountKey !== 'string' ||
      !/^family-calendar\.profile\.v1\.[a-z0-9%-]+\.[a-z0-9._%-]+$/.test(accountKey) ||
      !Number.isSafeInteger(personId) || personId <= 0 ||
      typeof releaseId !== 'string' || !/^[a-z0-9-]{6,80}$/.test(releaseId)) {
    return null
  }
  return 'family-calendar.release-notice.v1.' + accountKey + '.person-' + personId + '.' + releaseId
}

export function isReleaseAcknowledged(store, key) {
  if (!key) return true
  try { return store.getItem(key) === 'acknowledged' }
  catch { return false }
}

export function acknowledgeRelease(store, key) {
  if (!key) return false
  try {
    store.setItem(key, 'acknowledged')
    return true
  } catch { return false }
}
