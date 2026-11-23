// Read-only, sanitized structural evidence against a PINNED, VERIFIED
// archived TEST recovery snapshot. No raw trigger SQL, row values, tokens,
// event details, user identifiers, or upload paths are printed.
import path from 'node:path'
import {inspectPrivatePhase1ArchivedTriggerLinks}
  from '../Server/private-phase1-archive-trigger-link-evidence.mjs'
try {
  if(process.argv.length!==4||typeof process.argv[2]!=='string'||
     !path.isAbsolute(process.argv[2])||!/^[a-f0-9]{40}$/.test(process.argv[3])) {
    throw new Error('pinned archive required')
  }
  const snapshotRoot=path.resolve(process.argv[2])
  const result=inspectPrivatePhase1ArchivedTriggerLinks({
    recoveryParent:path.dirname(snapshotRoot),
    snapshotRoot,expectedInstalledTestSha:process.argv[3],
  })
  if(result.testDeploymentAuthorized!==false||result.realMigrationExecuted!==false||
     result.originalArchiveModified!==false)throw new Error('unexpected permission')
  process.stdout.write(JSON.stringify(result,null,2)+'\n')
} catch {
  process.stderr.write(
    'Phase 1 archived trigger/link review REFUSED; existing archive and calendars unchanged.\n'
  )
  process.exitCode=2
}
