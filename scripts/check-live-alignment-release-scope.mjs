// Read-only, fail-closed LIVE release-scope gate. Does not authorize deployment.
// Usage: node scripts/check-live-alignment-release-scope.mjs <base-sha> <candidate-sha>
// Supply full verified commit SHAs. This checks the complete base...candidate tree diff.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SHA = /^[a-f0-9]{40}$/
export const REVIEW_REQUIRED = [
  /^(?:Server\/(?:index|family-auth|private-[^/]+|household-[^/]+|independent-household-[^/]+)\.mjs)$/i,
  /^Server\/auth-ui\//i,
  /^Server\/(?:event-only-shares|event-share-sync-journal|notification-event-mutation-capture)\.mjs$/i,
  /^src\/(?:FamilyAccountEntry|FamilyEventSharing|Household|InvitationCenter|SharedEvent|useInvitationInbox|useSharedEventFeed)/i,
  /^src\/optionalFeatureFlags\./i,
  /^scripts\/(?:secure-test-|install-secure-test-|configure-secure-test-|deploy-secure-|audit-household-live-parity)/i,
  /^\.github\/workflows\//i,
]
export function classifyReleasePaths(files) {
  if (!Array.isArray(files) || !files.length) return { allowed: false, reason: 'empty or invalid diff', review: [] }
  const invalid = files.filter(f => typeof f !== 'string' || !f || f.length > 500 || f.includes('\\') || f.split('/').some(p => !p || p === '.' || p === '..'))
  const review = files.filter(f => REVIEW_REQUIRED.some(re => re.test(f)))
  return { allowed: invalid.length === 0 && review.length === 0, reason: invalid.length ? 'invalid paths' : review.length ? 'sensitive paths require separate approval' : 'no known sensitive paths', review, invalid }
}
function git(...args) { return execFileSync('git', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).trim() }
export function inspect(base, candidate) {
  if (!SHA.test(base) || !SHA.test(candidate) || base === candidate) throw new Error('Require distinct full 40-character commit SHAs')
  for (const sha of [base, candidate]) if (git('rev-parse', '--verify', sha + '^{commit}') !== sha) throw new Error('Unverified commit: ' + sha)
  if (git('merge-base', base, candidate) !== base) throw new Error('Candidate does not descend from exact LIVE base; review divergent history separately')
  const raw = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', base, candidate], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  const files = raw.toString('utf8').split('\0').filter(Boolean)
  return { ...classifyReleasePaths(files), files }
}
const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct) {
  try {
    const result = inspect(process.argv[2], process.argv[3])
    console.log(JSON.stringify(result, null, 2))
    if (!result.allowed) process.exitCode = 2
    else console.log('Scope screen passed; still requires full CI, review, owner approval and guarded LIVE preflight.')
  } catch (error) { console.error('LIVE release scope blocked: ' + error.message); process.exitCode = 2 }
}
