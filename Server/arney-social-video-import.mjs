// TEST-only, opt-in social-video analysis. Never use on LIVE, never persist
// linked videos, screenshots, transcripts or temporary media to calendar storage.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizeSocialRecipeUrl, parseSocialRecipeCaption } from './arney-social-recipe-import.mjs'

const MAX_VIDEO_BYTES = 36 * 1024 * 1024
const MAX_SECONDS = 110
const OLLAMA = 'http://127.0.0.1:11434/api/chat'
const AUDIO_SECONDS = 18
const MAX_AUDIO_BYTES = 2 * 1024 * 1024

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

async function downloadPublicVideo(sourceUrl, folder) {
  // Only a canonical, allowlisted Instagram/Facebook URL reaches the downloader.
  // No credential store, browser cookies, playlists, user-defined arguments,
  // arbitrary remote URLs, or scraper output is exposed to the browser.
  await run('yt-dlp', [
    '--ignore-config', '--no-playlist', '--no-progress', '--no-warnings',
    '--write-info-json', '--no-write-thumbnail', '--max-filesize', '36m',
    '--match-filter', 'duration <= 110', '--format', 'best[height<=480]/best',
    '--output', path.join(folder, 'linked-video.%(ext)s'), sourceUrl,
  ], { cwd: folder, timeoutMs: 60_000 })
  const entries = await fs.readdir(folder)
  const filename = entries.find(name => /^linked-video\.(?:mp4|m4v|mov|webm|mkv)$/i.test(name))
  if (!filename) throw new Error('No accessible public video file was provided by this link.')
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

async function inspectDuration(filename) {
  const raw = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', filename,
  ])
  const duration = Number(raw)
  if (!Number.isFinite(duration) || duration < 1 || duration > MAX_SECONDS)
    throw new Error('Video duration is unavailable or outside the 110-second limit.')
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
  const times = [Math.min(6, duration / 3), Math.min(25, duration / 2), Math.min(55, duration * 0.8)]
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
  if (!frames.length) return ''
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
    if (!response.ok) return ''
    const data = await response.json()
    return typeof data?.message?.content === 'string' ? data.message.content.slice(0, 6000) : ''
  } catch { return '' }
}

function cleanField(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
function cleanLines(value, maxItems, maxLine) {
  const list = Array.isArray(value) ? value : []
  return list.slice(0, maxItems).map(item => cleanField(item, maxLine)).filter(Boolean).join('\n')
}

export function groundedVideoDraft({ caption = '', transcript = '', visibleText = '', structured = null } = {}) {
  const fromCaption = parseSocialRecipeCaption(caption)
  const evidence = [caption, transcript, visibleText].filter(Boolean).join('\n').slice(0, 16000)
  // Never accept model claims when there was no video or caption evidence.
  const model = evidence && structured && typeof structured === 'object' && !Array.isArray(structured)
    ? structured : {}
  const name = fromCaption.name || cleanField(model.name, 110)
  const ingredients = fromCaption.ingredients || cleanLines(model.ingredients, 80, 260)
  const instructions = fromCaption.instructions || cleanLines(model.instructions, 80, 500)
  return {
    name, ingredients, instructions,
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
          { role: 'system', content: 'Extract a cooking recipe from provided evidence. JSON only: {"name":"","ingredients":[],"instructions":[]}. Preserve exact spoken/visible measurements and chronological steps. Never guess missing quantities, ingredients, steps, cooking time, or implied technique. Omit unsupported values; empty arrays when uncertain. This is an editable draft, not a completed recipe.' },
          { role: 'user', content: 'Caption:\n' + caption.slice(0, 8000) + '\nAudio transcript:\n' + transcript.slice(0, 9000) + '\nVisible video words:\n' + visibleText.slice(0, 6000) },
        ],
      }),
      signal: AbortSignal.timeout(40_000),
    })
    if (!response.ok) return null
    const data = await response.json()
    const content = data?.message?.content
    return typeof content === 'string' ? JSON.parse(content) : null
  } catch { return null }
}

