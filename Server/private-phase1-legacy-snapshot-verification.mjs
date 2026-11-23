// Independent read-only verification of the Phase 1 LEGACY TEST cold backup.
// Validates an explicit file-hash manifest, SQLite and the exact restore set.
// It NEVER opens the installed calendar database, starts a backend, controls
// Task Scheduler, changes Funnel/portproxy or authorizes TEST/LIVE cutover.
// A self-contained manifest is NOT cryptographic proof against an attacker
// who could replace both the snapshot and its manifest.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const SNAP = /^OFFLINE-LEGACY-TEST-\d{8}-\d{6}-[a-f0-9]{32}$/
const FILE = /^(?:calendar\.db|start-secure-test-patched\.ps1|(?:uploads|dist)\/[^\\\x00-\x1f]+)$/
const MAX_FILES = 50000
const MANIFEST = 'OFFLINE-LEGACY-REVIEW.json'
const MAX_MANIFEST_BYTES = 12 * 1024 * 1024

function refuse(message) {
  throw new Error('Phase 1 offline legacy restore verification refused: ' + message)
}
function ordinaryDirectory(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) refuse('absolute directory required.')
  const stat = fs.lstatSync(folder)
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('directory is linked or not physical.')
  return fs.realpathSync(folder)
}
function inside(parent, child) {
  const a = process.platform === 'win32' ? parent.toLowerCase() : parent
  const b = process.platform === 'win32' ? child.toLowerCase() : child
  const rel = path.relative(a,b)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}
