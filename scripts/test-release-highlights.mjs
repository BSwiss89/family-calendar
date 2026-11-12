import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CURRENT_RELEASE,
  acknowledgeRelease,
  isReleaseAcknowledged,
  releaseAcknowledgementKey,
} from '../src/releaseHighlights.mjs'

function store() {
  const map = new Map()
  return {
    getItem(key) { return map.get(key) ?? null },
    setItem(key, value) { map.set(key, value) },
    count() { return map.size },
  }
}

test('release highlights are concise and change only with a curated release ID', () => {
  assert.match(CURRENT_RELEASE.id, /^\d{4}-\d{2}-/)
  assert.equal(CURRENT_RELEASE.highlights.length, 3)
  for (const item of CURRENT_RELEASE.highlights) {
    assert.ok(typeof item === 'string' && item.length >= 12 && item.length < 130)
  }
})

test('one acknowledgement per person, household/account and release on each browser', () => {
  const browser = store()
  const a = 'family-calendar.profile.v1.legacy.familyadmin'
  const b = 'family-calendar.profile.v1.other-household.familyadmin'
  const k1 = releaseAcknowledgementKey(a, 1)
  const k2 = releaseAcknowledgementKey(a, 2)
  const k3 = releaseAcknowledgementKey(b, 1)
  const next = releaseAcknowledgementKey(a, 1, '2026-12-future-update')
  assert.ok(k1 && k2 && k3 && next)
  assert.equal(new Set([k1, k2, k3, next]).size, 4)
  assert.equal(isReleaseAcknowledged(browser, k1), false)
  assert.equal(acknowledgeRelease(browser, k1), true)
  assert.equal(isReleaseAcknowledged(browser, k1), true)
  assert.equal(isReleaseAcknowledged(browser, k2), false)
  assert.equal(isReleaseAcknowledged(browser, k3), false)
  assert.equal(isReleaseAcknowledged(browser, next), false)
  assert.equal(browser.count(), 1)
})

test('Home/wall and unverified accounts get no announcement', () => {
  const account = 'family-calendar.profile.v1.legacy.familyadmin'
  assert.equal(releaseAcknowledgementKey(account, null), null)
  assert.equal(releaseAcknowledgementKey(account, 0), null)
  assert.equal(releaseAcknowledgementKey(account, -1), null)
  assert.equal(releaseAcknowledgementKey(null, 1), null)
  assert.equal(releaseAcknowledgementKey('not-an-auth-account', 1), null)
  assert.equal(releaseAcknowledgementKey(account, 1, '../unsafe'), null)
})

test('blocked browser storage does not crash the calendar', () => {
  const blocked = { getItem() { throw Error('blocked') }, setItem() { throw Error('blocked') } }
  const key = releaseAcknowledgementKey('family-calendar.profile.v1.legacy.familyadmin', 1)
  assert.equal(isReleaseAcknowledged(blocked, key), false)
  assert.equal(acknowledgeRelease(blocked, key), false)
})
