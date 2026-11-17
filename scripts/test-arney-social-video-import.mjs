import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import sharp from 'sharp'
import path from 'node:path'
import { socialVideoAllowedOnTest, groundedVideoDraft, extractSpokenRecipeFacts, analyzePublicSocialVideo, buildSocialCoverPreview } from '../Server/arney-social-video-import.mjs'

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


test('regression from iPhone: spoken measurements and actions fill fields instead of transcript analysis in Notes', () => {
  const transcript = 'First, add 1 pound of ground turkey. Then stir in 2 cups of rice. Cook for 10 minutes. 500 calories and 45g protein per serving.'
  const draft = groundedVideoDraft({
    caption: 'Recipe',
    transcript,
    structured: {
      name: 'Recipe', ingredients: [], instructions: [],
      nutritionNotes: 'Audio transcript explicitly states **500 calories, 45g protein** per serving (no fat/carb breakdown).',
    },
  })
  assert.equal(draft.name, '')
  assert.match(draft.ingredients, /1 pound of ground turkey/i)
  assert.match(draft.ingredients, /2 cups of rice/i)
  assert.match(draft.instructions, /add 1 pound of ground turkey/i)
  assert.match(draft.instructions, /stir in 2 cups of rice/i)
  assert.doesNotMatch(draft.ingredients, /45g protein|500 calories/i)
  assert.equal(draft.notes, '')
  assert.deepEqual(draft.missing, [])
})

test('spoken macros alone cannot turn into measured ingredients or recipe steps', () => {
  const spoken = 'This meal is 500 calories and 45g protein.'
  const draft = groundedVideoDraft({
    caption: 'Recipe', transcript: spoken,
    structured: { name: 'Recipe', ingredients: [], instructions: [],
      nutritionNotes: 'Audio transcript explicitly states **500 calories, 45g protein**.' },
  })
  assert.equal(draft.name, '')
  assert.equal(draft.ingredients, '')
  assert.equal(draft.instructions, '')
  assert.equal(draft.notes, '')
  assert.deepEqual(draft.missing, ['ingredients', 'instructions'])
  assert.deepEqual(extractSpokenRecipeFacts('500 calories, 45g protein per serving.'), {
    ingredients: '', instructions: '',
  })
})

test('small Ollama models may return newline strings rather than ingredient and instruction arrays', () => {
  const draft = groundedVideoDraft({
    caption: '', transcript: 'Use 2 cups rice. Stir rice and cook it.',
    structured: { name: 'Spicy Rice',
      ingredients: '- 2 cups rice\n- 1 tsp chili flakes',
      instructions: '1. Stir rice.\n2. Cook until tender.',
    },
  })
  assert.equal(draft.name, 'Spicy Rice')
  assert.equal(draft.ingredients, '2 cups rice\n1 tsp chili flakes')
  assert.equal(draft.instructions, 'Stir rice.\nCook until tender.')
  assert.deepEqual(draft.missing, [])
})

test('focused local speech recovery completes cooking fields when four-frame vision is unavailable', async () => {
  let retries = 0
  const result = await analyzePublicSocialVideo({
    url: ig, videoBuffer: Buffer.alloc(300), videoMime: 'video/mp4',
  }, {
    durationReader: async () => 36,
    transcriber: async () => ({ text: 'We add rice and chicken. Cook everything.', responded: true }),
    visualReader: async () => ({ text: '', framesSampled: 4, visionResponded: false }),
    extractor: async () => ({ name: 'Recipe', ingredients: [], instructions: [],
      nutritionNotes: 'Audio transcript explicitly states a recipe.' }),
    speechExtractor: async evidence => {
      retries++
      assert.match(evidence.transcript, /add rice and chicken/i)
      return { name: 'Chicken Rice', ingredients: ['Chicken', 'Rice'],
        instructions: ['Add rice and chicken.', 'Cook everything.'] }
    },
    coverReader: async () => null,
  })
  assert.equal(retries, 1)
  assert.equal(result.name, 'Chicken Rice')
  assert.match(result.ingredients, /Chicken/)
  assert.match(result.instructions, /Cook everything/)
  assert.equal(result.videoReport.audioSegmentsChecked, 2)
  assert.equal(result.videoReport.framesSampled, 4)
  assert.equal(result.videoReport.visionResponded, false)
  assert.equal(result.videoReport.speechRecoveryUsed, true)
  assert.match(result.videoReport.status, /visual cross-check unavailable/i)
  assert.deepEqual(result.missing, [])
  assert.equal(result.notes, '')
})

