// Archive-only, read-only Phase 1 table disposition CLI.
// Only prints schema names, counts, proposed dispositions, and unresolved
// review flags. Never outputs credentials, events, photo filenames or tokens.
import path from 'node:path'
import { inspectPrivatePhase1OfflineLegacyMigration }
  from '../Server/private-phase1-offline-legacy-migration-inventory.mjs'
import { reviewPrivatePhase1LegacyTableDispositions }
  from '../Server/private-phase1-legacy-table-disposition-review.mjs'
try {
  if(process.argv.length!==4||!path.isAbsolute(process.argv[2])||
     !/^[a-f0-9]{40}$/.test(process.argv[3])){
    throw new Error('exact archive path and source revision required')
  }
  const snapshotRoot=path.resolve(process.argv[2])
  const inventory=inspectPrivatePhase1OfflineLegacyMigration({
    recoveryParent:path.dirname(snapshotRoot),snapshotRoot,
    expectedInstalledTestSha:process.argv[3],
  })
  const proposal=reviewPrivatePhase1LegacyTableDispositions(inventory)
  process.stdout.write(JSON.stringify(proposal,null,2)+'\n')
} catch {
  // Never reveal paths, user content or credentials from an error object.
  process.stderr.write(
    'Phase 1 archived table disposition REFUSED; installed calendars and backup unchanged.\n'
  )
  process.exitCode=2
}
