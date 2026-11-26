// Explicit local offline archive boot rehearsal. No password argument or
// environment variable, no installed task, public route or persistent output.
import os from 'node:os'
import path from 'node:path'
import {verifyOfflineLegacyTestSnapshot} from '../Server/private-phase1-legacy-snapshot-verification.mjs'
import {readHiddenOwnerPassword} from './private-phase1-local-owner-password-proof.mjs'
import {rehearseOfflineCoordinatedPrimaryBoot} from './private-phase1-offline-household-copy-rehearsal.mjs'
let password
try{
 const [name,sha]=process.argv.slice(2)
 if(process.argv.length!==4||!/^OFFLINE-LEGACY-TEST-\d{8}-\d{6}-[a-f0-9]{32}$/.test(name??'')||!/^[a-f0-9]{40}$/.test(sha??'')||
    !process.stdin.isTTY||!process.stdout.isTTY||
    Object.entries(process.env).some(([k,v])=>/^(NODE_USE_ENV_PROXY|NODE_OPTIONS|NODE_PATH|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$/i.test(k)&&v))throw Error('Refused')
 const recoveryParent=path.join(os.homedir(),'Projects','family-calendar-phase1-recovery')
 const args={recoveryParent,snapshotRoot:path.join(recoveryParent,name),expectedInstalledTestSha:sha}
 verifyOfflineLegacyTestSnapshot(args)
 password=await readHiddenOwnerPassword(process.stdin,process.stdout)
 const result=await rehearseOfflineCoordinatedPrimaryBoot(args,password)
 if(!result.ownerLoginVerified||!result.allChildrenExited||!result.temporaryCopyRemoved||
    !result.archiveUnchanged||result.testDeploymentAuthorized||result.liveDeploymentAuthorized)throw Error('Refused')
 console.log(JSON.stringify({result:'PASS',...result},null,2))
}catch{
 // Do not expose private rows, usernames, tokens, raw exceptions or paths.
 console.error('OFFLINE_ARCHIVE_BOOT_REHEARSAL=REFUSED | DEPLOYMENT_AUTHORIZED=NO | LOCAL_TEMP_RECOVERY_REVIEW_MAY_BE_REQUIRED=YES')
 process.exitCode=1
}finally{password=undefined}
