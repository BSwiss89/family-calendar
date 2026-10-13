// Boot-time fail-closed protection for incomplete production npm transactions.
// Imported by the real backend BEFORE SQLite or upload directories are opened.
// The isolated test and preview servers are intentionally outside the live root.
import fs from 'node:fs'
import path from 'node:path'

const LIVE_ROOT = 'C:\\Users\\bobby\\Projects\\family-calendar'
const JOURNAL = 'C:\\Users\\bobby\\AppData\\Local\\FamilyCalendar\\auto-release\\DEPENDENCY-RELEASE-IN-PROGRESS.json'

export function assertCalendarReleaseBootSafe(appRoot, options = {}) {
  const liveRoot = options.liveRoot ?? LIVE_ROOT
  const journal = options.journal ?? JOURNAL
  if (!appRoot || !liveRoot || !journal) {
    throw new Error('Missing dependency release boot-guard configuration')
  }
  const normalize = value => path.resolve(value).replaceAll('/', '\\').toLowerCase()
  if (normalize(appRoot) !== normalize(liveRoot)) return 'isolated-server'
  // A partial, empty, or corrupt journal is also unsafe. Never parse and
  // "approve" a restart automatically based on a possibly stale phase.
  if (fs.existsSync(journal)) {
    throw new Error('Production calendar startup blocked: dependency release journal exists. ' +
      'Inspect interrupted npm deployment and restore files before manual clearance.')
  }
  return 'production-clear'
}
