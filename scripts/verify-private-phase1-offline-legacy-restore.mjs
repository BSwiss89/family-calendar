// Offline Phase 1 LEGACY TEST restore inspection only; no backend is booted.
// Invoke from a separate, reviewed candidate checkout. Never points at LIVE,
// installed TEST, Task Scheduler, Funnel or portproxy.
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  verifyOfflineLegacyTestSnapshot,
  copyAndVerifyOfflineLegacyTestSnapshot,
} from '../Server/private-phase1-legacy-snapshot-verification.mjs'

const args=process.argv.slice(2)
const expectedFlags=new Set(['--snapshot-name','--expected-test-sha','--isolated-copy'])
const values=new Map()
try {
  for(let i=0;i<args.length;i++) {
    const key=args[i]
    if(!expectedFlags.has(key)||values.has(key))throw new Error('Unsupported or repeated argument.')
    if(key==='--isolated-copy'){values.set(key,true);continue}
    if(i+1>=args.length||args[i+1].startsWith('--'))throw new Error('Missing argument value.')
    values.set(key,args[++i])
  }
  const name=values.get('--snapshot-name')
  const sourceSha=values.get('--expected-test-sha')
  if(typeof name!=='string'||!/^OFFLINE-LEGACY-TEST-\d{8}-\d{6}-[a-f0-9]{32}$/.test(name)||
    typeof sourceSha!=='string'||!/^[a-f0-9]{40}$/.test(sourceSha)){
    throw new Error('Exact recovery snapshot NAME and installed TEST SHA required.')
  }
  // Fixed recovery location — no arbitrary user-supplied source path.
  const recoveryParent=path.join(os.homedir(),'Projects','family-calendar-phase1-recovery')
  const snapshotRoot=path.join(recoveryParent,name)
  const check=verifyOfflineLegacyTestSnapshot({
    recoveryParent,snapshotRoot,expectedInstalledTestSha:sourceSha,
  })
  let result=check
  let temporaryCopyPath=null
  if(values.has('--isolated-copy')){
    const timestamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,8)+'-'+
      new Date().toISOString().replace(/[-:]/g,'').slice(9,15)
    temporaryCopyPath=path.join(os.tmpdir(),
      'OFFLINE-LEGACY-TEST-'+timestamp+'-'+randomBytes(16).toString('hex'))
    result=copyAndVerifyOfflineLegacyTestSnapshot({
      recoveryParent,snapshotRoot,expectedInstalledTestSha:sourceSha,
      restoreCopyRoot:temporaryCopyPath,
    })
  }
  console.log(JSON.stringify({
    ...result,
    isolatedCopyPath:temporaryCopyPath,
    installedTestSha:sourceSha,
    installedCalendarTouched:false,
    originalRecoverySnapshotTouched:false,
    actualSiteBootTested:false,
    releaseApproved:false,
  },null,2))
} catch {
  // Avoid printing read-only file contents, source paths, credentials or
  // filesystem exception strings. A failed/partial temp copy is retained.
  console.error('Legacy TEST offline snapshot verification refused; installed sites unchanged.')
  process.exitCode=2
}
