// Production release denylist for unfinished multi-household preview modules.
// This gate covers known draft-only paths; it is NOT a full code security review.
// Run against the ENTIRE git diff from live HEAD to the tested main commit.
// No bypass flag: a later independent reviewed release must explicitly amend
// this policy before private-family features may be deployed.
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const PRIVATE_PREVIEW_PATHS = [
  /^Server\/(?:private-|household-)/i,
  /^Server\/(?:family-auth|event-only-shares|event-share-sync-journal|event-creator-audit)\.mjs$/i,
  /^Server\/auth-ui\//i,
  // Host-readiness tools must stay private until a separately approved cutover.
  /^scripts\/(?:assess-private-test-host-readiness\.mjs|inspect-private-test-host\.ps1)$/i,
  /^src\/(?:FamilyAccountEntry|FamilyEventSharing|InvitationCenter|SharedEventDetails|SharedEventsOverlay|useAuthenticatedCalendarIdentity|useInvitationInbox|useSharedEventFeed|sharedEventOverlay|eventSharingUiModel)(?:\.|$)/i,
  // The release-safety fixture itself is not a household-preview test.
  // Exempt only this exact file, not the other private test modules.
  /^scripts\/(?:run-household-|test-household-|test-private-(?!preview-release-scope\.mjs$)|test-family-auth\.mjs$|test-event-only-shares\.mjs$|test-event-sharing-|test-event-creator-audit\.mjs$|test-shared-event-)/i,
]

function canonicalFile(filename) {
  return typeof filename === 'string' && filename.length > 0 &&
    filename.length <= 500 &&
    /^(?:[A-Za-z0-9_.@ -]+\/)*[A-Za-z0-9_.@ -]+$/.test(filename) &&
    filename.split('/').every(segment =>
      segment !== '.' && segment !== '..' && !segment.startsWith('-'))
}

export function inspectPrivatePreviewReleaseFiles(files) {
  if (!Array.isArray(files)) throw new TypeError('Expected a trusted Git change-file list.')
  const invalid = []
  const draftOnly = []
  for (const filename of files) {
    if (!canonicalFile(filename)) {
      invalid.push(String(filename))
    } else if (PRIVATE_PREVIEW_PATHS.some(pattern => pattern.test(filename))) {
      draftOnly.push(filename)
    }
  }
  return { allowed: invalid.length === 0 && draftOnly.length === 0, invalid, draftOnly }
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const result = inspectPrivatePreviewReleaseFiles(process.argv.slice(2))
  if (!result.allowed) {
    console.error('PRIVATE MULTI-FAMILY PREVIEW RELEASE BLOCKED.')
    for (const file of result.invalid) console.error('Unsafe release path: ' + file)
    for (const file of result.draftOnly) console.error('Draft-only module: ' + file)
    console.error('Keep PR #46 unmerged until tenancy, migrations, backup and recovery are approved.')
    process.exitCode = 2
  } else {
    console.log('Private-preview release scope check passed (no draft-only paths).')
  }
}
