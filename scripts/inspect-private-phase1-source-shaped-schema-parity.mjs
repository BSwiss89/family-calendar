// Owner-run read-only audit of the previously verified offline snapshot only.
import path from 'node:path'
import {inspectSourceShapedLegacyArchive} from './private-phase1-source-shaped-schema-parity.mjs'
try {
 if(process.argv.length!==4||!path.isAbsolute(process.argv[2])||! /^[a-f0-9]{40}$/.test(process.argv[3]))throw Error()
 const snapshotRoot=path.resolve(process.argv[2])
 const r=inspectSourceShapedLegacyArchive({recoveryParent:path.dirname(snapshotRoot),snapshotRoot,expectedInstalledTestSha:process.argv[3]})
 console.log('LEGACY_STRUCTURE_AUDIT=PASS | TABLES='+r.tables+' | STRUCTURAL_MATCHES='+r.structuralMatches+' | COLUMN_ORDER_MATCHES='+r.columnOrderMatches+' | EXACT_TABLE_DDL='+r.exactTableDdlMatches+' | EXACT_INDEX_DDL='+r.exactExplicitIndexDdlMatches)
 for(const d of r.details)if(d.differences.length)console.log('TABLE='+d.table+' | DIFFERENCES='+d.differences.join(','))
 console.log('ARCHIVE_UNCHANGED=YES | RUNNING_CALENDARS_ACCESSED=NO | MIGRATION_AUTHORIZED=NO')
} catch {
 console.error('LEGACY_STRUCTURE_AUDIT=REFUSED')
 process.exitCode=2
}