export async function analyzePublicSocialVideo({ url, caption = '', videoBuffer = null, videoMime = '' } = {}, {
  stt = null, downloader = downloadPublicVideo, durationReader = inspectDuration,
  transcriber = transcribeClip, visualReader = visibleVideoText, extractor = structureEvidence,
} = {}) {
  const source = normalizeSocialRecipeUrl(url)
  if (typeof caption !== 'string' || caption.length > 10_000)
    throw new TypeError('The optional caption is too long.')
  if (videoBuffer !== null && (!Buffer.isBuffer(videoBuffer) || videoBuffer.length < 100 ||
      videoBuffer.length > MAX_VIDEO_BYTES || !['video/mp4', 'video/quicktime', 'video/webm'].includes(videoMime)))
    throw new TypeError('Choose an MP4, MOV, or WebM recording under 36 MB.')
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'arney-social-preview-'))
  let transcript = '', visibleText = '', recoveredCaption = '', videoAnalyzed = false, videoNotice = ''
  try {
    let filename = ''
    if (videoBuffer) {
      filename = path.join(folder, 'uploaded-video.' +
        (videoMime === 'video/quicktime' ? 'mov' : videoMime === 'video/webm' ? 'webm' : 'mp4'))
      await fs.writeFile(filename, videoBuffer, { flag: 'wx' })
    } else {
      try {
        const fetched = await downloader(source.url, folder)
        filename = typeof fetched === 'string' ? fetched : fetched?.filename ?? ''
        recoveredCaption = typeof fetched?.caption === 'string' ? fetched.caption.slice(0, 10_000) : ''
      } catch {
        videoNotice = 'The platform did not provide an accessible video from this link. You can attach a screen recording instead.'
      }
    }
    if (filename) {
      try {
        const stat = await fs.stat(filename)
        if (!stat.isFile() || stat.size < 100 || stat.size > MAX_VIDEO_BYTES)
          throw new Error('Video size is invalid.')
        const duration = await durationReader(filename)
        if (!Number.isFinite(duration) || duration < 1 || duration > MAX_SECONDS)
          throw new Error('Video is too long.')
        videoAnalyzed = true
        const portions = []
        for (let start = 0; start < duration && start < 108; start += AUDIO_SECONDS) {
          const seconds = Math.min(AUDIO_SECONDS, duration - start)
          if (seconds < 0.2) break
          const words = await transcriber(filename, folder, start, seconds, stt)
          if (words) portions.push(words)
        }
        transcript = portions.join('\n').slice(0, 9000)
        visibleText = await visualReader(filename, folder, duration)
      } catch {
        videoNotice = 'The video could not be safely analyzed. Try a shorter screen recording.'
      }
    }
    const recipeCaption = caption.trim() || recoveredCaption
    const structured = await extractor({ caption: recipeCaption, transcript, visibleText })
    const draft = groundedVideoDraft({ caption: recipeCaption, transcript, visibleText, structured })
    const noticeParts = []
    if (recoveredCaption && !caption.trim())
      noticeParts.push('Creator description was retrieved automatically.')
    if (videoAnalyzed) {
      noticeParts.push(transcript || visibleText
        ? 'Video was processed locally. Check all AI-extracted measurements and steps before saving.'
        : 'Video opened, but no usable speech or on-screen recipe text was recovered.')
    } else if (videoNotice) noticeParts.push(videoNotice)
    if (!videoAnalyzed && !caption.trim()) noticeParts.push('Only the source link is available so far.')
    if (draft.missing.length) noticeParts.push('Still missing: ' + draft.missing.join(' and ') + '.')
    return {
      platform: source.platform, sourceUrl: source.url,
      name: draft.name, ingredients: draft.ingredients, instructions: draft.instructions,
      missing: draft.missing, videoAnalyzed, audioTranscribed: Boolean(transcript),
      framesRead: Boolean(visibleText), suppliedCaption: Boolean(caption.trim()),
      captionRecovered: Boolean(recoveredCaption && !caption.trim()),
      notice: noticeParts.join(' '),
    }
  } finally {
    await fs.rm(folder, { recursive: true, force: true }).catch(() => {})
  }
}
