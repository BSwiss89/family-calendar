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


