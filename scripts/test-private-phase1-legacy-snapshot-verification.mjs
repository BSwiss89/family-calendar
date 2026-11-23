// All recovery fixtures are synthetic, in OS-temp. No real Windows task,
// installed LIVE/TEST checkout, user uploads or existing snapshot is accessed.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  verifyOfflineLegacyTestSnapshot as verify,
  copyAndVerifyOfflineLegacyTestSnapshot as copyVerify,
} from '../Server/private-phase1-legacy-snapshot-verification.mjs'

const sha='76caa3e46186c3c5c6408f11b55800eb06779776'
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const snapshotName=()=> 'OFFLINE-LEGACY-TEST-20261122-203000-'+randomBytes(16).toString('hex')

function build(t) {
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'fc-legacy-snapshot-check-'))
  t.after(()=>fs.rmSync(work,{recursive:true,force:true}))
  const recoveryParent=path.join(work,'family-calendar-phase1-recovery')
  const snapshotRoot=path.join(recoveryParent,snapshotName())
  fs.mkdirSync(path.join(snapshotRoot,'uploads','events'),{recursive:true})
  fs.mkdirSync(path.join(snapshotRoot,'dist'),{recursive:true})
  const dbFile=path.join(snapshotRoot,'calendar.db')
  const db=new DatabaseSync(dbFile)
  try{
    db.exec('CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT);'+
      'CREATE TABLE events(id INTEGER PRIMARY KEY,title TEXT);')
    db.prepare('INSERT INTO people(name) VALUES(?)').run('Synthetic Person')
    db.prepare('INSERT INTO events(title) VALUES(?)').run('Synthetic Calendar Event')
  }finally{db.close()}
  fs.writeFileSync(path.join(snapshotRoot,'uploads','events','photo.bin'),Buffer.from([0,12,200,7]))
  fs.writeFileSync(path.join(snapshotRoot,'dist','index.html'),'<html>disposable</html>')
  fs.writeFileSync(path.join(snapshotRoot,'start-secure-test-patched.ps1'),
    "# Synthetic, never executed\nWrite-Output 'synthetic fixture'\n")
  const rel=[
    'calendar.db','uploads/events/photo.bin','dist/index.html',
    'start-secure-test-patched.ps1',
  ]
  const files=rel.map(filename=>({
    path:filename,sha256:hash(path.join(snapshotRoot,...filename.split('/'))),
  }))
  const manifest={
    kind:'phase1-offline-legacy-test-snapshot-v1',
    sourceSha:sha,
    capturedAt:'2026-11-22T20:30:00-06:00',
    databaseSha256:files.find(f=>f.path==='calendar.db').sha256,
    supervisorSha256:files.find(f=>f.path==='start-secure-test-patched.ps1').sha256,
    uploads:1,dist:1,sqliteIntegrity:'ok',fileCount:files.length,files,
    restoreBootVerified:false,coordinatedCentralAndFamilySnapshot:false,
    safeToCutover:false,testDeploymentAuthorized:false,
    liveDeploymentAuthorized:false,
  }
  const manifestFile=path.join(snapshotRoot,'OFFLINE-LEGACY-REVIEW.json')
  function rewrite(){fs.writeFileSync(manifestFile,JSON.stringify(manifest))}
  rewrite()
  return {
    work,recoveryParent,snapshotRoot,expectedInstalledTestSha:sha,manifest,rewrite,
    dbFile,manifestFile,
  }
}
const args=x=>({
  recoveryParent:x.recoveryParent,
  snapshotRoot:x.snapshotRoot,
  expectedInstalledTestSha:x.expectedInstalledTestSha,
})

