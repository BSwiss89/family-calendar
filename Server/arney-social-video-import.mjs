// TEST-only, opt-in social-video analysis. Never use on LIVE, never persist
// linked videos, screenshots, transcripts or temporary media to calendar storage.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { normalizeSocialRecipeUrl, parseSocialRecipeCaption } from './arney-social-recipe-import.mjs'

const MAX_VIDEO_BYTES = 36 * 1024 * 1024 // User-supplied recordings only
const MAX_LINK_VIDEO_BYTES = 72 * 1024 * 1024 // Temporary public link downloads
const MAX_SECONDS = 600 // Ten-minute limit
const OLLAMA = 'http://127.0.0.1:11434/api/chat'
const AUDIO_SECONDS = 18
const MAX_AUDIO_BYTES = 2 * 1024 * 1024
const MAX_COVER_INPUT_BYTES = 4 * 1024 * 1024
const MAX_COVER_OUTPUT_BYTES = 70 * 1024

export function socialVideoAllowedOnTest({ port, authMode, rootFolder } = {}) {
  return String(port) === '13002' && authMode === 'required' &&
    typeof rootFolder === 'string' &&
    /[\\/]family-calendar-test[^\\/]*$/i.test(path.resolve(rootFolder)) &&
    !/family-calendar-live/i.test(rootFolder)
}

function run(program, args, { cwd, timeoutMs = 25_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', complete = false
    const timer = setTimeout(() => child.kill(), timeoutMs)
    function finish(error) {
      if (complete) return
      complete = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(stdout.trim())
    }
    child.on('error', () => finish(new Error(program + ' is unavailable on the TEST laptop.')))
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-5000) })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000) })
    child.on('close', code => finish(code === 0 ? null : new Error(program + ' could not process this video.')))
  })
}

async function readPublicCaption(sourceUrl, folder) {
  // Read the creator's public description independently of the media download.
  // A blocked, oversized or unknown-duration video must not hide its recipe caption.
  try {
    await run('yt-dlp', [
      '--ignore-config', '--no-playlist', '--skip-download',
      '--no-warnings', '--write-info-json', '--write-thumbnail',
      '--output', path.join(folder, 'caption-only.%(ext)s'), sourceUrl,
    ], { cwd: folder, timeoutMs: 35_000 })
    const filename = path.join(folder, 'caption-only.info.json')
    const stat = await fs.stat(filename)
    if (!stat.isFile() || stat.size > 512_000) return ''
    const data = JSON.parse(await fs.readFile(filename, 'utf8'))
    return typeof data?.description === 'string' ? data.description.slice(0, 10_000) : ''
  } catch { return '' }
}

async function downloadPublicVideo(sourceUrl, folder) {
  // Only a canonical, allowlisted Instagram/Facebook URL reaches the downloader.
  // No credential store, browser cookies, playlists, user-defined arguments,
  // arbitrary remote URLs, or scraper output is exposed to the browser.
  const downloaderOutput = await run('yt-dlp', [
    '--ignore-config', '--no-playlist', '--no-progress', '--no-warnings',
    '--write-info-json', '--write-thumbnail', '--max-filesize', '72m',
    // Instagram sometimes omits duration; accept missing metadata and verify the actual file with ffprobe.
    '--match-filter', 'duration <=? 600', '--format', 'best[height<=480]/best',
    '--output', path.join(folder, 'linked-video.%(ext)s'), sourceUrl,
  ], { cwd: folder, timeoutMs: 120_000 })
  const entries = await fs.readdir(folder)
  const filename = entries.find(name => /^linked-video\.(?:mp4|m4v|mov|webm|mkv)$/i.test(name))
  // yt-dlp returns exit code 0 even when its filter skips a long Reel.
  if (!filename) {
    if (/does not pass filter/i.test(downloaderOutput))
      throw new Error('This video is longer than the 10-minute analysis limit.')
    throw new Error('yt-dlp did not save an accessible video from this link.')
  }
  let caption = ''
  try {
    const info = path.join(folder, 'linked-video.info.json')
    const stat = await fs.stat(info)
    if (stat.isFile() && stat.size <= 100_000) {
      const metadata = JSON.parse(await fs.readFile(info, 'utf8'))
      if (typeof metadata?.description === 'string')
        caption = metadata.description.slice(0, 10_000)
    }
  } catch { /* Description is optional and never trusted as a URL. */ }
  return { filename: path.join(folder, filename), caption }
}

