// CLI for read-only analysis of an already captured legacy TEST cold backup.
// No writes, process control, routing or deployment. The caller supplies
// the specific archive folder and its known installed source SHA.
import path from 'node:path'
import { inspectPrivatePhase1OfflineLegacyMigration } from '../Server/private-phase1-offline-legacy-migration-inventory.mjs'
try {
  if(process.argv.length!==4 || !path.isAbsolute(process.argv[2]) ||
      !/^[a-f0-9]{40}$/.test(process.argv[3])) {
    throw new Error('exact offline archive and source hash required')
  }
  const snapshotRoot=path.resolve(process.argv[2])
  const result=inspectPrivatePhase1OfflineLegacyMigration({
    recoveryParent:path.dirname(snapshotRoot),
    snapshotRoot, expectedInstalledTestSha:process.argv[3],
  })
  // Safe schema names and table counts only. No row content, credentials,
  // secrets, upload names/paths or real household identities are printed.
  process.stdout.write(JSON.stringify(result,null,2)+'\n')
} catch {
  process.stderr.write('Phase 1 offline legacy migration inspection REFUSED; calendar sites and archive unchanged.\n')
  process.exitCode=2
}
