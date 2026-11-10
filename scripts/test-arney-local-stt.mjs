import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import {once} from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {installLocalStt} from '../Server/local-stt.mjs'

const token='t'.repeat(48)
const target='http://127.0.0.1:13981/transcribe'

async function fixture(fetchImpl=async()=>new Response(JSON.stringify({transcript:'Add milk'}),{
  status:200,headers:{'Content-Type':'application/json'},
})) {
  const app=express()
  app.use((request,_response,next)=>{
    if(request.headers['x-test-session'] !== 'none') request.familyAccount={id:10,user_id:1}
    next()
  })
  const pilot=installLocalStt(app,{
    flag:'enabled',port:13002,authMode:'required',
    rootFolder:'/tmp/family-calendar-test-local-stt',serviceUrl:target,
    serviceToken:token,fetchImpl,timeoutSignal:()=>undefined,
  })
  const server=app.listen(0,'127.0.0.1')
  await once(server,'listening')
  const base=`http://127.0.0.1:${server.address().port}`
  return {pilot,base,close:()=>new Promise(resolve=>server.close(resolve))}
}

function recording({type='audio/mp4',duration='1200',size=128}={}) {
  const body=new FormData()
  body.append('durationMs',duration)
  body.append('audio',new Blob([Buffer.alloc(size,7)],{type}),'voice.m4a')
  return body
}

test('local STT accepts only authenticated LIVE or isolated TEST with loopback configuration',()=>{
  const app={get(){},post(){}}
  assert.equal(installLocalStt(app,{flag:'disabled'}).enabled,false)
  for(const config of [
    {port:13002,rootFolder:'/tmp/family-calendar-live'},
    {port:3002,rootFolder:'/tmp/family-calendar-live'},
    {port:3001,rootFolder:'/tmp/family-calendar-test-copy'},
    {port:3001,rootFolder:'/tmp/family-calendar-live',authMode:'disabled'},
  ]) assert.throws(()=>installLocalStt(app,{
    flag:'enabled',authMode:'required',serviceUrl:target,serviceToken:token,
    fetchImpl:async()=>{},...config,
  }))
  for(const config of [
    {port:13002,rootFolder:'/tmp/family-calendar-test-local-stt'},
    {port:3001,rootFolder:'/tmp/family-calendar-live'},
  ]) assert.equal(installLocalStt(app,{
    flag:'enabled',authMode:'required',serviceUrl:target,serviceToken:token,
    fetchImpl:async()=>{},...config,
  }).enabled,true)
  assert.throws(()=>installLocalStt(app,{
    flag:'enabled',port:13002,authMode:'required',
    rootFolder:'/tmp/family-calendar-test-local',
    serviceUrl:'https://example.com/transcribe',serviceToken:token,fetchImpl:async()=>{},
  }))
})

test('installed configuration accepts Windows UTF-8 BOM and enables authenticated LIVE and TEST',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'arney-stt-config-'))
  const configFile=path.join(root,'config.json')
  const methods={get(){},post(){}}
  try {
    for(const prefix of ['', '\ufeff']) {
      fs.writeFileSync(configFile,prefix+JSON.stringify({
        enabled:true,serviceUrl:target,serviceToken:token,
      }))
      assert.equal(installLocalStt(methods,{
        port:13002,authMode:'required',rootFolder:'/tmp/family-calendar-test-installed',
        configFile,fetchImpl:async()=>{},
      }).enabled,true)
      assert.equal(installLocalStt(methods,{
        port:3001,authMode:'required',rootFolder:'/tmp/family-calendar-live',
        configFile,fetchImpl:async()=>{},
      }).enabled,true)
    }
  } finally {fs.rmSync(root,{recursive:true,force:true})}
})