// Use only files yt-dlp has already placed in its private temporary folder.
// Never fetch an image URL from the user or from metadata, and never expose
// arbitrary image hosts to the browser.
export async function buildSocialCoverPreview(folder, videoFilename = '', { grabFrame = null } = {}) {
  let files = []
  try { files = await fs.readdir(folder) } catch { return null }
  const coverCandidates = files
    .filter(name => /^(?:caption-only|linked-video)\.(?:webp|jpe?g|png)$/i.test(name))
    .sort((a, b) => Number(a.startsWith('caption-only')) - Number(b.startsWith('caption-only')))
  // Prefer the creator's Reel cover. Use a representative frame only when
  // no public cover was saved and an actual authorized video is available.
  const candidates = coverCandidates.map(name => ({
    filename: path.join(folder, name), source: 'Reel cover',
  }))
  if (videoFilename) {
    const frame = path.join(folder, 'recipe-cover-frame.jpg')
    try {
      if (typeof grabFrame === 'function') await grabFrame(videoFilename, frame)
      else await run('ffmpeg', [
        '-nostdin', '-loglevel', 'error', '-y', '-ss', '1', '-i', videoFilename,
        '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '5', frame,
      ], { timeoutMs: 12_000 })
      candidates.push({ filename: frame, source: 'Video frame' })
    } catch { /* A thumbnail is optional. */ }
  }
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate.filename)
      if (!stat.isFile() || stat.size < 100 || stat.size > MAX_COVER_INPUT_BYTES) continue
      const photo = sharp(candidate.filename, { limitInputPixels: 6_000_000 })
      const optimized = await photo.rotate().resize({
        width: 640, height: 640, fit: 'inside', withoutEnlargement: true,
      }).webp({ quality: 72 }).toBuffer()
      let buffer = optimized
      if (buffer.length > MAX_COVER_OUTPUT_BYTES) {
        buffer = await sharp(candidate.filename, { limitInputPixels: 6_000_000 })
          .rotate().resize({ width: 420, height: 420, fit: 'inside' })
          .webp({ quality: 58 }).toBuffer()
      }
      if (buffer.length > 0 && buffer.length <= MAX_COVER_OUTPUT_BYTES) {
        return {
          photoDataUrl: 'data:image/webp;base64,' + buffer.toString('base64'),
          photoSource: candidate.source,
        }
      }
    } catch { /* Damaged or unsupported images never block recipe extraction. */ }
  }
  return null
}

async function inspectDuration(filename) {
  const raw = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filename,
  ])
  const duration = Number(raw)
  if (!Number.isFinite(duration) || duration < 1 || duration > MAX_SECONDS)
    throw new Error('Video duration is unavailable or outside the 10-minute limit.')
  return duration
}

async function transcribeClip(filename, folder, start, seconds, stt) {
  const audio = path.join(folder, 'segment.wav')
  try {
    await run('ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-y', '-ss', String(start), '-i', filename,
      '-t', String(seconds), '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'pcm_s16le', '-f', 'wav', audio,
    ], { timeoutMs: 16_000 })
    const bytes = await fs.readFile(audio)
    if (bytes.length < 100 || bytes.length > MAX_AUDIO_BYTES) return ''
    if (!stt || typeof stt.url !== 'string' || typeof stt.token !== 'string') return ''
    const result = await fetch(stt.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + stt.token,
        'Content-Type': 'audio/wav',
        'Content-Length': String(bytes.length),
        'X-Arney-Duration-Ms': String(Math.round(seconds * 1000)),
      },
      body: bytes,
      signal: AbortSignal.timeout(16_000),
    })
    if (!result.ok) return ''
    const data = await result.json()
    return typeof data?.transcript === 'string' ? data.transcript.trim().slice(0, 2400) : ''
  } catch { return '' }
  finally { await fs.rm(audio, { force: true }).catch(() => {}) }
}

