// One-time, LOCAL-ONLY boot rehearsal of an EXISTING legacy TEST snapshot.
// This runs a copied *exact installed* TEST application and copied database
// on an ephemeral 127.0.0.1 port, never a third public calendar or a release.
// It NEVER executes the recovered supervisor, stops/changes scheduled tasks,
// changes portproxy/Funnel, or runs Node against installed TEST/LIVE paths.
// The new temp backend is always stopped; its temp files are then removed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const INSTALLED_SHA='76caa3e46186c3c5c6408f11b55800eb06779776'
const SNAPSHOT='TEST-20261122-163327-c8b184db'
const NODE='C:\\ProgramData\\FamilyCalendar\\Runtime\\node-v24.22.1\\node.exe'
const DIR='fc-phase1-legacy-boot-'
let reviewStep='preflight'
const BLOCKED=new Set([443,8443,3001,11434,13001,13002,13003,13004,13005,13006])
function refuse(message){throw new Error(message)}
function expectedPath(base){return path.join(os.homedir(),'Projects',base)}
function physicalDir(location){
  const entry=fs.lstatSync(location)
  if(!entry.isDirectory()||entry.isSymbolicLink())refuse('Missing or linked protected directory.')
  return fs.realpathSync(location)
}
function physicalFile(location){
  const entry=fs.lstatSync(location)
  if(!entry.isFile()||entry.isSymbolicLink())refuse('Missing or linked protected file.')
  return fs.realpathSync(location)
}
function same(a,b){
  const norm=x=>path.resolve(x).replaceAll('/','\\').toLowerCase()
  return norm(a)===norm(b)
}
function hash(location){
  const sum=createHash('sha256')
  const data=Buffer.allocUnsafe(1024*1024)
  const fd=fs.openSync(location,'r')
  try {
    for(;;){
      const n=fs.readSync(fd,data,0,data.length,null)
      if(n===0)break
      sum.update(data.subarray(0,n))
    }
  }finally{fs.closeSync(fd)}
  return sum.digest('hex')
}
function exactFiles(root){
  const files=[]
  const rootNames=fs.readdirSync(root).sort()
  const expected=['calendar.db','dist','start-secure-test-patched.ps1','uploads']
  if(JSON.stringify(rootNames)!==JSON.stringify(expected)){
    refuse('Current TEST recovery snapshot has unexpected root entries.')
  }
  function visit(dir){
    for(const item of fs.readdirSync(dir)){
      const full=path.join(dir,item)
      const entry=fs.lstatSync(full)
      if(entry.isSymbolicLink())refuse('Recovery snapshot includes a link.')
      if(entry.isDirectory())visit(full)
      else if(entry.isFile()){
        files.push({relative:path.relative(root,full),full,sha256:hash(full)})
        if(files.length>50000)refuse('Recovery file count exceeded.')
      }else refuse('Unexpected recovery file type.')
    }
  }
  visit(root)
  const db=files.filter(x=>x.relative==='calendar.db')
  if(db.length!==1||files.length!==34||!files.some(x=>x.relative===path.join('dist','index.html'))){
    refuse('Saved recovery file inventory differs from the 34-file receipt.')
  }
  if(files.some(x=>/-(?:wal|shm|journal)$/.test(x.relative.toLowerCase()))){
    refuse('Uncheckpointed SQLite journal in saved snapshot.')
  }
  return files
}
// This is a temporary TEST replacement during an approved maintenance
// window, never a THIRD concurrently running family calendar. The existing
// Secure TEST and updater must already be disabled/stopped by an independently
// authorized operator. This procedure NEVER changes them itself.
function requireTestMaintenanceFence(){
  const probe=String.raw`$ErrorActionPreference='Stop';$t=Get-ScheduledTask -TaskName 'Family Calendar Secure TEST' -ErrorAction Stop;$u=Get-ScheduledTask -TaskName 'Family Calendar Secure TEST Auto Deploy' -ErrorAction Stop;$l=Get-ScheduledTask -TaskName 'Family Calendar Server' -ErrorAction Stop;if($t.State -cne 'Disabled' -or $u.State -cne 'Disabled' -or $l.State -cne 'Running'){exit 41};$listen=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -in @(13002,13004,13005,13006)});if($listen.Count){exit 42};$nodes=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop);foreach($p in $nodes){if([string]::IsNullOrWhiteSpace([string]$p.CommandLine)){exit 43};if($p.CommandLine -like '*family-calendar-test-security-stage*'){exit 44}};$i=Get-ScheduledTaskInfo -TaskName 'Family Calendar Monthly Restart' -ErrorAction Stop;if($i.NextRunTime -le (Get-Date).AddMinutes(30)){exit 45};exit 0`
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',probe],{
    windowsHide:true,encoding:'utf8',timeout:20000,
  })
  if(result.error||result.status!==0){
    refuse('Legacy TEST maintenance fence is not independently verified.')
  }
}
function countPhysicalDeps(folder){
  let files=0
  const dirs=[folder]
  while(dirs.length){
    const current=dirs.pop()
    for(const name of fs.readdirSync(current)){
      if(name==='.bin'&&current===folder)continue
      const target=path.join(current,name)
      const entry=fs.lstatSync(target)
      if(entry.isSymbolicLink())refuse('Unreviewed dependency link requires inspection.')
      if(entry.isDirectory())dirs.push(target)
      else if(entry.isFile())files++
      else refuse('Unexpected runtime dependency file type.')
      if(files>150000||dirs.length>150000)refuse('Dependency inventory is unexpectedly large.')
    }
  }
  if(files<5)refuse('Missing runtime dependency files.')
  return files
}
function git(args){
  const r=spawnSync('git',args,{
    windowsHide:true,encoding:'utf8',timeout:120000,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never',GIT_OPTIONAL_LOCKS:'0'},
  })
  if(r.error||r.status!==0)refuse('Local Git source verification/copy failed.')
  return r.stdout.trim()
}
function copyTree(source,dest){
  if(fs.existsSync(dest))refuse('Isolated destination unexpectedly already exists.')
  fs.cpSync(source,dest,{recursive:true,errorOnExist:true,force:false,
    filter:filename=>{
      const st=fs.lstatSync(filename)
      if(st.isSymbolicLink())refuse('Unreviewed package or backup file link.')
      if(path.basename(filename)==='.bin'&&filename.includes('node_modules'))return false
      if(!st.isFile()&&!st.isDirectory())refuse('Unexpected dependency file type.')
      return true
    },
  })
}
function verifyDatabase(dbFile){
  const db=new DatabaseSync(dbFile,{readOnly:true})
  try {
    if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok'||
      db.prepare('PRAGMA foreign_key_check').all().length!==0){
      refuse('Restored SQLite integrity or foreign keys failed.')
    }
    const account=db.prepare('SELECT COUNT(*) AS n FROM family_users').get().n
    const sessions=db.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n
    if(account!==1||sessions!==21)refuse('Restored account/session counts differ from saved evidence.')
    return {account,sessions}
  }finally{db.close()}
}
function choosePort(){
  return new Promise((resolve,reject)=>{
    const server=net.createServer()
    server.once('error',reject)
    server.listen({host:'127.0.0.1',port:0,exclusive:true},()=>{
      const p=server.address().port
      server.close(err=>err?reject(err):BLOCKED.has(p)?reject(new Error('Protected port chosen.')):resolve(p))
    })
  })
}
function get(pathname,port){
  return new Promise((resolve,reject)=>{
    const req=http.get({host:'127.0.0.1',port,path:pathname,timeout:2000,
      agent:false},res=>{
      let received=''
      res.setEncoding('utf8')
      res.on('data',chunk=>{
        received+=chunk
        if(received.length>4096)req.destroy(new Error('Unexpected large response.'))
      })
      res.on('end',()=>resolve({status:res.statusCode,body:received}))
      res.on('error',reject)
    })
    req.once('error',reject)
    req.once('timeout',()=>req.destroy(new Error('Loopback request timed out.')))
  })
}
async function checkBoot(port,child,hasSpawnError){
  const deadline=Date.now()+20000
  let health
  while(Date.now()<deadline){
    if(hasSpawnError()||child.exitCode!==null)refuse('Isolated restored Node exited before health checks.')
    try{
      health=await get('/api/health',port)
      if(health.status===200)break
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,300))
  }
  if(health?.status!==200)refuse('Isolated restored calendar never became healthy.')
  const auth=await get('/api/auth/status',port)
  let status
  try{status=JSON.parse(auth.body)}catch{refuse('Restored authentication status is invalid.')}
  if(auth.status!==200||status.enabled!==true||status.authenticated!==false){
    refuse('Recovered backend did not enforce family authentication.')
  }
  for(const resource of ['/api/events','/api/people','/api/lists']){
    const result=await get(resource,port)
    if(result.status!==401)refuse('Restored backend exposed anonymous calendar data.')
  }
}
async function shutDown(child){
  if(!child||!child.pid)return true
  if(child.exitCode!==null||child.signalCode!==null)return true
  const close=new Promise(resolve=>{
    if(child.exitCode!==null||child.signalCode!==null)return resolve(true)
    const timer=setTimeout(()=>{child.off('close',onClose);resolve(false)},10000)
    function onClose(){clearTimeout(timer);resolve(true)}
    child.once('close',onClose)
  })
  child.kill()
  return await close
}
async function main(){
  // Exact fixed historical backup only. A newer snapshot requires a new
  // reviewed revision; no untrusted arbitrary paths or target ports.
  const mode=process.argv.length===3&&process.argv[2]==='--preflight'
    ? 'preflight'
    : process.argv.length===3&&process.argv[2]==='--boot'
      ? 'boot'
      : null
  if(mode===null)refuse('Use explicit --preflight or --boot, never arbitrary arguments.')
  if(process.platform!=='win32')refuse('Windows TEST restore rehearsal only.')
  const installed=physicalDir(expectedPath('family-calendar-test-security-stage'))
  const recovery=physicalDir(expectedPath('family-calendar-phase1-recovery'))
  const backup=physicalDir(path.join(recovery,SNAPSHOT))
  const originalDb=physicalFile(path.join(backup,'calendar.db'))
  const nodeBinary=physicalFile(NODE)
  const deps=physicalDir(path.join(installed,'node_modules'))
  if(!same(installed,expectedPath('family-calendar-test-security-stage'))||
     !same(recovery,expectedPath('family-calendar-phase1-recovery'))||
     !same(backup,path.join(recovery,SNAPSHOT))||
     same(deps,installed)){
    refuse('Source, recovery or dependency boundaries differ from reviewed host.')
  }
  if(git(['-C',installed,'rev-parse','HEAD'])!==INSTALLED_SHA||
    git(['-C',installed,'status','--porcelain','--untracked-files=no'])!==''){
    refuse('Installed TEST Git revision or tracked files changed.')
  }
  const original=exactFiles(backup)
  verifyDatabase(originalDb)
  reviewStep='dependency-inventory'
  const dependencyFiles=countPhysicalDeps(deps)
  if(mode==='preflight'){
    console.log('ISOLATED_TEST_RESTORE_PREFLIGHT=PASS | historical_backup_files=34 | accounts=1 | session_rows=21 | installed_test_sha='+INSTALLED_SHA+' | dependency_files='+dependencyFiles+' | boot_performed=NO | existing_test_shutdown_required=YES | installed_sites_written=NO | deployment_authorized=NO')
    return
  }
  // No temporary Node instance while the existing TEST calendar is active.
  requireTestMaintenanceFence()
  let stage=null
  let child=null
  let stopped=true
  try{
    reviewStep='isolate-source'
    stage=fs.mkdtempSync(path.join(os.tmpdir(),DIR))
    const checkout=path.join(stage,'source')
    git(['clone','--quiet','--local','--no-hardlinks','--no-checkout',installed,checkout])
    git(['-C',checkout,'checkout','--quiet','--detach',INSTALLED_SHA])
    if(git(['-C',checkout,'rev-parse','HEAD'])!==INSTALLED_SHA){
      refuse('Isolated source does not match the installed TEST revision.')
    }
    // Reject any tracked destination link/directory before copying data.
    // A malicious Git symlink at Server/data would otherwise redirect writes
    // from the temporary checkout back toward an installed calendar.
    const server=physicalDir(path.join(checkout,'Server'))
    for(const location of [path.join(checkout,'node_modules'),
      path.join(server,'data'),path.join(server,'uploads'),path.join(checkout,'dist')]){
      if(fs.existsSync(location))refuse('Temporary source contains a pre-existing recovered-data destination.')
    }
    // All these are PHYSICAL copies. Never link dependencies, DB or assets
    // back to the running TEST junction locations.
    reviewStep='copy-dependencies'
    copyTree(deps,path.join(checkout,'node_modules'))
    reviewStep='restore-files'
    fs.mkdirSync(path.join(checkout,'Server','data'),{recursive:true})
    fs.copyFileSync(originalDb,path.join(checkout,'Server','data','calendar.db'),
      fs.constants.COPYFILE_EXCL)
    copyTree(path.join(backup,'uploads'),path.join(checkout,'Server','uploads'))
    copyTree(path.join(backup,'dist'),path.join(checkout,'dist'))
    const stagedDb=path.join(checkout,'Server','data','calendar.db')
    const counts=verifyDatabase(stagedDb)
    if(hash(stagedDb)!==hash(originalDb))refuse('Isolated SQLite differs before boot.')
    for(const f of original){
      let saved
      if(f.relative==='calendar.db')saved=stagedDb
      else if(f.relative.startsWith('dist'+path.sep))saved=path.join(checkout,f.relative)
      else if(f.relative.startsWith('uploads'+path.sep)){
        saved=path.join(checkout,'Server',f.relative)
      }else continue // Supervisor is never copied, imported or executed.
      if(!fs.existsSync(saved)||hash(saved)!==f.sha256){
        refuse('Restored frontend/upload file differed before boot.')
      }
    }
    const port=await choosePort()
    // A clean environment strips production/test storage and other secrets.
    const env={
      SystemRoot:process.env.SystemRoot||'C:\\Windows',
      WINDIR:process.env.WINDIR||'C:\\Windows',
      PATH:process.env.PATH||'',
      TEMP:process.env.TEMP||os.tmpdir(),
      TMP:process.env.TMP||os.tmpdir(),
      USERPROFILE:process.env.USERPROFILE||os.homedir(),
      FAMILY_CALENDAR_HOST:'127.0.0.1',
      FAMILY_CALENDAR_PORT:String(port),
      FAMILY_CALENDAR_AUTH_MODE:'required',
      FAMILY_CALENDAR_TEST_FAMILY_ACCESS_MODE:'off',
      NODE_ENV:'production',
    }
    // Recheck after large local copies: updater or legacy backend may not
    // have resumed while staging the private restore.
    requireTestMaintenanceFence()
    reviewStep='isolated-loopback-boot'
    child=spawn(nodeBinary,[path.join(checkout,'Server','index.mjs')],{
      cwd:checkout,env,windowsHide:true,stdio:['ignore','ignore','ignore'],
    })
    let spawnFailed=false
    child.once('error',()=>{spawnFailed=true})
    await checkBoot(port,child,()=>spawnFailed)
    if(git(['-C',installed,'rev-parse','HEAD'])!==INSTALLED_SHA){
      refuse('Installed TEST source changed during isolated verification.')
    }
    for(const f of original){
      if(hash(f.full)!==f.sha256)refuse('Original backup bytes drifted during restore.')
    }
    reviewStep='isolated-shutdown'
    stopped=await shutDown(child)
    child=null
    if(!stopped)refuse('Isolated restored backend failed to exit.')
    reviewStep='post-boot-restore-validation'
    requireTestMaintenanceFence()
    const post=verifyDatabase(stagedDb)
    if(post.account!==counts.account||post.sessions!==counts.sessions){
      refuse('Restored account/session counts changed unexpectedly on boot.')
    }
    console.log('ISOLATED_TEST_RESTORE_BOOT=PASS | historical_backup_files=34 | accounts=1 | session_rows=21 | health=200 | auth=REQUIRED | anonymous_events_people_lists=401 | isolated_node_stopped=YES | original_backup_unchanged=YES | installed_sites_written=NO | deployment_authorized=NO')
  }finally{
    if(child)stopped=await shutDown(child)
    if(stage&&stopped)fs.rmSync(stage,{recursive:true,force:true})
    if(!stopped)refuse('Isolated Node could not be stopped; temporary folder retained for operator review.')
  }
}
main().catch(()=>{
  // Never print credentials, source paths or backend stderr.
  console.error('ISOLATED_TEST_RESTORE_BOOT=REVIEW | step='+reviewStep+' | no_service_or_route_changes_requested=YES | deployment_authorized=NO')
  process.exitCode=2
})
