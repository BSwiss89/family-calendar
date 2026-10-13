// Synthetic tests only. Never touches configured production laptop paths.
import { assertCalendarReleaseBootSafe } from './dependency-release-boot-guard.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-boot-guard-fixture-'))
const app = path.join(root, 'simulated-live')
const unrelated = path.join(root, 'simulated-test')
const journal = path.join(root, 'DEPENDENCY-RELEASE-IN-PROGRESS.json')
function assert(value, label) { if (!value) throw new Error(label) }
function expectBlocked(label) {
  let blocked = false
  try { assertCalendarReleaseBootSafe(app, { liveRoot: app, journal }) } catch (error) {
    blocked = /startup blocked/i.test(error.message)
  }
  assert(blocked, 'boot guard bypassed: ' + label)
  console.log('[PASS] Refused production backend startup with ' + label)
}

try {
  fs.mkdirSync(app)
  fs.mkdirSync(unrelated)
  assert(assertCalendarReleaseBootSafe(app, { liveRoot: app, journal }) === 'production-clear',
    'clear production startup should be permitted')
  console.log('[PASS] Clear production startup allowed.')
  fs.writeFileSync(journal, '', { flag: 'wx' })
  expectBlocked('empty journal')
  fs.writeFileSync(journal, '{ invalid JSON')
  expectBlocked('corrupt journal')
  fs.writeFileSync(journal, JSON.stringify({ Phase: 'HealthVerified' }))
  expectBlocked('present journal even if its phase claims success')
  assert(assertCalendarReleaseBootSafe(unrelated, { liveRoot: app, journal }) === 'isolated-server',
    'test/preview server unexpectedly blocked')
  console.log('[PASS] Separate TEST and temporary backend processes remain allowed.')
  fs.rmSync(journal)
  assert(assertCalendarReleaseBootSafe(app, { liveRoot: app, journal }) === 'production-clear',
    'live backend blocked after verified manual file removal')
  console.log('[PASS] Production restart permitted only after journal absence.')
  console.log('DEPENDENCY RELEASE BOOT GUARD SAFETY FIXTURES PASSED')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