async function visibleVideoText(filename, folder, duration) {
  // Distribute frames through the whole Reel instead of only its first minute.
  const times = [Math.min(6, duration * 0.1), duration * 0.35, duration * 0.65, duration * 0.9]
  const frames = []
  for (const [i, time] of times.entries()) {
    const target = path.join(folder, 'frame-' + i + '.jpg')
    try {
      await run('ffmpeg', [
        '-nostdin', '-loglevel', 'error', '-y', '-ss', String(time),
        '-i', filename, '-frames:v', '1', '-vf', 'scale=640:-2',
        '-q:v', '6', target,
      ], { timeoutMs: 12_000 })
      const bytes = await fs.readFile(target)
      if (bytes.length > 0 && bytes.length < 800_000) frames.push(bytes.toString('base64'))
    } catch { /* Missing frames should not block the transcript. */ }
    finally { await fs.rm(target, { force: true }).catch(() => {}) }
  }
  if (!frames.length) return { text: '', framesSampled: 0, visionResponded: false }
  try {
    const response = await fetch(OLLAMA, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3-vl:4b-instruct', stream: false, think: false,
        options: { temperature: 0 },
        messages: [{
          role: 'user',
          content: 'Transcribe only clearly visible on-screen words about the recipe (ingredients, quantities, steps). Do not infer unseen objects, add measurements or invent steps. Return plain text; return empty if no recipe text is visible.',
          images: frames,
        }],
      }),
      signal: AbortSignal.timeout(40_000),
    })
    if (!response.ok) return { text: '', framesSampled: frames.length, visionResponded: false }
    const data = await response.json()
    return {
      text: typeof data?.message?.content === 'string' ? data.message.content.slice(0, 6000) : '',
      framesSampled: frames.length, visionResponded: true,
    }
  } catch { return { text: '', framesSampled: frames.length, visionResponded: false } }
}

