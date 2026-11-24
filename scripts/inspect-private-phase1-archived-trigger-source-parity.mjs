// Read-only source-versus-archive notification trigger parity. No raw
// archived SQL/names, account or event data, or file paths are printed.
// Never authorizes trigger replay, login migration, backup or deployment.
import path from 'node:path'
import {inspectPrivatePhase1ArchivedTriggerSourceParity}
  from '../Server/private-phase1-archive-trigger-source-parity.mjs'
try {
 if(process.argv.length!==4||typeof process.argv[2]!=='string'||
    !path.isAbsolute(process.argv[2])||!/^[a-f0-9]{40}$/.test(process.argv[3])) {
  throw new Error('exact verified cold archive and source SHA required')
 }
 const snapshotRoot=path.resolve(process.argv[2])
 const result=inspectPrivatePhase1ArchivedTriggerSourceParity({
  recoveryParent:path.dirname(snapshotRoot),
  snapshotRoot,expectedInstalledTestSha:process.argv[3],
 })
 if(result.testDeploymentAuthorized!==false||
    result.dataMigrationAuthorized!==false||
    result.originalArchiveModified!==false||
    result.realMigrationExecuted!==false)throw new Error('unexpected permission')
 process.stdout.write(JSON.stringify(result,null,2)+'\n')
} catch {
 process.stderr.write(
  'Archived TEST trigger-source parity REFUSED; no calendars or archives changed.\n'
 )
 process.exitCode=2
}
