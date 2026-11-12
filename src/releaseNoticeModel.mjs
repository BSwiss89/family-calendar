// Manually curated only for meaningful calendar releases. Never tie this ID
// to a deploy SHA: frequent TEST auto-deploys should not create popups.
// Update the ID and items together when shipping the NEXT feature release.
export const CURRENT_RELEASE = Object.freeze({
  id: '2026-11-home-weather-refresh',
  title: "What's new in Family Calendar",
  intro: 'Here are a few things to check out:',
  highlights: Object.freeze([
    'Weather now matches the conditions, including rain, snow, sleet, and nighttime skies.',
    'Make the Home weather card wider or taller to see larger icons and text.',
    'Try Customize Home to arrange and resize your dashboard cards.',
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