function cleanField(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
function cleanLines(value, maxItems, maxLine) {
  const list = Array.isArray(value) ? value : []
  return list.slice(0, maxItems).map(item => cleanField(item, maxLine)).filter(Boolean).join('\n')
}

function appendVideoDetails(base, additions, maxLines, maxLength, maxChars) {
  const lines = base ? base.split('\n') : []
  const normalized = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const seen = new Set(lines.map(normalized))
  if (Array.isArray(additions)) for (const detail of additions.slice(0, maxLines)) {
    const line = cleanField(detail, maxLength)
    const key = normalized(line)
    if (!key || seen.has(key) || lines.length >= maxLines) continue
    lines.push(line)
    seen.add(key)
  }
  return lines.join('\n').slice(0, maxChars)
}

export function groundedVideoDraft({ caption = '', transcript = '', visibleText = '', structured = null } = {}) {
  const fromCaption = parseSocialRecipeCaption(caption)
  const evidence = [caption, transcript, visibleText].filter(Boolean).join('\n').slice(0, 16000)
  // Never accept model claims when there was no video or caption evidence.
  const model = evidence && structured && typeof structured === 'object' && !Array.isArray(structured)
    ? structured : {}
  const name = fromCaption.name || cleanField(model.name, 110)
  const videoEvidence = Boolean(transcript.trim() || visibleText.trim())
  const audioDraft = transcript.trim() ? parseSocialRecipeCaption(transcript.slice(0, 9000)) : null
  const screenDraft = visibleText.trim() ? parseSocialRecipeCaption(visibleText.slice(0, 6000)) : null
  const baseIngredients = fromCaption.ingredients || cleanLines(model.ingredients, 80, 260) ||
    audioDraft?.ingredients || screenDraft?.ingredients || ''
  const baseInstructions = fromCaption.instructions || cleanLines(model.instructions, 80, 500) ||
    audioDraft?.instructions || screenDraft?.instructions || ''
  // Caption is the stable baseline. Append only non-repeated details identified in
  // actual speech/frames; the model must not replace confirmed quantities or steps.
  const ingredients = videoEvidence
    ? appendVideoDetails(baseIngredients, model.videoIngredientsAdded, 80, 260, 7000)
    : baseIngredients
  const instructions = videoEvidence
    ? appendVideoDetails(baseInstructions, model.videoInstructionsAdded, 80, 500, 8000)
    : baseInstructions
  const conflicts = videoEvidence && Array.isArray(model.conflicts)
    ? model.conflicts.slice(0, 5).map(item => cleanField(item, 220)).filter(Boolean) : []
  const videoServings = videoEvidence && Number.isSafeInteger(Number(model.servings))
    ? Number(model.servings) : 0
  const servings = fromCaption.servings ||
    (videoServings >= 1 && videoServings <= 1000 ? String(videoServings) : '')
  const notes = fromCaption.notes ||
    (videoEvidence ? cleanField(model.nutritionNotes, 350) : '')
  return {
    name, ingredients, instructions, conflicts, servings, notes,
    missing: ['ingredients', 'instructions'].filter(field => !({ ingredients, instructions })[field]),
  }
}

async function structureEvidence({ caption, transcript, visibleText }) {
  if (![caption, transcript, visibleText].some(value => value?.trim())) return null
  try {
    const response = await fetch(OLLAMA, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'ministral-3:8b', stream: false, think: false,
        format: 'json', options: { temperature: 0 },
        messages: [
          { role: 'system', content: 'Extract and cross-check a cooking recipe using BOTH the public creator caption and the actual video audio/on-screen text. JSON only with fields {"name":"","ingredients":[],"instructions":[],"videoIngredientsAdded":[],"videoInstructionsAdded":[],"conflicts":[],"servings":"","nutritionNotes":""}. Base ingredients/instructions are fallback when the caption has no clear labeled sections. videoIngredientsAdded and videoInstructionsAdded must contain ONLY new details actually spoken or visible in the video but missing from the caption (never repeat a caption item). conflicts must describe only concrete disagreements between caption and video, not overwrite either source. Preserve exact measured quantities, heat, durations, servings, creator-stated macros and chronology. nutritionNotes only for nutrition explicitly stated in the evidence, otherwise empty. Do not guess unsupported steps, ingredients or amounts. Empty arrays when uncertain. Editable draft only.' },
          { role: 'user', content: 'Caption:\n' + caption.slice(0, 8000) + '\nAudio transcript:\n' + transcript.slice(0, 9000) + '\nVisible video words:\n' + visibleText.slice(0, 6000) },
        ],
      }),
      signal: AbortSignal.timeout(75_000),
    })
    if (!response.ok) return null
    const data = await response.json()
    const content = data?.message?.content
    return typeof content === 'string' ? JSON.parse(content) : null
  } catch { return null }
}

