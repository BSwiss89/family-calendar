import path from 'node:path'
import {rehearseOfflineCentralOwner} from './private-phase1-offline-central-owner-rehearsal.mjs'
try{
 if(process.argv.length!==5||process.argv[2]!=='--rehearse-central-owner-in-memory'||!path.isAbsolute(process.argv[3])||! /^[a-f0-9]{40}$/.test(process.argv[4]))throw Error()
 const snapshotRoot=path.resolve(process.argv[3])
 const r=rehearseOfflineCentralOwner({recoveryParent:path.dirname(snapshotRoot),snapshotRoot,expectedInstalledTestSha:process.argv[4]})
 console.log('OFFLINE_CENTRAL_OWNER_REHEARSAL=PASS | DISABLED_OWNERS='+r.stagedDisabledOwners+' | DISABLED_HOUSEHOLDS='+r.stagedDisabledHouseholds+' | DISABLED_MEMBERSHIPS='+r.stagedDisabledMemberships+' | OLD_SESSIONS_NOT_IMPORTED='+r.archivedSessionsNotImported+' | CENTRAL_SESSIONS='+r.centralSessions+' | CENTRAL_SELECTIONS='+r.centralSelections)
 console.log('OWNER_ACCESS=DENIED | PASSWORD_OWNERSHIP_VERIFIED=NO | MEMORY_DATABASE_CLOSED=YES | PERSISTENT_IDENTITY_CREATED=NO | ARCHIVE_UNCHANGED=YES | DEPLOYMENT_AUTHORIZED=NO')
}catch{
 console.error('OFFLINE_CENTRAL_OWNER_REHEARSAL=REFUSED | NO_DEPLOYMENT_AUTHORIZED')
 process.exitCode=2
}
