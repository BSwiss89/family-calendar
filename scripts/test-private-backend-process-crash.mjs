// Actual disposable Calendar backend process-crash rehearsal on Windows CI.
// Never targets installed services, production SQLite, Tailscale or LIVE/TEST.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Server')
const checkout = path.dirname(serverDirectory)
const entry = path.join(serverDirectory, 'index.mjs')
const blockedPorts = new Set([3001, 13001, 13002, 13003, 11434, 443, 8443])
const lockFile = (root,id) => path.join(root, 'households', id,
  '.family-calendar-private-backend-writer.lock', 'owner.json')

async function randomPort(used) {
  for (let i = 0; i < 30; i++) {
    const server = createServer()
    const port = await new Promise((resolve,reject) => {
      server.once('error',reject)
      server.listen(0,'127.0.0.1',()=>resolve(server.address().port))
    })
    await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()))
    if (port>=1024&&!blockedPorts.has(port)&&!used.has(port)) {
      used.add(port)
      return port
    }
  }
  throw new Error('Could not reserve disposable loopback port.')
}

function start(root, id, port, token) {
  const child = spawn(process.execPath,[entry],{
    cwd:checkout,windowsHide:true,
    env:{
      ...process.env,
      FAMILY_CALENDAR_HOST:'127.0.0.1',
      FAMILY_CALENDAR_PORT:String(port),
      FAMILY_CALENDAR_AUTH_MODE:'disabled',
      FAMILY_CALENDAR_HOUSEHOLD_STORAGE_ROOT:root,
      FAMILY_CALENDAR_HOUSEHOLD_ID:id,
      FAMILY_CALENDAR_HOUSEHOLD_TEST_ONLY:'YES',
      FAMILY_CALENDAR_PRIVATE_UPSTREAM_TOKEN:token,
    },
    stdio:['ignore','pipe','pipe','ipc']
  })
  let logs=''
  for (const stream of [child.stdout,child.stderr]) {
    stream.on('data',chunk=>{logs=(logs+chunk.toString('utf8')).slice(-3000)})
  }
  return {child,id,port,token,base:'http://127.0.0.1:'+port,logs:()=>logs}
}

function exited(item) {
  return item.child.exitCode!==null||item.child.signalCode!==null
}

async function waitForExit(item,ms=10000) {
  if (exited(item)) return item.child.exitCode
  return await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{
      cleanup()
      reject(new Error('Disposable backend exit was not confirmed: '+item.id))
    },ms)
    const finished=(code)=>{cleanup();resolve(code)}
    const failed=(error)=>{cleanup();reject(error)}
    const cleanup=()=>{
      clearTimeout(timeout)
      item.child.off('exit',finished)
      item.child.off('error',failed)
    }
    item.child.once('exit',finished)
    item.child.once('error',failed)
  })
}

async function forceStop(item) {
  if (exited(item)) return
  const done=waitForExit(item)
  if (!item.child.kill('SIGKILL')) throw new Error('Could not stop isolated test child '+item.id)
  await done
}

async function gracefulStop(item) {
  if (exited(item)) throw new Error('Disposable backend already exited before graceful shutdown.')
  if (!item.child.connected) throw new Error('Missing private parent-child IPC channel.')
  const done=waitForExit(item)
  item.child.send({type:'private-household-test-shutdown',householdId:item.id})
  assert.equal(await done,0,'Expected clean disposable backend shutdown.')
}

async function waitHealthy(item) {
  for(let i=0;i<60;i++){
    if(exited(item))throw new Error('Disposable backend exited early: '+item.logs())
    try{
      const response=await fetch(item.base+'/api/health',{
        headers:{'x-family-calendar-upstream-token':item.token},
        signal:AbortSignal.timeout(1000)
      })
      if(response.status===200&&(await response.json()).status==='ok')return
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,250))
  }
  throw new Error('Disposable backend health timeout: '+item.logs())
}

async function api(item,method,endpoint,body){
  return await fetch(item.base+endpoint,{
    method,
    headers:{
      'x-family-calendar-upstream-token':item.token,
      ...(body?{'Content-Type':'application/json'}:{})
    },
    body:body?JSON.stringify(body):undefined,
    signal:AbortSignal.timeout(7000)
  })
}