test('real SQLite and all saved file hashes pass without touching source',t=>{
  const f=build(t)
  const before=fs.readFileSync(f.manifestFile)
  const result=verify(args(f))
  assert.equal(result.result,'PASS')
  assert.equal(result.fileCount,4)
  assert.equal(result.uploadFiles,1)
  assert.equal(result.buildFiles,1)
  assert.equal(result.sqliteTablesChecked,2)
  for(const key of [
    'independentExternalAttestationVerified','independentlyBootedNodeBackend',
    'coordinatedCentralAndFamilyRestoreVerified','testDeploymentAuthorized',
    'liveDeploymentAuthorized','filesOrServicesModified',
  ]) assert.equal(result[key],false,key)
  assert(Object.isFrozen(result))
  assert.deepEqual(fs.readFileSync(f.manifestFile),before)
})
test('separate isolated OS-temp copy is independently rehashed and DB-checked',t=>{
  const f=build(t)
  const restoreCopyRoot=path.join(os.tmpdir(),snapshotName())
  t.after(()=>fs.rmSync(restoreCopyRoot,{recursive:true,force:true}))
  const result=copyVerify({...args(f),restoreCopyRoot})
  assert.equal(result.result,'PASS')
  assert.equal(result.isolatedOfflineCopyVerified,true)
  assert.equal(result.installedSitesModified,false)
  assert.equal(result.independentlyBootedNodeBackend,false)
  assert.equal(result.testDeploymentAuthorized,false)
  assert.equal(fs.existsSync(path.join(restoreCopyRoot,'calendar.db')),true)
  assert.equal(hash(f.dbFile),hash(path.join(restoreCopyRoot,'calendar.db')))
  assert.throws(()=>copyVerify({...args(f),restoreCopyRoot}),/fresh/)
})
test('upload loss, added sidecar or unexpected extra file refuses',t=>{
  const f=build(t)
  fs.rmSync(path.join(f.snapshotRoot,'uploads','events','photo.bin'))
  assert.throws(()=>verify(args(f)),/inventory|unlisted/)
  const g=build(t)
  fs.writeFileSync(path.join(g.snapshotRoot,'calendar.db-wal'),'fake wal')
  assert.throws(()=>verify(args(g)),/unexpected file/)
  const h=build(t)
  fs.writeFileSync(path.join(h.snapshotRoot,'uploads','unexpected.txt'),'extra')
  assert.throws(()=>verify(args(h)),/inventory|unlisted/)
})
test('altered file bytes and forged manifest permissions refuse',t=>{
  const f=build(t)
  fs.writeFileSync(path.join(f.snapshotRoot,'uploads','events','photo.bin'),'different')
  assert.throws(()=>verify(args(f)),/bytes differ/)
  const g=build(t)
  g.manifest.testDeploymentAuthorized=true
  g.rewrite()
  assert.throws(()=>verify(args(g)),/metadata or permissions/)
  const h=build(t)
  h.manifest.files.push({...h.manifest.files[0]})
  h.manifest.fileCount++
  h.rewrite()
  assert.throws(()=>verify(args(h)),/duplicate/)
})
test('incorrect source SHA, unsupported snapshot names and old unmanifested backup refuse',t=>{
  const f=build(t)
  assert.throws(()=>verify({...args(f),expectedInstalledTestSha:'f'.repeat(40)}),/metadata or permissions/)
  const g=build(t)
  fs.renameSync(g.snapshotRoot,path.join(g.recoveryParent,'TEST-20261122-163327-c8b184db'))
  g.snapshotRoot=path.join(g.recoveryParent,'TEST-20261122-163327-c8b184db')
  assert.throws(()=>verify(args(g)),/exact recovery child/)
  const h=build(t)
  fs.rmSync(h.manifestFile)
  assert.throws(()=>verify(args(h)),/ENOENT|missing/)
})
test('copy cannot target checkout, existing paths or arbitrary non-temp directories',t=>{
  const f=build(t)
  const destination=path.join(f.work,snapshotName())
  assert.throws(()=>copyVerify({...args(f),restoreCopyRoot:destination}),/OS-temp/)
  assert.equal(fs.existsSync(destination),false)
  const existing=path.join(os.tmpdir(),snapshotName())
  fs.mkdirSync(existing)
  t.after(()=>fs.rmSync(existing,{recursive:true,force:true}))
  assert.throws(()=>copyVerify({...args(f),restoreCopyRoot:existing}),/fresh/)
})
test('SQLite integrity failures are caught even with new matching file checksum',t=>{
  const f=build(t)
  // A simple payload can be hashed and have the manifest updated, but must
  // still fail the independent SQLite open/PRAGMA check.
  fs.writeFileSync(f.dbFile,Buffer.from('not a sqlite database'))
  const digest=hash(f.dbFile)
  f.manifest.databaseSha256=digest
  f.manifest.files.find(x=>x.path==='calendar.db').sha256=digest
  f.rewrite()
  assert.throws(()=>verify(args(f)),/database|SQLITE|SQLite|SQLITE_NOTADB/i)
})