export async function analyzePublicSocialVideo({ url, caption = '', videoBuffer = null, videoMime = '' } = {}, {
  stt = null, downloader = downloadPublicVideo, captionReader = readPublicCaption,
  durationReader = inspectDuration,
  transcriber = transcribeClip, visualReader = visibleVideoText, extractor = structureEvidence,
  onProgress = null, coverReader = buildSocialCoverPreview,
} = {}) {
  const source = normalizeSocialRecipeUrl(url)
  if (typeof caption !== 'string' || caption.length > 10_000)
    throw new TypeError('The optional caption is too long.')
  if (videoBuffer !== null && (!Buffer.isBuffer(videoBuffer) || videoBuffer.length < 100 ||
      videoBuffer.length > MAX_VIDEO_BYTES || !['video/mp4', 'video/quicktime', 'video/webm'].includes(videoMime)))
    throw new TypeError('Choose an MP4, MOV, or WebM recording under 36 MB.')
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'arney-social-preview-'))
  let transcript = '', visibleText = '', recoveredCaption = '', videoAnalyzed = false, videoNotice = ''
  let audioSegmentsChecked = 0, audioSegmentsWithText = 0
  let framesSampled = 0, visionResponded = false, videoDurationSeconds = 0
  let publicVideoFile = '', publicCover = null, coverPhoto = null
  const speechServiceConfigured = Boolean(stt?.url && stt?.token)
  // Progress callbacks carry only reviewable recipe fields and human-readable
  // stage labels. Transcripts, frames and downloaded bytes remain local.
  function progress(stage, message, draft = null) {
    if (typeof onProgress !== 'function') return
    try { onProgress({ stage, message, ...(draft ? { draft } : {}) }) }
    catch { /* An unavailable streaming client must not break cleanup. */ }
  }
  try {
    progress('caption', 'Reading the creator description…')
    // Always attempt a caption read first when none was pasted, but continue to
    // analyze the video even when the caption already has a full recipe.
    if (!caption.trim()) {
      try { recoveredCaption = (await captionReader(source.url, folder)).slice(0, 10_000) }
      catch { /* Still attempt media retrieval and video extraction. */ }
    }
    const captionDraft = groundedVideoDraft({ caption: caption.trim() || recoveredCaption })
    progress('caption', (caption.trim() || recoveredCaption)
      ? 'Creator description read. Recipe fields are appearing below.'
      : 'No usable creator description yet. Checking the video for recipe details.',
      { name: captionDraft.name, ingredients: captionDraft.ingredients,
        instructions: captionDraft.instructions, servings: captionDraft.servings,
        notes: captionDraft.notes })
    let filename = ''
    progress('video', videoBuffer
      ? 'Checking the attached video…'
      : 'Retrieving the public video for speech and on-screen details…')
    if (videoBuffer) {
      filename = path.join(folder, 'uploaded-video.' +
        (videoMime === 'video/quicktime' ? 'mov' : videoMime === 'video/webm' ? 'webm' : 'mp4'))
      await fs.writeFile(filename, videoBuffer, { flag: 'wx' })
    } else {
      try {
        const fetched = await downloader(source.url, folder)
        filename = typeof fetched === 'string' ? fetched : fetched?.filename ?? ''
        if (!recoveredCaption && typeof fetched?.caption === 'string')
          recoveredCaption = fetched.caption.slice(0, 10_000)
      } catch (error) {
        videoNotice = error instanceof Error && error.message === 'This video is longer than the 10-minute analysis limit.'
          ? error.message
          : 'The public video could not be retrieved by yt-dlp on TEST. Check its availability or the downloader setup.'
      }
    }
    if (filename) {
      try {
        const stat = await fs.stat(filename)
        const maxBytes = videoBuffer ? MAX_VIDEO_BYTES : MAX_LINK_VIDEO_BYTES
        if (!stat.isFile() || stat.size < 100 || stat.size > maxBytes)
          throw new Error('Video size is invalid or exceeds the analysis limit.')
        const duration = await durationReader(filename)
        if (!Number.isFinite(duration) || duration < 1 || duration > MAX_SECONDS)
          throw new Error('Video is too long.')
        videoAnalyzed = true
        videoDurationSeconds = Math.round(duration)
        publicVideoFile = filename
        const portions = []
        const totalClips = Math.ceil(duration / AUDIO_SECONDS)
        progress('audio', 'Transcribing video audio (0 of ' + totalClips + ' sections)…')
        for (let start = 0; start < duration && start < MAX_SECONDS; start += AUDIO_SECONDS) {
          const seconds = Math.min(AUDIO_SECONDS, duration - start)
          if (seconds < 0.2) break
          const words = await transcriber(filename, folder, start, seconds, stt)
          audioSegmentsChecked++
          if (words) { portions.push(words); audioSegmentsWithText++ }
          const completed = Math.floor(start / AUDIO_SECONDS) + 1
          if (completed % 3 === 0 || completed === totalClips)
            progress('audio', 'Transcribing video audio (' + completed + ' of ' + totalClips + ' sections)…')
        }
        transcript = portions.join('\n').slice(0, 9000)
        progress('frames', transcript
          ? 'Speech captured. Checking the video for on-screen recipe details…'
          : 'No usable speech was recovered. Checking on-screen recipe details…')
        const vision = await visualReader(filename, folder, duration)
        if (typeof vision === 'string') {
          visibleText = vision
          visionResponded = Boolean(vision.trim())
        } else {
          visibleText = typeof vision?.text === 'string' ? vision.text : ''
          framesSampled = Number.isInteger(vision?.framesSampled)
            ? Math.max(0, Math.min(4, vision.framesSampled)) : 0
          visionResponded = vision?.visionResponded === true
        }
      } catch {
        videoNotice = 'The video could not be analyzed safely (maximum 10 minutes; linked video maximum 72 MB).'
      }
    }
    const recipeCaption = caption.trim() || recoveredCaption
    progress('organize', 'Comparing the caption with the video and organizing recipe details…')
    const structured = await extractor({ caption: recipeCaption, transcript, visibleText })
    const draft = groundedVideoDraft({ caption: recipeCaption, transcript, visibleText, structured })
    const baseline = groundedVideoDraft({ caption: recipeCaption })
    const count = value => value ? value.split('\n').filter(Boolean).length : 0
    const newIngredients = Math.max(0, count(draft.ingredients) - count(baseline.ingredients))
    const newInstructions = Math.max(0, count(draft.instructions) - count(baseline.instructions))
    try {
      publicCover = await coverReader(folder, publicVideoFile)
      coverPhoto = publicCover?.photoDataUrl || null
    } catch { /* Recipe drafts remain usable without a photo. */ }
    progress('draft', structured
      ? 'Video and caption comparison finished. Review the updated fields.'
      : 'The local recipe organizer returned no structured details; displaying only verified text.',
      { name: draft.name, ingredients: draft.ingredients,
        instructions: draft.instructions, servings: draft.servings, notes: draft.notes })
    const noticeParts = []
    if (recoveredCaption && !caption.trim())
      noticeParts.push('Creator description was retrieved automatically.')
    if (videoAnalyzed) {
      noticeParts.push(transcript || visibleText
        ? 'Video evidence was processed locally. Review all measurements and steps before saving.'
        : 'Video opened, but no usable speech or on-screen recipe text was recovered.')
    } else if (videoNotice) noticeParts.push(videoNotice)
    if (!videoAnalyzed && !caption.trim() && !recoveredCaption)
      noticeParts.push('Only the source link is available so far.')
    if (draft.conflicts.length)
      noticeParts.push('Check possible caption/video differences: ' + draft.conflicts.join('; ').slice(0, 600) + '.')
    if (draft.missing.length) {
      noticeParts.push('Still missing: ' + draft.missing.join(' and ') + '.')
      if (!structured) noticeParts.push('The local AI could not organize enough recipe information.')
    }
    const videoEvidencePresent = Boolean(transcript.trim() || visibleText.trim())
    const videoStatus = !videoAnalyzed
      ? 'Caption only — the video could not be analyzed.'
      : !videoEvidencePresent
        ? 'Video opened, but no recipe speech or on-screen text was recovered.'
        : structured
          ? 'Video evidence captured and compared with the caption.'
          : 'Video evidence captured; local comparison was unavailable.'
    return {
      platform: source.platform, sourceUrl: source.url,
      name: draft.name, ingredients: draft.ingredients, instructions: draft.instructions,
      servings: draft.servings, notes: draft.notes,
      missing: draft.missing, videoAnalyzed, audioTranscribed: Boolean(transcript),
      framesRead: Boolean(visibleText), suppliedCaption: Boolean(caption.trim()),
      captionRecovered: Boolean(recoveredCaption && !caption.trim()),
      photoDataUrl: coverPhoto,
      photoSource: publicCover?.photoSource ?? '',
      videoReport: {
        status: videoStatus,
        videoOpened: videoAnalyzed,
        durationSeconds: videoDurationSeconds,
        speechServiceConfigured,
        audioSegmentsChecked,
        audioSegmentsWithText,
        speechExcerpt: transcript.slice(0, 450),
        framesSampled,
        visionResponded,
        visionExcerpt: visibleText.slice(0, 450),
        comparisonCompleted: structured !== null && structured !== undefined,
        newIngredients, newInstructions,
        conflicts: draft.conflicts,
      },
      notice: noticeParts.join(' '),
    }
  } finally {
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {})
  }
}