function verifyDurableEvent(file, title) {
  const db=new DatabaseSync(file,{readOnly:true})
  try {
    db.exec('PRAGMA query_only = ON')
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE title = ?')
      .get(title).n,1)
  }finally{db.close()}
}

test('killed REAL Family A SQLite backend stays quarantined while Family B runs and restarts', {
  timeout:80000,
},async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'calendar-real-backend-crash-'))
  const root=path.join(temp,'storage')
  fs.mkdirSync(root)
  const a=provisionEmptyHousehold({serverDirectory,storageRoot:root,householdId:'family-a'})
  const b=provisionEmptyHousehold({serverDirectory,storageRoot:root,householdId:'family-b'})
  const reserved=new Set()
  const children=[]
  let safeToDelete=false
  try {
    const aServer=start(root,'family-a',await randomPort(reserved),randomBytes(32).toString('hex'))
    children.push(aServer)
    const bServer=start(root,'family-b',await randomPort(reserved),randomBytes(32).toString('hex'))
    children.push(bServer)
    await Promise.all([waitHealthy(aServer),waitHealthy(bServer)])
    const markerBefore=fs.readFileSync(lockFile(root,'family-a'),'utf8')
    assert.equal(JSON.parse(markerBefore).pid,aServer.child.pid)
    assert.equal(fs.existsSync(lockFile(root,'family-b')),true)

    assert.equal((await api(aServer,'POST','/api/events',{
      date:'2026-12-20',title:'A committed before crash',time:'12:00'
    })).status,201)
    assert.equal((await api(bServer,'POST','/api/events',{
      date:'2026-12-21',title:'B unaffected event',time:'13:00'
    })).status,201)

    // Abrupt termination bypasses graceful cleanup; a stale lock is expected.
    await forceStop(aServer)
    assert.equal(fs.readFileSync(lockFile(root,'family-a'),'utf8'),markerBefore)
    verifyDurableEvent(a.databasePath,'A committed before crash')

    // A new valid-token backend on another loopback port must be refused
    // BEFORE it can open Family A SQLite, even if the old PID is gone.
    const duplicateA=start(root,'family-a',await randomPort(reserved),
      randomBytes(32).toString('hex'))
    children.push(duplicateA)
    assert.notEqual(await waitForExit(duplicateA,12000),0)
    assert.match(duplicateA.logs(),/Private household backend writer lock already exists/)
    assert.equal(fs.readFileSync(lockFile(root,'family-a'),'utf8'),markerBefore)

    // Family B remains operational, can still write and can close/restart
    // using only its OWN writer lock, without deleting Family A's quarantine.
    const bList=await api(bServer,'GET','/api/events')
    assert.equal(bList.status,200)
    assert.match(await bList.text(),/B unaffected event/)
    assert.equal((await api(bServer,'POST','/api/events',{
      date:'2026-12-22',title:'B write after A crash',time:'14:00'
    })).status,201)
    await gracefulStop(bServer)
    assert.equal(fs.existsSync(lockFile(root,'family-b')),false)
    const bRestart=start(root,'family-b',await randomPort(reserved),
      randomBytes(32).toString('hex'))
    children.push(bRestart)
    await waitHealthy(bRestart)
    const bAgain=await api(bRestart,'GET','/api/events')
    assert.equal(bAgain.status,200)
    assert.match(await bAgain.text(),/B write after A crash/)
    await gracefulStop(bRestart)
    verifyDurableEvent(b.databasePath,'B write after A crash')
    assert.equal(fs.existsSync(lockFile(root,'family-b')),false)
    assert.equal(fs.readFileSync(lockFile(root,'family-a'),'utf8'),markerBefore)
    safeToDelete=true
  }finally {
    const problems=[]
    for(const child of children){
      try{await forceStop(child)}catch(error){problems.push(error)}
    }
    // Never erase a fixture while a spawned writer might still be alive.
    if(problems.length===0&&children.every(exited)){
      fs.rmSync(temp,{recursive:true,force:true})
    }else{
      throw new AggregateError(problems,
        'Disposable backend termination unverified; test fixture was preserved.')
    }
  }
  assert.equal(safeToDelete,true)
})
