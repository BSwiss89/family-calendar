import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { socialVideoAllowedOnTest, groundedVideoDraft, analyzePublicSocialVideo } from '../Server/arney-social-video-import.mjs'

const ig = 'https://www.instagram.com/reel/ABCDE_fghi1/?igsh=tracking'
const fb = 'https://www.facebook.com/share/r/1A8Sz2b3cf/?mibextid=tracked'

test('video worker is restricted to isolated authenticated TEST', () => {
  assert.equal(socialVideoAllowedOnTest({port:13002,authMode:'required',rootFolder:'/projects/family-calendar-test'}),true)
  assert.equal(socialVideoAllowedOnTest({port:3001,authMode:'required',rootFolder:'/projects/family-calendar-live'}),false)
  assert.equal(socialVideoAllowedOnTest({port:13002,authMode:'disabled',rootFolder:'/projects/family-calendar-test'}),false)
})

test('model output without actual caption/video evidence never becomes a recipe', () => {
  const result=groundedVideoDraft({structured:{name:'Fake',ingredients:['9 cups sugar'],instructions:['Bake']}})
  assert.equal(result.name,'')
  assert.equal(result.ingredients,'')
  assert.equal(result.instructions,'')
  assert.deepEqual(result.missing,['ingredients','instructions'])
})

test('copied video link is tried automatically, blocked video offers screen recording', async () => {
  let called=''
  const result=await analyzePublicSocialVideo({url:fb},{
    downloader:async url=>{called=url;throw Error('blocked')},
    extractor:async()=>null
  })
  assert.equal(called,'https://www.facebook.com/share/r/1A8Sz2b3cf/')
  assert.equal(result.videoAnalyzed,false)
  assert.deepEqual(result.missing,['ingredients','instructions'])
  assert.match(result.notice,/screen recording/i)
})

test('uploaded video frames and multiple audio clips can populate a reviewed draft', async () => {
  let offsets=[],evidence
  const result=await analyzePublicSocialVideo({url:ig,videoBuffer:Buffer.alloc(300),videoMime:'video/mp4'},{
    durationReader:async()=>37,
    transcriber:async(_f,_d,start)=>{offsets.push(start);return start===0?'Ingredients: 2 cups rice':'Directions: Stir rice in a pan.'},
    visualReader:async()=> 'On-screen name: Garlic Rice',
    extractor:async info=>{evidence=info;return{name:'Garlic Rice',ingredients:['2 cups rice'],instructions:['Stir rice in a pan.']}}
  })
  assert.deepEqual(offsets,[0,18,36])
  assert.match(evidence.transcript,/2 cups rice/)
  assert.equal(result.videoAnalyzed,true)
  assert.equal(result.audioTranscribed,true)
  assert.equal(result.framesRead,true)
  assert.equal(result.ingredients,'2 cups rice')
  assert.deepEqual(result.missing,[])
})

test('creator description is imported automatically without caption paste', async () => {
  let seen=''
  const result=await analyzePublicSocialVideo({url:ig},{
    downloader:async(_url,folder)=>{
      const filename=path.join(folder,'fake.mp4')
      await writeFile(filename,Buffer.alloc(300))
      return {filename,caption:'Recipe: Beans\nIngredients:\n- 1 cup beans\nInstructions:\n1. Simmer beans.'}
    },
    durationReader:async()=>1, transcriber:async()=>'',visualReader:async()=>'',
    extractor:async evidence=>{seen=evidence.caption;return null}
  })
  assert.match(seen,/1 cup beans/)
  assert.equal(result.ingredients,'1 cup beans')
  assert.equal(result.instructions,'Simmer beans.')
  assert.equal(result.captionRecovered,true)
})
test('invalid hosts and recording formats stop before network fetch', async () => {
  let called=false
  await assert.rejects(()=>analyzePublicSocialVideo({url:'https://facebook.com.evil.test/reel/1234567'},{
    downloader:async()=>{called=true}
  }),TypeError)
  await assert.rejects(()=>analyzePublicSocialVideo({url:ig,videoBuffer:Buffer.alloc(300),videoMime:'application/pdf'}),TypeError)
  assert.equal(called,false)
})

test('video preview has authentication, no database writes and explicit Save Recipe', () => {
  const server=readFileSync(new URL('../Server/index.mjs',import.meta.url),'utf8')
  const client=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8')
  const start=server.indexOf('// TEST-only video analysis.')
  const end=server.indexOf('// Source photo bytes are requested ONLY',start)
  const route=server.slice(start,end)
  assert.ok(start>server.indexOf('installFamilyAuth('))
  assert.ok(route.includes('socialVideoAllowedOnTest('))
  assert.ok(route.includes('request.familyAccount'))
  assert.ok(route.includes('multer.memoryStorage()'))
  assert.ok(route.includes('analyzePublicSocialVideo('))
  assert.ok(!route.includes('database.prepare('))
  assert.ok(client.includes('/api/arney/social-recipe-video-preview'))
  assert.ok(client.includes('setRecipeSourceUrl(data.sourceUrl)'))
  assert.ok(client.includes('onSubmit={saveRecipe}'))
  assert.ok(client.includes('Save Recipe'))
})
