// TEST-only authenticated bridge from a short browser microphone recording to
// a private loopback speech-to-text service. Audio is kept in memory here and
// is never written to the calendar database, uploads, backups, or logs.
import path from 'node:path'
import fs from 'node:fs'
import multer from 'multer'

const MAX_AUDIO_BYTES = 2 * 1024 * 1024
const MAX_DURATION_MS = 20_000
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 8
const PROTECTED_PORTS = new Set([443, 8443, 3001, 11434, 13001, 13002, 13003])
const AUDIO_TYPES = new Set([
  'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav',
])

function testLocation({ port, authMode, rootFolder }) {
  return String(port) === '13002' && authMode === 'required' &&
    typeof rootFolder === 'string' &&
    /[\\/]family-calendar-test[^\\/]*$/i.test(path.resolve(rootFolder)) &&
    !/family-calendar-live/i.test(rootFolder)
}

function installedConfiguration(configFile) {
  if (typeof configFile !== 'string' || !configFile || !fs.existsSync(configFile)) return null
  const stat = fs.statSync(configFile)
  if (!stat.isFile() || stat.size < 2 || stat.size > 4096) {
    throw new Error('Invalid local speech configuration file.')
  }
  let value
  try {
    const text = fs.readFileSync(configFile, 'utf8')
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    throw new Error('Invalid local speech configuration file.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid local speech configuration file.')
  }
  return value
}

function localServiceUrl(value) {
  let parsed
  try { parsed = new URL(value) } catch { return null }
  const port = Number(parsed.port)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
      !Number.isInteger(port) || port < 1024 || port > 65535 ||
      PROTECTED_PORTS.has(port) || parsed.pathname !== '/transcribe' ||
      parsed.username || parsed.password || parsed.search || parsed.hash) return null
  return parsed.toString()
}

function sessionKey(account) {
  if (!account || !Number.isSafeInteger(account.id) || account.id <= 0 ||
      !Number.isSafeInteger(account.user_id) || account.user_id <= 0) return null
  return `${account.user_id}:${account.id}`
}

function parseDuration(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,6}$/.test(value)) return null
  const duration = Number(value)
  return Number.isInteger(duration) && duration >= 200 && duration <= MAX_DURATION_MS
    ? duration : null
}

function audioParser() {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fields: 2, fileSize: MAX_AUDIO_BYTES },
    fileFilter(_request, file, callback) {
      if (!AUDIO_TYPES.has(file.mimetype)) {
        callback(new Error('Unsupported microphone recording format.'))
        return
      }
      callback(null, true)
    },
  }).single('audio')
  return (request, response, next) => upload(request, response, error => {
    if (!error) return next()
    response.set('Cache-Control', 'no-store')
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return response.status(413).json({ error: 'Voice recording is too large.' })
    }
    response.status(400).json({ error: 'Voice recording was not accepted.' })
  })
}

/** Mount only after required family-auth has installed its session/origin guard. */
export function installTestLocalStt(app, {
  flag = process.env.FAMILY_CALENDAR_TEST_LOCAL_STT,
  port = process.env.FAMILY_CALENDAR_PORT,
  authMode = process.env.FAMILY_CALENDAR_AUTH_MODE,
  rootFolder,
  serviceUrl = process.env.FAMILY_CALENDAR_LOCAL_STT_URL,
  serviceToken = process.env.FAMILY_CALENDAR_LOCAL_STT_TOKEN,
  configFile = process.env.FAMILY_CALENDAR_LOCAL_STT_CONFIG ??
    (process.env.PROGRAMDATA
      ? path.join(process.env.PROGRAMDATA, 'FamilyCalendar', 'LocalSTT', 'config.json')
      : null),
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutSignal = milliseconds => AbortSignal.timeout(milliseconds),
} = {}) {
  const locationAllowed = testLocation({ port, authMode, rootFolder })
  const installed = locationAllowed && (flag === undefined || flag === '')
    ? installedConfiguration(configFile) : null
  const effectiveFlag = flag || (installed?.enabled === true ? 'enabled' : 'disabled')
  const effectiveUrl = serviceUrl || installed?.serviceUrl
  const effectiveToken = serviceToken || installed?.serviceToken
  if (effectiveFlag === 'disabled') return { enabled: false }
  if (effectiveFlag !== 'enabled' || !locationAllowed) {
    throw new Error('Local speech transcription requires isolated authenticated TEST.')
  }
  const target = localServiceUrl(effectiveUrl)
  if (!target || typeof effectiveToken !== 'string' || effectiveToken.length < 32 ||
      typeof fetchImpl !== 'function' || typeof now !== 'function' ||
      typeof timeoutSignal !== 'function' || !app?.get || !app?.post) {
    throw new Error('TEST local speech transcription is not securely configured.')
  }

  const attempts = new Map()
  let active = 0

  function allowed(account) {
    const key = sessionKey(account)
    if (!key) return false
    const at = now()
    const previous = attempts.get(key)
    const record = !previous || at - previous.started >= RATE_WINDOW_MS
      ? { started: at, count: 0 }
      : previous
    record.count++
    attempts.set(key, record)
    return record.count <= RATE_MAX
  }

  app.get('/api/arney/local-transcription/status', (request, response) => {
    response.set('Cache-Control', 'no-store')
    response.json({ enabled: Boolean(sessionKey(request.familyAccount)) })
  })

  app.post('/api/arney/local-transcription', audioParser(), async (request, response) => {
    response.set('Cache-Control', 'no-store')
    if (!sessionKey(request.familyAccount)) {
      return response.status(401).json({ error: 'Sign in to TEST first.' })
    }
    if (!allowed(request.familyAccount)) {
      response.set('Retry-After', '60')
      return response.status(429).json({ error: 'Too many voice attempts. Try again shortly.' })
    }
    const durationMs = parseDuration(request.body?.durationMs)
    const file = request.file
    if (!durationMs || !file || !Buffer.isBuffer(file.buffer) || file.buffer.length < 32 ||
        !AUDIO_TYPES.has(file.mimetype)) {
      return response.status(400).json({ error: 'A valid short voice recording is required.' })
    }
    if (active >= 1) {
      response.set('Retry-After', '2')
      return response.status(503).json({ error: 'Local transcription is busy.' })
    }

    active++
    try {
      const upstream = await fetchImpl(target, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${effectiveToken}`,
          'Content-Type': file.mimetype,
          'Content-Length': String(file.buffer.length),
          'X-Arney-Duration-Ms': String(durationMs),
        },
        body: file.buffer,
        signal: timeoutSignal(15_000),
      })
      let data = null
      try { data = await upstream.json() } catch { /* fail closed below */ }
      if (!upstream.ok) {
        const status = upstream.status === 429 || upstream.status === 503 ? 503 : 502
        return response.status(status).json({ error: 'Local transcription is unavailable.' })
      }
      const transcript = typeof data?.transcript === 'string'
        ? data.transcript.trim().slice(0, 2000) : ''
      if (!transcript) return response.status(422).json({ error: 'No speech was recognized.' })
      const elapsedMs = Number.isFinite(data?.elapsedMs) && data.elapsedMs >= 0
        ? Math.round(data.elapsedMs) : undefined
      response.json({ transcript, ...(elapsedMs !== undefined ? { elapsedMs } : {}) })
    } catch (error) {
      console.error('TEST local transcription unavailable:',
        error instanceof Error ? error.name : 'unknown error')
      response.status(503).json({ error: 'Local transcription is unavailable.' })
    } finally {
      active--
    }
  })

  return { enabled: true }
}