test('partial video analysis reports incomplete recipe without making up nutritional macros as ingredients', async () => {
  const result = await analyzePublicSocialVideo({
    url: ig, videoBuffer: Buffer.alloc(300), videoMime: 'video/mp4',
  }, {
    durationReader: async () => 18,
    transcriber: async () => ({ text: '500 calories and 45g protein per serving.', responded: true }),
    visualReader: async () => ({ text: '', framesSampled: 4, visionResponded: false }),
    extractor: async () => ({ name: 'Recipe', ingredients: [], instructions: [] }),
    speechExtractor: async () => null,
    coverReader: async () => null,
  })
  assert.deepEqual(result.missing, ['ingredients', 'instructions'])
  assert.equal(result.name, '')
  assert.equal(result.ingredients, '')
  assert.equal(result.instructions, '')
  assert.match(result.videoReport.status, /recipe is incomplete/i)
  assert.equal(result.videoReport.speechRecoveryUsed, false)
})

test('copied public link is tried automatically; blocked links report a retrieval problem', async () => {
  let called=''
  const result=await analyzePublicSocialVideo({url:fb},{
    captionReader:async() => '',
    downloader:async url=>{called=url;throw Error('blocked')},
    extractor:async()=>null
  })
  assert.equal(called,'https://www.facebook.com/share/r/1A8Sz2b3cf/')
  assert.equal(result.videoAnalyzed,false)
  assert.deepEqual(result.missing,['ingredients','instructions'])
  assert.match(result.notice,/could not be retrieved by yt-dlp/i)
})

