import path from 'node:path'
import {rehearseOfflineHouseholdCopy} from './private-phase1-offline-household-copy-rehearsal.mjs'
try{
 if(process.argv.length!==5||process.argv[2]!=='--rehearse-offline-copy'||!path.isAbsolute(process.argv[3])||! /^[a-f0-9]{40}$/.test(process.argv[4]))throw Error()
 const snapshotRoot=path.resolve(process.argv[3])
 const r=rehearseOfflineHouseholdCopy({recoveryParent:path.dirname(snapshotRoot),snapshotRoot,expectedInstalledTestSha:process.argv[4]})
 if(!r.archiveUnchanged||!r.temporaryCopyRemoved)throw Error()
 console.log('OFFLINE_HOUSEHOLD_COPY_REHEARSAL=PASS | TABLES='+r.preservedTables+' | ROWS='+r.preservedRows+' | TRIGGERS='+r.currentTriggers+' | EXCLUDED_TABLES='+r.excludedTables+' | UPLOADS='+r.uploads+' | NOTICES='+r.notices+' | ACKNOWLEDGEMENTS='+r.acknowledgements)
 console.log('ARCHIVE_UNCHANGED=YES | TEMP_COPY_REMOVED=YES | IDENTITY_MIGRATION=NO | INSTALLED_CALENDARS_ACCESSED=NO | DEPLOYMENT_AUTHORIZED=NO')
}catch{
 console.error('OFFLINE_HOUSEHOLD_COPY_REHEARSAL=REFUSED | NO_DEPLOYMENT_AUTHORIZED')
 process.exitCode=2
}
