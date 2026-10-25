// Read-only audit. Does NOT fetch, merge, edit a database, copy assets, or deploy.
// CI must fetch the approved LIVE commit into FETCH_HEAD before running it.
// Audit output is advisory: a clean file presence report is NOT deployment approval.
import { spawnSync } from 'node:child_process'

const EXPECTED_LIVE = '742addbde25255ce3e79f1cce9fc9276c1efb567'
const liveOnlyFilesToPreserve = [
  'Server/list-features.mjs',
  'Server/list-icons.mjs',
  'Server/smart-stores.mjs',
  'Server/list-features.d.mts',
  'src/ListIcons.tsx',
  'src/duplicateEvent.mjs',
  'src/duplicateEvent.d.mts',
  'scripts/test-list-features.mjs',
  'scripts/test-list-icons.mjs',
  'scripts/test-shopping-stores.mjs',
  'scripts/test-duplicate-event.mjs',
]
const overlappingCriticalFiles = [
  'Server/index.mjs',
  'Server/family-auth.mjs',
  'src/App.tsx',
  'src/App.css',
  'Server/auth-ui/account.html',
  'Server/auth-ui/account.js',
  'Server/auth-ui/login.html',
  'Server/auth-ui/login.js',
  'Server/auth-ui/styles.css',
  'scripts/test-family-auth.mjs',
  '.github/workflows/build.yml',
  '.github/workflows/deployment-safety.yml',
  'package-lock.json',
]
const householdFiles = [
  'Server/private-household-gateway.mjs',
  'Server/household-memberships.mjs',
  'Server/household-member-invitations.mjs',
  'src/HouseholdMembersSettings.tsx',
  'scripts/test-household-browser-demo.mjs',
]

function git(args, allowFailure = false) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 5 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) {
    throw new Error('Git inspection failed: ' + args[0])
  }
  return result
}

function fileObject(ref, file) {
  const result = git(['rev-parse', '--verify', ref + ':' + file], true)
  return result.status === 0 ? result.stdout.trim() : null
}

function inspect() {
  const fetched = git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).stdout.trim()
  if (fetched !== EXPECTED_LIVE) {
    throw new Error('LIVE baseline changed; review and update the pinned baseline first.')
  }
  git(['rev-parse', '--verify', 'HEAD^{commit}'])

  const missingLiveFiles = liveOnlyFilesToPreserve.filter(file => {
    const live = fileObject('FETCH_HEAD', file)
    if (!live) throw new Error('Pinned LIVE baseline is missing ' + file)
    return !fileObject('HEAD', file)
  })
  const criticalDifferences = overlappingCriticalFiles.flatMap(file => {
    const production = fileObject('FETCH_HEAD', file)
    const household = fileObject('HEAD', file)
    if (production === household) return []
    return [{
      file,
      change: !household ? 'missing in household' :
        !production ? 'household-only' : 'different content',
    }]
  })
  const missingHouseholdFiles = householdFiles.filter(file => !fileObject('HEAD', file))
  return { missingLiveFiles, criticalDifferences, missingHouseholdFiles }
}

function printReport(report) {
  console.log('=== READ-ONLY HOUSEHOLD / LIVE COMPATIBILITY AUDIT ===')
  console.log('Pinned LIVE baseline: ' + EXPECTED_LIVE)
  console.log('Missing LIVE functionality files: ' + report.missingLiveFiles.length)
  for (const file of report.missingLiveFiles) console.log('  PRESERVE: ' + file)
  console.log('Overlapping critical files needing reconciliation: ' +
    report.criticalDifferences.length)
  for (const item of report.criticalDifferences) {
    console.log('  REVIEW: ' + item.file + ' (' + item.change + ')')
  }
  console.log('Missing household foundation files: ' + report.missingHouseholdFiles.length)
  for (const file of report.missingHouseholdFiles) console.log('  MISSING: ' + file)
  console.log('Existing LIVE and TEST are untouched; no merge or deployment occurred.')
  if (report.missingLiveFiles.length || report.criticalDifferences.length ||
    report.missingHouseholdFiles.length) {
    console.log('RESULT: RECONCILIATION REQUIRED. DO NOT DEPLOY THIS BRANCH.')
  } else {
    console.log('RESULT: No known file-level drift. This is NOT a release approval.')
  }
}

// A missing baseline LIVE feature or household foundation file is a hard
// regression. Overlapping files legitimately differ in the integrated draft;
// those differences remain visible in the report but require human review.
function preservedFeaturesMissing(report) {
  return report.missingLiveFiles.length > 0 || report.missingHouseholdFiles.length > 0
}

function selfTest() {
  const common = {
    missingLiveFiles: [],
    criticalDifferences: [{ file: 'Server/index.mjs', change: 'different content' }],
    missingHouseholdFiles: [],
  }
  // Changed integrated backend files are expected, not grounds for a false
  // deployment approval or a CI failure on their own.
  if (preservedFeaturesMissing(common) ||
      !preservedFeaturesMissing({ ...common, missingLiveFiles: ['src/ListIcons.tsx'] }) ||
      !preservedFeaturesMissing({ ...common, missingHouseholdFiles: ['Server/private-household-gateway.mjs'] })) {
    throw new Error('Feature-preservation gate fixture failed.')
  }
  console.log('Read-only LIVE feature-preservation gate fixtures passed.')
}

const mode = process.argv[2] ?? '--audit'
if (mode === '--self-test') {
  selfTest()
} else if (['--audit', '--require-preserved-features', '--require-reconciled-files'].includes(mode)) {
  const report = inspect()
  printReport(report)
  // In draft CI, fail for missing features but keep legitimate integrated
  // code differences advisory until separate semantic review is complete.
  if (mode === '--require-preserved-features' && preservedFeaturesMissing(report)) {
    console.error('FAIL: LIVE or household feature files are missing from the isolated candidate.')
    process.exitCode = 1
  }
  // The all-file exact-match gate is an explicit manual inspection option.
  // Even a clean result never constitutes a production deployment approval.
  if (mode === '--require-reconciled-files' &&
    (preservedFeaturesMissing(report) || report.criticalDifferences.length)) {
    process.exitCode = 1
  }
} else {
  throw new Error('Use --audit, --require-preserved-features, --require-reconciled-files, or --self-test.')
}
