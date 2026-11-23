// Read-only cold TEST archive schema/relationship report.
// Logs ONLY reviewed SQL identifiers and structural metadata; never raw DDL,
// row contents, upload paths, accounts, device tokens or password hashes.
import path from 'node:path'
import { auditPrivatePhase1OfflineLegacySchema }
  from '../Server/private-phase1-offline-schema-relationship-audit.mjs'
try {
  if(process.argv.length!==4 ||
     typeof process.argv[2]!=='string'||!path.isAbsolute(process.argv[2])||
     !/^[a-f0-9]{40}$/.test(process.argv[3])) {
    throw new Error('exact archived recovery path and installed source SHA required')
  }
  const snapshotRoot=path.resolve(process.argv[2])
  const report=auditPrivatePhase1OfflineLegacySchema({
    recoveryParent:path.dirname(snapshotRoot),snapshotRoot,
    expectedInstalledTestSha:process.argv[3],
  })
  if(report.dataCopyAuthorized!==false||report.testDeploymentAuthorized!==false)
    throw new Error('audit may never authorize a data change')
  process.stdout.write(JSON.stringify(report,null,2)+'\n')
} catch {
  process.stderr.write('Phase 1 archived TEST schema audit REFUSED; source archive and running calendars untouched.\n')
  process.exitCode=2
}