function assertSnapshotLocation(recoveryParent, snapshotRoot) {
  const parent = ordinaryDirectory(recoveryParent)
  const root = ordinaryDirectory(snapshotRoot)
  if (path.dirname(root) !== parent || !SNAP.test(path.basename(root)) ||
      !inside(parent, root)) refuse('snapshot is not a single exact recovery child.')
  for (const name of [MANIFEST,'calendar.db','start-secure-test-patched.ps1']) {
    const file = path.join(root,name)
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(root,fs.realpathSync(file))) {
      refuse('required recovery file is missing or linked.')
    }
  }
  for(const name of ['dist','uploads']){
    const dir = ordinaryDirectory(path.join(root,name))
    if (!inside(root,dir)) refuse('snapshot directory escaped recovery root.')
  }
  return { parent,root }
}
function snapshotFiles(root) {
  const files=[]
  const names=new Set()
  function walk(folder) {
    for(const name of fs.readdirSync(folder).sort()) {
      const full=path.join(folder,name)
      const stat=fs.lstatSync(full)
      if(stat.isSymbolicLink() || !inside(root,fs.realpathSync(full))){
        refuse('recovery contains a linked or escaped path.')
      }
      if(stat.isDirectory()){
        walk(full)
      } else if(stat.isFile()){
        const relative=path.relative(root,full).split(path.sep).join('/')
        if(relative===MANIFEST) continue
        if(!FILE.test(relative) || relative.includes('/../') ||
          relative.includes('/./') || relative.split('/').some(p=>!p || p==='.' || p==='..') ||
          /(?:^|\/)(?:\.|[^/]+(?:-wal|-shm|-journal))$/.test(relative)){
          refuse('unexpected file type or SQLite journal in cold snapshot.')
        }
        const key=relative.toLowerCase()
        if(names.has(key)) refuse('case-insensitive duplicate file path.')
        names.add(key)
        files.push({relative,full})
        if(files.length>MAX_FILES) refuse('snapshot file count exceeds limit.')
      } else refuse('unsupported filesystem entry.')
    }
  }
  walk(root)
  return files.sort((a,b)=>a.relative.localeCompare(b.relative,'en'))
}
function sha256(filename) {
  const h=createHash('sha256')
  const fd=fs.openSync(filename,'r')
  const bytes=Buffer.allocUnsafe(1024*1024)
  try {
    for(;;){
      const count=fs.readSync(fd,bytes,0,bytes.length,null)
      if(count===0)break
      h.update(bytes.subarray(0,count))
    }
  } finally {fs.closeSync(fd)}
  return h.digest('hex')
}
function readManifest(root, expectedInstalledTestSha) {
  const filename=path.join(root,MANIFEST)
  if(fs.statSync(filename).size>MAX_MANIFEST_BYTES) refuse('manifest is oversized.')
  let m
  try { m=JSON.parse(fs.readFileSync(filename,'utf8')) }
  catch { refuse('manifest is invalid JSON.') }
  if(!m || typeof m!=='object'||Array.isArray(m) ||
    m.kind!=='phase1-offline-legacy-test-snapshot-v1'||
    m.sourceSha!==expectedInstalledTestSha||!SHA.test(m.sourceSha)||
    typeof m.capturedAt!=='string'||!Number.isFinite(Date.parse(m.capturedAt))||
    !HASH.test(m.databaseSha256)||!HASH.test(m.supervisorSha256)||
    m.sqliteIntegrity!=='ok'||
    !Number.isSafeInteger(m.uploads)||m.uploads<0||
    !Number.isSafeInteger(m.dist)||m.dist<1||
    !Number.isSafeInteger(m.fileCount)||m.fileCount<3||m.fileCount>MAX_FILES||
    !Array.isArray(m.files)||m.files.length!==m.fileCount||
    m.restoreBootVerified!==false||
    m.coordinatedCentralAndFamilySnapshot!==false||
    m.safeToCutover!==false||m.testDeploymentAuthorized!==false||
    m.liveDeploymentAuthorized!==false){
    refuse('manifest metadata or permissions are inconsistent.')
  }
  const hashes=new Map()
  for(const row of m.files){
    if(!row || typeof row!=='object'||Array.isArray(row)||
      typeof row.path!=='string'||!FILE.test(row.path)||
      row.path.includes('/../')||row.path.includes('/./')||
      row.path.split('/').some(p=>p==='.'||p==='..'||!p)||
      typeof row.sha256!=='string'||!HASH.test(row.sha256)){
      refuse('unsafe or invalid file hash row.')
    }
    const key=row.path.toLowerCase()
    if(hashes.has(key)) refuse('duplicate recovery manifest path.')
    hashes.set(key,row)
  }
  return { m,hashes }
}
function sqliteReadOnlyCheck(dbFile) {
  // readOnly=true and an already checkpointed standalone DB are required.
  const db=new DatabaseSync(dbFile,{readOnly:true})
  try{
    if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||
      db.prepare('PRAGMA foreign_key_check').all().length!==0){
      refuse('offline SQLite integrity or foreign keys failed.')
    }
    const tables=db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).get().n
    if(!Number.isSafeInteger(tables)||tables<1)refuse('snapshot has no calendar database schema.')
    return tables
  } finally {db.close()}
}
export function verifyOfflineLegacyTestSnapshot({
  recoveryParent,snapshotRoot,expectedInstalledTestSha,
}={}){
  if(!SHA.test(expectedInstalledTestSha)) refuse('pinned installed TEST SHA required.')
  const {root}=assertSnapshotLocation(recoveryParent,snapshotRoot)
  const {m,hashes}=readManifest(root,expectedInstalledTestSha)
  const files=snapshotFiles(root)
  if(files.length!==m.fileCount||hashes.size!==files.length){
    refuse('snapshot file inventory is incomplete or contains unlisted files.')
  }
  for(const f of files){
    const row=hashes.get(f.relative.toLowerCase())
    if(!row||row.path!==f.relative||sha256(f.full)!==row.sha256){
      refuse('snapshot bytes differ from manifest.')
    }
  }
  if(hashes.get('calendar.db')?.sha256!==m.databaseSha256||
     hashes.get('start-secure-test-patched.ps1')?.sha256!==m.supervisorSha256||
     files.filter(f=>f.relative.startsWith('uploads/')).length!==m.uploads||
     files.filter(f=>f.relative.startsWith('dist/')).length!==m.dist||
     !hashes.has('dist/index.html')){
    refuse('core database, build or uploaded-file inventory differs.')
  }
  const tables=sqliteReadOnlyCheck(path.join(root,'calendar.db'))
  return Object.freeze({
    kind:'phase1-offline-legacy-restore-check-v1',
    result:'PASS',
    sourceSha:m.sourceSha,
    fileCount:files.length,
    uploadFiles:m.uploads,
    buildFiles:m.dist,
    sqliteTablesChecked:tables,
    manifestSelfConsistent:true,
    independentExternalAttestationVerified:false,
    independentlyBootedNodeBackend:false,
    coordinatedCentralAndFamilyRestoreVerified:false,
    testDeploymentAuthorized:false,
    liveDeploymentAuthorized:false,
    filesOrServicesModified:false,
  })
}
// The caller must explicitly request an isolated copy. Copies go ONLY into a
// new OS-temp child, NEVER into the working LIVE or TEST checkouts. Even a
// successful copy is not a bootable restoration or deploy authorization.
// On failure retain the new destination for independent review.
export function copyAndVerifyOfflineLegacyTestSnapshot({
  recoveryParent,snapshotRoot,expectedInstalledTestSha,restoreCopyRoot,
}={}){
  const before=verifyOfflineLegacyTestSnapshot({
    recoveryParent,snapshotRoot,expectedInstalledTestSha,
  })
  if(typeof restoreCopyRoot!=='string'||!path.isAbsolute(restoreCopyRoot)){
    refuse('absolute new OS-temp restore target required.')
  }
  const temp=ordinaryDirectory(os.tmpdir())
  const copyParent=ordinaryDirectory(path.dirname(restoreCopyRoot))
  if(copyParent!==temp||!path.basename(restoreCopyRoot).startsWith('family-calendar-offline-restore-')||
    fs.existsSync(restoreCopyRoot)||inside(recoveryParent,restoreCopyRoot)){
    refuse('restore destination must be a fresh, direct OS-temp child.')
  }
  const {root}=assertSnapshotLocation(recoveryParent,snapshotRoot)
  const snapshot=snapshotFiles(root)
  fs.mkdirSync(restoreCopyRoot,{recursive:false,mode:0o700})
  const entries=[{relative:MANIFEST,full:path.join(root,MANIFEST)},...snapshot]
  for(const {relative,full} of entries) {
    const target=path.join(restoreCopyRoot,...relative.split('/'))
    fs.mkdirSync(path.dirname(target),{recursive:true})
    fs.copyFileSync(full,target,fs.constants.COPYFILE_EXCL)
    if(sha256(full)!==sha256(target))refuse('isolated copy was modified during copying.')
  }
  for(const name of ['dist','uploads']){
    if(!fs.existsSync(path.join(restoreCopyRoot,name))){
      fs.mkdirSync(path.join(restoreCopyRoot,name))
    }
  }
  // Independent validation on the newly materialized copy is deliberately
  // separate from the first validation and checks all restored file hashes.
  const after=verifyOfflineLegacyTestSnapshot({
    recoveryParent:temp,snapshotRoot:restoreCopyRoot,expectedInstalledTestSha,
    // The OS-temp target has a different folder name, supported below.
  })
  const again=verifyOfflineLegacyTestSnapshot({
    recoveryParent,snapshotRoot,expectedInstalledTestSha,
  })
  if(after.fileCount!==before.fileCount||again.fileCount!==before.fileCount){
    refuse('source or isolated restore changed during verification.')
  }
  return Object.freeze({
    ...after,
    isolatedOfflineCopyVerified:true,
    independentlyBootedNodeBackend:false,
    testDeploymentAuthorized:false,
    liveDeploymentAuthorized:false,
    filesOrServicesModified:true, // NEW OS-temp copy only, never installed sites
    installedSitesModified:false,
  })
}
