// Local rehearsal of a verified, cold legacy TEST backup. No installed
// calendar is opened; no listener, activation, persistent output or deploy.
import os from 'node:os'
import path from 'node:path'
import {rehearseOfflineCoordinatedPrimaryFamily} from './private-phase1-offline-household-copy-rehearsal.mjs'
try{
 const [name,sha]=process.argv.slice(2)
 if(process.argv.length!==4||!/^OFFLINE-LEGACY-TEST-\d{8}-\d{6}-[a-f0-9]{32}$/.test(name??'')||! /^[a-f0-9]{40}$/.test(sha??''))throw Error('Invalid invocation')
 const recoveryParent=path.join(os.homedir(),'Projects','family-calendar-phase1-recovery')
 const result=rehearseOfflineCoordinatedPrimaryFamily({recoveryParent,snapshotRoot:path.join(recoveryParent,name),expectedInstalledTestSha:sha})
 if(!result.coordinatedArchiveCopyVerified||!result.temporaryCopyRemoved||!result.archiveUnchanged||
    result.actualTestMigrationExecuted||result.testDeploymentAuthorized||result.liveDeploymentAuthorized)throw Error('Invalid result')
 console.log(JSON.stringify({result:'PASS',...result},null,2))
}catch{
 console.error('OFFLINE_COORDINATED_ARCHIVE_REHEARSAL=REFUSED | DEPLOYMENT_AUTHORIZED=NO')
 process.exitCode=1
}
