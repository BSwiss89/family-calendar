import test from 'node:test'
import assert from 'node:assert/strict'
import {beginArneyLocalSpeech} from '../src/arneyLocalSpeech.ts'

const tick=()=>new Promise(resolve=>setImmediate(resolve))

function setup(responses=['First local command']) {
  const recorders=[]
  const tracks=[]
  const uploads=[]
  let clock=1000
  class Recorder {
    static isTypeSupported(type){return type==='audio/mp4'}
    constructor(_stream,options={}) {
      this.mimeType=options.mimeType || 'audio/mp4'
      this.state='inactive'
      recorders.push(this)
    }
    start(){this.state='recording'}
    stop(){
      if(this.state!=='recording') throw new Error('not recording')
      this.state='inactive'
      this.ondataavailable?.({data:new Blob([Buffer.alloc(96,3)],{type:this.mimeType})})
      this.onstop?.()
    }
  }
  const dependencies={
    Recorder,
    getUserMedia:async()=>({getTracks:()=>{
      const track={stopped:false,stop(){this.stopped=true}}
      tracks.push(track);return [track]
    }}),
    fetchImpl:async(url,options)=>{
      uploads.push({url,options})
      const transcript=responses.shift() ?? ''
      return new Response(JSON.stringify({transcript}),{
        status:transcript?200:422,headers:{'Content-Type':'application/json'},
      })
    },
    now:()=>clock,
    stopDelayMs:0, // Baseline fixture keeps its original immediate-stop semantics.
  }
  return {dependencies,recorders,tracks,uploads,advance:n=>{clock+=n}}
}

test('local hold records once, uploads only after release, and returns editable text',async()=>{
  const x=setup()
  const results=[]
  const listening=[]
  const session=beginArneyLocalSpeech(result=>results.push(result),
    value=>listening.push(value),x.dependencies)
  assert.ok(session)
  await tick()
  assert.equal(x.recorders.length,1)
  assert.equal(x.recorders[0].state,'recording')
  assert.equal(x.uploads.length,0)
  x.advance(1400)
  session.stop()
  await tick()
  assert.equal(x.uploads.length,1)
  assert.equal(x.uploads[0].url,'/api/arney/local-transcription')
  assert.equal(x.uploads[0].options.method,'POST')
  assert.equal(x.uploads[0].options.body.get('durationMs'),'1400')
  assert.equal(x.uploads[0].options.body.get('audio').type,'audio/mp4')
  assert.deepEqual(results,[{kind:'transcript',text:'First local command'}])
  assert.deepEqual(listening,[true,false,false])
  assert.equal(x.tracks.every(track=>track.stopped),true)
})

test('release tail records the end of speech before upload and cancel still discards it',async()=>{
  const x=setup(['Full natural sentence'])
  let pending=null
  let scheduledMs=0
  x.dependencies.stopDelayMs=180
  x.dependencies.scheduleStop=(callback,delay)=>{
    scheduledMs=delay
    pending=callback
    return 123
  }
  x.dependencies.clearStop=()=>{pending=null}
  const results=[]
  const session=beginArneyLocalSpeech(result=>results.push(result),undefined,x.dependencies)
  await tick()
  x.advance(1150)
  session.stop()
  assert.equal(scheduledMs,180)
  assert.equal(x.recorders[0].state,'recording')
  assert.equal(x.uploads.length,0,'no network before trailing buffer completes')
  x.advance(180)
  const flush=pending
  flush()
  await tick()
  assert.equal(x.recorders[0].state,'inactive')
  assert.equal(x.uploads.length,1)
  assert.equal(x.uploads[0].options.body.get('durationMs'),'1330')
  assert.equal(results[0].text,'Full natural sentence')
  const y=setup()
  let canceledFlush
  y.dependencies.stopDelayMs=180
  y.dependencies.scheduleStop=callback=>{canceledFlush=callback;return 123}
  y.dependencies.clearStop=()=>{}
  const canceledResults=[]
  const second=beginArneyLocalSpeech(result=>canceledResults.push(result),undefined,y.dependencies)
  await tick()
  y.advance(500)
  second.stop()
  second.cancel()
  canceledFlush()
  await tick()
  assert.equal(y.uploads.length,0)
  assert.deepEqual(canceledResults,[])
})
test('two consecutive local recordings use fresh recorders and both transcribe',async()=>{
  const x=setup(['First','Second'])
  const results=[]
  for(const expected of ['First','Second']) {
    const session=beginArneyLocalSpeech(result=>results.push(result),undefined,x.dependencies)
    await tick();x.advance(800);session.stop();await tick()
    assert.equal(results.at(-1).text,expected)
  }
  assert.equal(x.recorders.length,2)
  assert.equal(x.uploads.length,2)
})

test('local transcript includes safe service and round-trip timing',async()=>{
  const x=setup()
  x.dependencies.fetchImpl=async()=>{
    x.advance(640)
    return new Response(JSON.stringify({transcript:'Timed command',elapsedMs:410}),{
      status:200,headers:{'Content-Type':'application/json'},
    })
  }
  const results=[]
  const session=beginArneyLocalSpeech(result=>results.push(result),undefined,x.dependencies)
  await tick();x.advance(900);session.stop();await tick()
  assert.deepEqual(results,[{
    kind:'transcript',text:'Timed command',timing:{totalMs:640,transcriptionMs:410},
  }])
})

test('cancel stops microphone tracks, discards audio and never uploads',async()=>{
  const x=setup()
  const results=[]
  const session=beginArneyLocalSpeech(result=>results.push(result),undefined,x.dependencies)
  await tick()
  session.cancel()
  await tick()
  assert.equal(x.uploads.length,0)
  assert.deepEqual(results,[])
  assert.equal(x.tracks.every(track=>track.stopped),true)
})

test('service failures return a safe error and never invent transcript text',async()=>{
  const x=setup()
  x.dependencies.fetchImpl=async()=>new Response(JSON.stringify({error:'offline'}),{
    status:503,headers:{'Content-Type':'application/json'},
  })
  const results=[]
  const session=beginArneyLocalSpeech(result=>results.push(result),undefined,x.dependencies)
  await tick();x.advance(900);session.stop();await tick()
  assert.deepEqual(results,[{kind:'error',reason:'local-transcription-unavailable'}])
})


