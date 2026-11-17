// TEST-only OCR over a public video's complete timeline. No remote OCR, paid
// service, browser cookies or permanent storage. All frame files live inside the
// calling preview's private temporary directory and are deleted by its finally.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const MAX_FRAMES = 300
const OCR_BUDGET_MS = 115_000

export function timelineSamplingPlan(duration) {
  if (!Number.isFinite(duration) || duration < 1 || duration > 600)
    return { fps: 0, maxFrames: 0, plannedFrames: 0 }
  // Short instructional Reels get two checks every second; longer clips are
  // scanned across their entire duration at a bounded rate, never just the
  // first minute. This is timeline sampling, not a claim to inspect every frame.
  const fps = duration <= 120 ? 2 : duration <= 300 ? 1 : 0.5
  return { fps, maxFrames: MAX_FRAMES,
    plannedFrames: Math.min(MAX_FRAMES, Math.ceil(duration * fps)) }
}

export function normalizeScreenText(text = '') {
  return String(text).toLowerCase().normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

function sameScreenText(first, second) {
  const a = normalizeScreenText(first), b = normalizeScreenText(second)
  if (!a || !b) return false
  if (a === b) return true
  // Numbers are especially important for recipe text. A changed cooking
  // time or oven temperature must never be discarded as a "near duplicate".
  const numbers = text => (normalizeScreenText(text).match(/\d+/g) || []).join('|')
  if (numbers(first) !== numbers(second)) return false
  const wordsA = new Set(a.split(' ')), wordsB = new Set(b.split(' '))
  const overlap = [...wordsA].filter(word => wordsB.has(word)).length
  const similarity = overlap / Math.max(wordsA.size, wordsB.size)
  return similarity >= 0.9 && Math.abs(a.length - b.length) < 16
}

export function collectDistinctScreenText(rows = [], maxEvents = 90) {
  const events = []
  for (const row of rows) {
    const content = String(row?.text || '').replace(/\r/g, '')
      .split('\n').map(line => line.replace(/\s+/g, ' ').trim())
      .filter(line => line.length >= 3 && line.length < 165)
      .slice(0, 16).join('\n').slice(0, 850)
    if (!/[a-zA-Z]{2}/.test(content)) continue
    if (events.length && sameScreenText(events.at(-1).text, content)) continue
    events.push({ time: Number(row.time) || 0,
      frameIndex: Number.isInteger(row.frameIndex) ? row.frameIndex : 0,
      text: content })
  }
  if (events.length <= maxEvents) return events
  // Never stop reading at the first 90 text changes. Prioritize measured oven
  // settings and spread the rest across the *entire* video timeline.
  const measured = events.map((row,index)=>({row,index}))
    .filter(({row})=>/\b(?:oven|bake|roast|preheat)\b/i.test(row.text) &&
      /\d/.test(row.text) ||
      /\b\d+(?:[.,]\d+)?\s*(?:g|kg|ml|oz|lb|tsp|tbsp|cups?)\b/i.test(row.text))
  const even = (items,n)=>Array.from({length:n},(_,i)=>
    items[Math.min(items.length-1,Math.floor((i+0.5)*items.length/n))])
  const kept = new Set(even(measured,Math.min(36,measured.length,maxEvents)).map(item=>item.index))
  for (const item of even(events.map((row,index)=>({row,index})),maxEvents))
    if (kept.size < maxEvents) kept.add(item.index)
  // If the timeline grid overlapped important settings, fill with other frames.
  for (const item of events.map((row,index)=>({row,index}))) {
    if (kept.size >= maxEvents) break
    kept.add(item.index)
  }
  return [...kept].sort((a,b)=>a-b).map(index=>events[index])
}

// Condense repeated/noisy OCR into a chronological, ingredient-and-cooking
// focused evidence stream. Unlike raw per-frame OCR, this fits the local model
// input without discarding the entire second half of the Reel.
export function compactRecipeScreenEvidence(events = [], maxChars = 10_500) {
  const cue = /\b(?:oven|bake|roast|preheat|grill|fry|cook|boil|simmer|mix|stir|whisk|flip|turn|halfway|add|pour|combine|drain|chop|slice|cut|squeeze|serve|spray|line|season|toss|marinate|cream|pasta|rice|chicken|beef|pork|onion|garlic|parmesan|cheese|butter|oil|sauce|tomato|flour|milk|water|salt|pepper|paprika|seasoning|spice|parsley|topping|ingredients?|instructions?|minutes?|mins?|seconds?|grams?|tsp|tbsp|cups?)\b|\b\d+(?:[.,]\d+)?\s*(?:g|kg|ml|oz|lb|°?\s*[CF])\b/i
  const selected = []
  for (const event of events) {
    const lines = String(event.text||'').split('\n')
      .map(x=>x.replace(/\s+/g,' ').trim())
      .filter(x=>x.length>=4 && x.length<=120 && cue.test(x) &&
        (x.match(/[a-zA-Z]/g)||[]).length>=3)
      .slice(0,8)
    if (!lines.length) continue
    const text = lines.join('; ').slice(0,240)
    const normalized = normalizeScreenText(text)
    if (selected.length && selected.at(-1).key===normalized) continue
    const priority = /\b(?:oven|bake|roast)\b|[12]\d{2}\s*°?\s*C|\b\d+\s*[-–]\s*\d+\s*min/i.test(text)
      ? 2 : /\b\d+(?:[.,]\d+)?\s*(?:g|kg|ml|oz|lb|tsp|tbsp|cups?)\b/i.test(text) ? 1 : 0
    selected.push({time:event.time,key:normalized,text,priority})
  }
  if (!selected.length) return ''
  // Reserve space for measured actions and sample the rest across the entire
  // timeline. Never let dozens of noisy early frames hide late instructions.
  const maxEvents=Math.min(70,selected.length)
  const weighted=selected.map((item,index)=>({index,priority:item.priority}))
  const measured=weighted.filter(item=>item.priority>0)
  const sample=(values,n)=> n<=0?[]:Array.from({length:n},(_,i)=>
    values[Math.min(values.length-1,Math.floor((i+0.5)*values.length/n))])
  const kept=new Set(sample(measured,Math.min(35,measured.length,maxEvents)).map(x=>x.index))
  for(const item of sample(weighted,maxEvents)) {
    if(kept.size>=maxEvents)break
    kept.add(item.index)
  }
  for(const item of weighted) {
    if(kept.size>=maxEvents)break
    kept.add(item.index)
  }
  let output=''
  for(const index of [...kept].sort((a,b)=>a-b)) {
    const item=selected[index]
    const line='On-screen OCR at '+item.time+'s:\n'+item.text+'\n'
    if(output.length+line.length>maxChars)continue
    output+=line
  }
  return output.trim()
}

export function selectTimelineVisualIndices(frameCount, events = [], maxImages = 16) {
  if (!Number.isInteger(frameCount) || frameCount <= 0) return []
  const count = Math.min(Math.max(1, maxImages), frameCount)
  const picks = new Set()
  const keyIndices = [...new Set(events.map(row => row.frameIndex)
    .filter(i => Number.isInteger(i) && i >= 0 && i < frameCount))]
  // Reserve four overview frames so the vision model also observes cooking
  // actions that never appeared in OCR.
  const eventLimit = Math.max(0, count - Math.min(4, count))
  const evenly = (values, n) => Array.from({length:n}, (_,i) =>
    values[Math.min(values.length - 1, Math.floor((i + 0.5) * values.length / n))])
  if (keyIndices.length) for (const i of evenly(keyIndices,Math.min(eventLimit,keyIndices.length))) picks.add(i)
  const overview = Array.from({length:frameCount}, (_,i)=>i)
  for (const i of evenly(overview, Math.min(4,count))) picks.add(i)
  for (const i of evenly(overview,count)) {
    if (picks.size >= count) break
    picks.add(i)
  }
  return [...picks].sort((a,b)=>a-b)
}

function tool(program, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'],
    })
    let stdout = '', stderr = '', ended = false, timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    const finish = (error) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(stdout.trim())
    }
    child.on('error', () => finish(new Error('Local video tool unavailable.')))
    child.stdout.on('data', data => { stdout = (stdout + String(data)).slice(-3500) })
    child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-400) })
    child.on('close', code => finish(code === 0 && !timedOut
      ? null : new Error(timedOut ? 'Local video tool timeout.' : 'Local video tool failed.')))
  })
}