test('authenticated calendar recording is forwarded only to the configured loopback service',async()=>{
  const calls=[]
  const x=await fixture(async(url,options)=>{
    calls.push({url,options})
    return new Response(JSON.stringify({transcript:'  Add milk tomorrow  ',elapsedMs:321}),{
      status:200,headers:{'Content-Type':'application/json'},
    })
  })
  try {
    assert.equal(x.pilot.enabled,true)
    const response=await fetch(x.base+'/api/arney/local-transcription',{
      method:'POST',body:recording(),headers:{Origin:x.base},
    })
    assert.equal(response.status,200)
    assert.deepEqual(await response.json(),{transcript:'Add milk tomorrow',elapsedMs:321})
    assert.equal(calls.length,1)
    assert.equal(calls[0].url,target)
    assert.equal(calls[0].options.headers.Authorization,'Bearer '+token)
    assert.equal(calls[0].options.headers['Content-Type'],'audio/mp4')
    assert.equal(Buffer.isBuffer(calls[0].options.body),true)
    assert.equal(calls[0].options.body.length,128)
  } finally {await x.close()}
})

test('missing session, invalid type, invalid duration and oversized audio fail before STT',async()=>{
  let calls=0
  const x=await fixture(async()=>{calls++;return new Response('{}',{status:500})})
  try {
    let response=await fetch(x.base+'/api/arney/local-transcription',{
      method:'POST',body:recording(),headers:{'X-Test-Session':'none'},
    })
    assert.equal(response.status,401)
    response=await fetch(x.base+'/api/arney/local-transcription',{
      method:'POST',body:recording({type:'text/plain'}),
    })
    assert.equal(response.status,400)
    response=await fetch(x.base+'/api/arney/local-transcription',{
      method:'POST',body:recording({duration:'25000'}),
    })
    assert.equal(response.status,400)
    response=await fetch(x.base+'/api/arney/local-transcription',{
      method:'POST',body:recording({size:2*1024*1024+1}),
    })
    assert.equal(response.status,413)
    assert.equal(calls,0)
  } finally {await x.close()}
})

test('busy, upstream failure and no-speech responses fail closed without transcript',async()=>{
  let release
  const held=new Promise(resolve=>{release=resolve})
  let invocation=0
  const x=await fixture(async()=>{
    invocation++
    if(invocation===1) await held
    if(invocation===2) return new Response(JSON.stringify({transcript:''}),{
      status:200,headers:{'Content-Type':'application/json'},
    })
    return new Response(JSON.stringify({error:'unavailable'}),{
      status:503,headers:{'Content-Type':'application/json'},
    })
  })
  try {
    const first=fetch(x.base+'/api/arney/local-transcription',{method:'POST',body:recording()})
    await new Promise(resolve=>setTimeout(resolve,20))
    const busy=await fetch(x.base+'/api/arney/local-transcription',{method:'POST',body:recording()})
    assert.equal(busy.status,503)
    release()
    assert.equal((await first).status,503)
    const empty=await fetch(x.base+'/api/arney/local-transcription',{method:'POST',body:recording()})
    assert.equal(empty.status,422)
  } finally {await x.close()}
})

test('local STT runtime keeps transcription loopback-only and memory-only',()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
  const launcher=fs.readFileSync(path.join(root,'scripts/start-arney-local-stt.ps1'),'utf8')
  const service=fs.readFileSync(path.join(root,'stt/arney_local_stt_service.py'),'utf8')
  assert.match(launcher,/127\.0\.0\.1:13981\/transcribe/)
  assert.match(service,/HOST = "127\.0\.0\.1"/)
  assert.doesNotMatch(service,/HOST = "0\.0\.0\.0"/)
  assert.match(service,/audio_bytes = b""/)
  assert.match(service,/MODEL_NAME = os\.environ\.get\("FAMILY_CALENDAR_LOCAL_STT_MODEL", "base\.en"\)/)
  assert.match(service,/cpu_threads=8/)
  assert.match(launcher,/FAMILY_CALENDAR_LOCAL_STT_MODEL = 'base\.en'/)
})

