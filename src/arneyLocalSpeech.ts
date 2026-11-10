import type { ArneySpeechResult, ArneySpeechSession } from './arneySpeech'

type LocalSpeechDependencies = {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  Recorder?: typeof MediaRecorder
  fetchImpl?: typeof fetch
  now?: () => number
}

const preferredTypes = [
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
]

function browserDependencies(): Required<LocalSpeechDependencies> | null {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined' || typeof fetch === 'undefined') return null
  return {
    getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
    Recorder: MediaRecorder,
    fetchImpl: fetch,
    now: () => Date.now(),
  }
}

export function arneyLocalSpeechAvailable(): boolean {
  return browserDependencies() !== null
}

function recordingType(Recorder: typeof MediaRecorder): string {
  return preferredTypes.find(type => {
    try { return Recorder.isTypeSupported(type) } catch { return false }
  }) ?? ''
}

function reasonFor(error: unknown): string {
  if (error instanceof DOMException &&
      (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
    return 'microphone-permission-denied'
  }
  return 'local-recording-failed'
}

/**
 * Records one explicit hold, uploads only after release, and returns text only
 * for review. It never submits an Arney command or changes calendar data.
 */
export function beginArneyLocalSpeech(
  onResult: (result: ArneySpeechResult) => void,
  onListeningChange?: (listening: boolean) => void,
  dependencies?: LocalSpeechDependencies,
): ArneySpeechSession | null {
  const defaults = browserDependencies()
  const getUserMedia = dependencies?.getUserMedia ?? defaults?.getUserMedia
  const Recorder = dependencies?.Recorder ?? defaults?.Recorder
  const fetchImpl = dependencies?.fetchImpl ?? defaults?.fetchImpl
  const now = dependencies?.now ?? defaults?.now
  if (!getUserMedia || !Recorder || !fetchImpl || !now) return null

  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let canceled = false
  let finished = false
  let stopRequested = false
  let startedAt = 0
  let limitTimer: ReturnType<typeof setTimeout> | null = null
  const chunks: Blob[] = []

  const stopTracks = () => {
    if (limitTimer !== null) clearTimeout(limitTimer)
    limitTimer = null
    stream?.getTracks().forEach(track => {
      try { track.stop() } catch { /* already stopped */ }
    })
    stream = null
    onListeningChange?.(false)
  }

  const finish = (result: ArneySpeechResult) => {
    if (finished || canceled) return
    finished = true
    stopTracks()
    onResult(result)
  }

  const upload = async () => {
    if (canceled || finished) return
    const mimeType = recorder?.mimeType || chunks[0]?.type || 'audio/webm'
    const blob = new Blob(chunks, { type: mimeType })
    const durationMs = Math.max(0, Math.round(now() - startedAt))
    if (blob.size < 32 || durationMs < 200) {
      finish({ kind: 'empty' })
      return
    }
    const body = new FormData()
    const extension = mimeType.startsWith('audio/mp4') ? 'm4a'
      : mimeType.startsWith('audio/ogg') ? 'ogg'
        : mimeType.includes('wav') ? 'wav' : 'webm'
    body.append('durationMs', String(durationMs))
    body.append('audio', blob, `arney-recording.${extension}`)
    const uploadStartedAt = now()
    try {
      const response = await fetchImpl('/api/arney/local-transcription', {
        method: 'POST',
        body,
        credentials: 'same-origin',
      })
      let data: unknown = null
      try { data = await response.json() as unknown } catch { /* handled below */ }
      const transcript = data && typeof data === 'object' &&
        typeof (data as { transcript?: unknown }).transcript === 'string'
        ? (data as { transcript: string }).transcript.trim().slice(0, 2000) : ''
      const rawElapsedMs = data && typeof data === 'object'
        ? (data as { elapsedMs?: unknown }).elapsedMs : undefined
      const transcriptionMs = typeof rawElapsedMs === 'number' &&
        Number.isFinite(rawElapsedMs) && rawElapsedMs >= 0
        ? Math.round(rawElapsedMs) : undefined
      const totalMs = Math.max(0, Math.round(now() - uploadStartedAt))
      const timing = totalMs > 0 || transcriptionMs !== undefined
        ? { totalMs, ...(transcriptionMs !== undefined ? { transcriptionMs } : {}) }
        : undefined
      if (response.ok && transcript) finish({
        kind: 'transcript', text: transcript, ...(timing ? { timing } : {}),
      })
      else if (response.status === 422) finish({ kind: 'empty' })
      else if (response.status === 429) finish({ kind: 'error', reason: 'local-rate-limited' })
      else finish({ kind: 'error', reason: 'local-transcription-unavailable' })
    } catch {
      finish({ kind: 'error', reason: 'local-transcription-unavailable' })
    }
  }

  void getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
    .then(acquired => {
      if (canceled) {
        acquired.getTracks().forEach(track => track.stop())
        return
      }
      stream = acquired
      const mimeType = recordingType(Recorder)
      try {
        recorder = mimeType ? new Recorder(acquired, { mimeType }) : new Recorder(acquired)
      } catch (error) {
        stopTracks()
        finish({ kind: 'error', reason: reasonFor(error) })
        return
      }
      recorder.ondataavailable = event => {
        if (!canceled && event.data.size > 0) chunks.push(event.data)
      }
      recorder.onerror = () => finish({ kind: 'error', reason: 'local-recording-failed' })
      recorder.onstop = () => {
        stopTracks()
        void upload()
      }
      try {
        startedAt = now()
        recorder.start()
        onListeningChange?.(true)
        limitTimer = setTimeout(() => {
          stopRequested = true
          if (recorder?.state === 'recording') {
            try { recorder.stop() }
            catch { finish({ kind: 'error', reason: 'local-recording-failed' }) }
          }
        }, 19_500)
        if (stopRequested) recorder.stop()
      } catch (error) {
        stopTracks()
        finish({ kind: 'error', reason: reasonFor(error) })
      }
    })
    .catch(error => finish({ kind: 'error', reason: reasonFor(error) }))

  return {
    stop: () => {
      if (finished || canceled || stopRequested) return
      stopRequested = true
      if (recorder?.state === 'recording') {
        try { recorder.stop() }
        catch { finish({ kind: 'error', reason: 'local-recording-failed' }) }
      }
    },
    cancel: () => {
      if (finished || canceled) return
      canceled = true
      try {
        if (recorder?.state === 'recording') recorder.stop()
      } catch { /* cancellation remains final */ }
      chunks.length = 0
      stopTracks()
    },
  }
}