async function tesseractCommand() {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files','Tesseract-OCR','tesseract.exe'),
      'tesseract']
    : ['tesseract']
  for (const program of candidates) {
    try {
      if (path.isAbsolute(program)) await fs.access(program)
      await tool(program,['--version'],{timeoutMs:4000})
      return program
    } catch { /* Optional local binary; visual Qwen fallback remains available. */ }
  }
  return ''
}

async function recognizeFrame(program, frame, output) {
  // Preserve the original color/outlined subtitles: aggressive grayscale
  // sharpening can erase small hyphenated cook times (e.g. "22-25 Min").
  // Only retry with enhanced contrast if the original OCR looks sparse.
  let original = ''
  try { original = await tool(program,[frame,'stdout','--psm','11','-l','eng'],{timeoutMs:5000}) }
  catch { /* Try enhancement only when the original could not be read. */ }
  if (original.trim().length >= 45) return original
  try {
    await sharp(frame,{limitInputPixels:5_000_000})
      .resize({width:1280,withoutEnlargement:false})
      .grayscale().normalize().sharpen()
      .png().toFile(output)
    const enhanced = await tool(program,[output,'stdout','--psm','11','-l','eng'],{timeoutMs:5000})
    // Do not discard the original reading when it has a temperature or time.
    const cookingScore = text =>
      Number(/\b(?:oven|bake|roast|mix|stir|add)\b/i.test(text))*20 +
      Number(/\d+\s*°?\s*[CF]\b/i.test(text))*20 +
      Number(/\d+\s*(?:[-–]\s*\d+)?\s*['’]?\s*min\b/i.test(text))*20 +
      Math.min(40,text.trim().length)
    return cookingScore(enhanced)>cookingScore(original) ? enhanced : original
  } catch { return original }
  finally { await fs.rm(output,{force:true}).catch(()=>{}) }
}

export async function scanVideoTimeline(filename, folder, duration, { onProgress = null } = {}) {
  const plan = timelineSamplingPlan(duration)
  const result = {
    frames: [], events: [], framesChecked: 0, ocrFramesRead: 0,
    ocrScreensDetected: 0, ocrEventsRetained: 0, ocrEventsCapped: false,
    ocrAvailable: false, ocrPartial: false,
    plannedFrames: plan.plannedFrames,
  }
  if (!plan.fps) return result
  const scanDir = path.join(folder,'timeline-scan')
  await fs.mkdir(scanDir,{recursive:true})
  const output = path.join(scanDir,'frame-%05d.jpg')
  try {
    await tool('ffmpeg',[
      '-nostdin','-loglevel','error','-y','-i',filename,
      '-vf','fps='+String(plan.fps)+',scale=960:-2','-q:v','5',
      '-frames:v',String(plan.maxFrames),output,
    ],{timeoutMs:90_000})
  } catch { return result }
  const files = (await fs.readdir(scanDir)).filter(name=>/^frame-\d{5}\.jpg$/.test(name)).sort()
  result.frames = files.slice(0,MAX_FRAMES).map((name,index)=>({
    filename:path.join(scanDir,name),index,time:Number(((index+0.5)/plan.fps).toFixed(2)),
  }))
  result.framesChecked = result.frames.length
  if (!result.frames.length) return result
  if (typeof onProgress==='function') onProgress('Checking '+result.framesChecked+' timeline frames for on-screen recipe text…')
  const ocr = await tesseractCommand()
  if (!ocr) return result
  result.ocrAvailable = true
  const started = Date.now()
  const rows = []
  const preprocessed = path.join(scanDir,'ocr-working.png')
  for (const frame of result.frames) {
    if (Date.now()-started > OCR_BUDGET_MS) {
      result.ocrPartial = true
      break
    }
    result.ocrFramesRead++
    try {
      const text = await recognizeFrame(ocr,frame.filename,preprocessed)
      rows.push({time:frame.time,frameIndex:frame.index,text})
    } catch { /* Unreadable frame is not evidence of missing recipe text. */ }
    if (typeof onProgress==='function' &&
        (result.ocrFramesRead % 40 === 0 || result.ocrFramesRead === result.frames.length))
      onProgress('Reading video text ('+result.ocrFramesRead+' of '+result.frames.length+' timeline frames)…')
  }
  result.ocrPartial ||= result.ocrFramesRead < result.frames.length
  const allDistinct = collectDistinctScreenText(rows, MAX_FRAMES)
  result.events = collectDistinctScreenText(rows)
  // 'partial' means frames were actually skipped due to timeout, not merely
  // that noisy OCR variants were condensed for the local model.
  result.ocrScreensDetected = allDistinct.length
  result.ocrEventsRetained = result.events.length
  result.ocrEventsCapped = allDistinct.length > result.events.length
  return result
}