test('uploaded video frames and multiple audio clips can populate a reviewed draft', async () => {
  let offsets=[],evidence
  const result=await analyzePublicSocialVideo({url:ig,videoBuffer:Buffer.alloc(300),videoMime:'video/mp4'},{
    captionReader:async()=>'', durationReader:async()=>37,
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

test('long Reel speech is analyzed beyond the old 110-second limit', async () => {
  const offsets = []
  const result = await analyzePublicSocialVideo({
    url: ig, videoBuffer: Buffer.alloc(300), videoMime: 'video/mp4',
  }, {
    captionReader:async()=>'', durationReader: async () => 181,
    transcriber: async (_filename, _folder, start) => {
      offsets.push(start)
      return start === 180 ? 'Ingredients: 2 cups flour' : ''
    },
    visualReader: async () => '',
    extractor: async ({ transcript }) => ({
      name: 'Bread',
      ingredients: transcript.includes('2 cups flour') ? ['2 cups flour'] : [],
      instructions: [],
    }),
  })
  assert.equal(result.videoAnalyzed, true)
  assert.equal(result.ingredients, '2 cups flour')
  assert.equal(offsets.at(-1), 180)
  assert.equal(offsets.length, 11)
})

test('videos longer than ten minutes do not generate a made-up recipe', async () => {
  const result = await analyzePublicSocialVideo({
    url: ig, videoBuffer: Buffer.alloc(300), videoMime: 'video/mp4',
  }, {
    captionReader:async()=>'', durationReader: async () => 601,
    transcriber: async () => { throw Error('Must not transcribe') },
    extractor: async () => null,
  })
  assert.equal(result.videoAnalyzed, false)
  assert.deepEqual(result.missing, ['ingredients', 'instructions'])
  assert.match(result.notice, /maximum 10 minutes/i)
})

test('missing Instagram duration metadata can pass the initial filter but still requires ffprobe', () => {
  const source=readFileSync(new URL('../Server/arney-social-video-import.mjs',import.meta.url),'utf8')
  assert.match(source, /duration <=\? 600/)
  assert.ok(source.includes('const duration = await durationReader(filename)'))
  assert.ok(source.includes('duration > MAX_SECONDS'))
})

test('a complete caption is recovered even when video retrieval fails', async () => {
  let captionReads=0, videoAttempts=0
  const result=await analyzePublicSocialVideo({url:ig},{
    captionReader:async()=>{captionReads++;return [
      'Creamy Peri Peri Chicken Pasta',
      '592 Calories | 55g Protein | 54g Carbs | 19g Fat',
      'Ingredients (Makes 8 Servings)',
      '- 1500g Chicken Thighs',
      '👨‍🍳 Instructions',
      '1. Bake at 200C for 22 minutes.',
    ].join('\n')},
    downloader:async()=>{videoAttempts++;throw Error('not accessible')},
    extractor:async()=>null,
  })
  assert.equal(captionReads,1)
  assert.equal(videoAttempts,1)
  assert.equal(result.name,'Creamy Peri Peri Chicken Pasta')
  assert.equal(result.servings,'8')
  assert.match(result.notes,/592 Calories/)
  assert.equal(result.ingredients,'1500g Chicken Thighs')
  assert.equal(result.instructions,'Bake at 200C for 22 minutes.')
  assert.equal(result.videoAnalyzed,false)
  assert.match(result.notice,/video could not be retrieved/i)
  assert.doesNotMatch(result.notice,/only the source link is available/i)
})

test('always processes video even with a complete caption and appends missing video-only facts',async()=>{
  let captionReads=0,videoDownloads=0,transcriptions=0,visionReads=0
  const result=await analyzePublicSocialVideo({url:ig},{
    captionReader:async()=>{captionReads++;return [
      'Recipe: Peri Peri Pasta',
      'Ingredients:',
      '- 2 cups pasta',
      'Instructions:',
      '1. Cook pasta for 10 minutes.',
    ].join('\n')},
    downloader:async(_url,folder)=>{
      videoDownloads++
      const filename=path.join(folder,'mock-clip.mp4')
      await writeFile(filename,Buffer.alloc(300))
      return {filename}
    },
    durationReader:async()=>37,
    transcriber:async()=>{transcriptions++;return 'Add 1 tsp smoked paprika, finish with cheese; cook 12 minutes.'},
    visualReader:async()=>{visionReads++;return 'Video text: 12 minutes'},
    extractor:async({caption,transcript,visibleText})=>{
      assert.match(caption,/2 cups pasta/)
      assert.match(transcript,/smoked paprika/)
      assert.match(visibleText,/12 minutes/)
      return {
        name:'Peri Peri Pasta', ingredients:['2 cups pasta'],
        instructions:['Cook pasta for 10 minutes.'],
        videoIngredientsAdded:['2 cups pasta','1 tsp smoked paprika'],
        videoInstructionsAdded:['Finish with cheese.'],
        conflicts:['Caption says 10 minutes; video says 12 minutes.'],
      }
    },
  })
  assert.equal(captionReads,1)
  assert.equal(videoDownloads,1)
  assert.ok(transcriptions>0)
  assert.equal(visionReads,1)
  assert.equal(result.videoAnalyzed,true)
  assert.equal(result.ingredients,'2 cups pasta\n1 tsp smoked paprika')
  assert.equal(result.instructions,'Cook pasta for 10 minutes.\nFinish with cheese.')
  assert.match(result.notice,/caption\/video differences/i)
  assert.deepEqual(result.missing,[])
})

test('streamed recipe progress exposes caption fields before any video processing', async () => {
  const events = []
  let downloaded = false
  const result = await analyzePublicSocialVideo({ url: ig }, {
    captionReader: async () => [
      'Recipe: Bang Bang Chicken Power Bowl',
      'Ingredients:',
      '- 500g chicken breast',
      'Instructions:',
      '1. Bake chicken at 400F for 22 minutes.',
    ].join('\n'),
    downloader: async (_url, folder) => {
      assert.equal(events.some(event => event.stage === 'caption' &&
        event.draft?.ingredients === '500g chicken breast'), true)
      downloaded = true
      const filename = path.join(folder, 'progressive-video.mp4')
      await writeFile(filename, Buffer.alloc(300))
      return { filename }
    },
    durationReader: async () => 37,
    transcriber: async () => 'Add 1 tbsp peri peri sauce.',
    visualReader: async () => 'Cook at 400F.',
    extractor: async () => ({
      videoIngredientsAdded: ['1 tbsp peri peri sauce'],
      videoInstructionsAdded: ['Finish with fresh herbs.'],
      conflicts: [],
    }),
    onProgress: event => events.push(event),
  })
  assert.equal(downloaded, true)
  assert.equal(events[0].stage, 'caption')
  assert.equal(events.some(event => event.stage === 'video'), true)
  assert.equal(events.some(event => event.stage === 'audio'), true)
  assert.equal(events.some(event => event.stage === 'frames'), true)
  assert.equal(events.some(event => event.stage === 'organize'), true)
  assert.equal(events.at(-1).stage, 'draft')
  assert.equal(result.ingredients, '500g chicken breast\n1 tbsp peri peri sauce')
  assert.match(result.instructions, /Finish with fresh herbs/)
})

test('progressive route preserves legacy JSON and requires explicit streaming opt-in', () => {
  const server = readFileSync(new URL('../Server/index.mjs', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const start = server.indexOf('// TEST-only video analysis.')
  const end = server.indexOf('// Source photo bytes are requested ONLY', start)
  const route = server.slice(start, end)
  assert.ok(route.includes("request.get('Accept')"))
  assert.ok(route.includes('application/x-ndjson'))
  assert.ok(route.includes("writeProgress('progress', event)"))
  assert.ok(route.includes("writeProgress('result', { data: draft })"))
  assert.ok(route.includes('response.json(draft)'))
  assert.ok(!route.includes('database.prepare('))
  assert.ok(client.includes("headers: { Accept: 'application/x-ndjson' }"))
  assert.ok(client.includes("response.body?.getReader()"))
  assert.ok(client.includes('function applyDraft('))
  assert.ok(client.includes('current === previous'))
  assert.ok(client.includes('socialRecipeImportStage'))
  assert.ok(client.includes('recipe-social-import-progress'))
})

test('creator description is imported automatically without caption paste', async () => {
  let seen=''
  const result=await analyzePublicSocialVideo({url:ig},{
    captionReader:async()=>'',
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
test('video report distinguishes actual recognized audio, visual response and caption-only results', async () => {
  const events = []
  const video = await analyzePublicSocialVideo({
    url: ig, videoBuffer: Buffer.alloc(300), videoMime: 'video/mp4',
  }, {
    stt: { url: 'http://127.0.0.1:1234/transcribe', token: 'local-only' },
    durationReader: async () => 36,
    transcriber: async (_file, _folder, start) => ({
      text: start === 0 ? 'Add smoked paprika.' : '', responded: true,
    }),
    visualReader: async () => ({ text: 'Bake for 25 minutes.', framesSampled: 4, visionResponded: true }),
    extractor: async () => ({
      name: 'Chicken Dinner',
      ingredients: ['1 lb chicken'],
      instructions: ['Bake chicken'],
      videoIngredientsAdded: ['1 tsp smoked paprika'],
      videoInstructionsAdded: ['Bake for 25 minutes.'],
    }),
    coverReader: async () => ({ photoDataUrl: 'data:image/webp;base64,AAAA', photoSource: 'Reel cover' }),
    onProgress: info => events.push(info.stage),
  })
  assert.equal(video.videoReport.videoOpened, true)
  assert.equal(video.videoReport.durationSeconds, 36)
  assert.equal(video.videoReport.speechServiceConfigured, true)
  assert.equal(video.videoReport.audioSegmentsChecked, 2)
  assert.equal(video.videoReport.audioSegmentsResponded, 2)
  assert.equal(video.videoReport.audioSegmentsWithText, 1)
  assert.equal(video.videoReport.framesSampled, 4)
  assert.equal(video.videoReport.visionResponded, true)
  assert.equal(video.videoReport.comparisonCompleted, true)
  assert.equal(video.videoReport.newIngredients, 1)
  assert.equal(video.videoReport.newInstructions, 1)
  assert.equal(video.photoSource, 'Reel cover')
  assert.equal(video.photoDataUrl, 'data:image/webp;base64,AAAA')
  assert.equal('speechExcerpt' in video.videoReport, false)
  assert.equal('visionExcerpt' in video.videoReport, false)
  assert.ok(events.includes('cover'))
  assert.ok(video.ingredients.includes('smoked paprika'))

  const captionOnly = await analyzePublicSocialVideo({ url: ig }, {
    captionReader: async () => 'Recipe: Bread\\nIngredients:\\n- 1 cup flour\\nInstructions:\\n1. Bake.',
    downloader: async () => { throw new Error('restricted') },
    extractor: async () => ({ name: 'Bread', ingredients: ['1 cup flour'], instructions: ['Bake.'] }),
    coverReader: async () => null,
  })
  assert.equal(captionOnly.videoReport.videoOpened, false)
  assert.equal(captionOnly.videoReport.audioSegmentsChecked, 0)
  assert.equal(captionOnly.videoReport.audioSegmentsResponded, 0)
  assert.equal(captionOnly.videoReport.framesSampled, 0)
  assert.equal(captionOnly.videoReport.comparisonCompleted, false)
  assert.match(captionOnly.videoReport.status, /Caption only/)
  assert.equal(captionOnly.photoDataUrl, null)
})

test('public Reel covers are sanitized into a small local WebP without video or transcript exposure', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'arney-cover-unit-'))
  try {
    const jpg = await sharp({
      create: { width: 320, height: 220, channels: 3, background: '#3174a0' },
    }).jpeg().toBuffer()
    await writeFile(path.join(folder, 'cover-only.jpg'), jpg)
    const result = await buildSocialCoverPreview(folder)
    assert.equal(result.photoSource, 'Reel cover')
    assert.ok(result.photoDataUrl.startsWith('data:image/webp;base64,'))
    const bytes = Buffer.from(result.photoDataUrl.split(',')[1], 'base64')
    assert.ok(bytes.length > 0 && bytes.length <= 70 * 1024)
    const metadata = await sharp(bytes).metadata()
    assert.equal(metadata.format, 'webp')
    assert.ok(metadata.width <= 640)
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('a video frame is the fallback when the platform gives no original cover', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'arney-frame-unit-'))
  let sampled = false
  try {
    const result = await buildSocialCoverPreview(folder, '/tmp/video-test.mp4', {
      grabFrame: async (_input, output) => {
        sampled = true
        const jpg = await sharp({
          create: { width: 240, height: 240, channels: 3, background: '#4a9f6b' },
        }).jpeg().toBuffer()
        await writeFile(output, jpg)
      },
    })
    assert.equal(sampled, true)
    assert.equal(result.photoSource, 'Video frame')
    assert.ok(result.photoDataUrl.startsWith('data:image/webp;base64,'))
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('the recipe editor shows simple video checks and prepares cover only for explicit Save Recipe', () => {
  const client = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const server = readFileSync(new URL('../Server/index.mjs', import.meta.url), 'utf8')
  assert.ok(client.includes('Video backup check'))
  assert.ok(client.includes('audioSegmentsWithText'))
  assert.ok(client.includes('framesSampled'))
  assert.ok(client.includes('comparisonCompleted'))
  assert.ok(!client.includes('speechExcerpt'))
  assert.ok(!client.includes('visionExcerpt'))
  assert.ok(client.includes("new File([blob], 'reel-recipe-cover.webp'"))
  assert.ok(client.includes('setRecipeImageFile(current => current || file)'))
  assert.ok(client.includes("formData.append("))
  assert.ok(client.includes("onSubmit={saveRecipe}"))
  const route = server.slice(server.indexOf('// TEST-only video analysis.'), server.indexOf('// Source photo bytes are requested ONLY'))
  assert.ok(route.includes('socialVideoAllowedOnTest('))
  assert.ok(route.includes('request.familyAccount'))
  assert.ok(!route.includes('database.prepare('))
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
  assert.ok(client.includes('setRecipeServings(current => !current.trim() || current === previous ? servings : current)'))
  assert.ok(client.includes('setRecipeNotes(current => !current.trim() || current === previous ? notes : current)'))
  assert.ok(client.includes('onSubmit={saveRecipe}'))
  assert.ok(client.includes('Save Recipe'))
})
