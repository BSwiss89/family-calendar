/**
 * Browser speech recognition adapter. Depending on the browser, speech may be
 * processed by an external speech service. Call only after informed opt-in.
 * No microphone is accessed by importing this module.
 */
export type ArneySpeechResult =
  | { kind: 'transcript'; text: string }
  | { kind: 'error'; reason: string }
  | { kind: 'empty' }

type RecognitionEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>
}
type RecognitionError = { error?: string }
type RecognitionInstance = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: RecognitionEvent) => void) | null
  onerror: ((event: RecognitionError) => void) | null
  onend: (() => void) | null
  onstart?: (() => void) | null
  onaudiostart?: (() => void) | null
  onspeechstart?: (() => void) | null
  onspeechend?: (() => void) | null
  onaudioend?: (() => void) | null
  onnomatch?: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognitionConstructor = new () => RecognitionInstance

export type ArneySpeechSession = {
  stop: () => void
  cancel: () => void
}

function getRecognition(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const browser = window as Window & {
    SpeechRecognition?: RecognitionConstructor
    webkitSpeechRecognition?: RecognitionConstructor
  }
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null
}

export function arneySpeechAvailable(): boolean {
  return getRecognition() !== null
}

/** Last attempt's browser event sequence. Never stores microphone audio or spoken words. */
const speechDiagnosticKey = 'arney:last-speech-events'
let lastSpeechEvents: string[] = []

export function getArneySpeechDiagnostics(): string[] {
  try {
    const stored = window.sessionStorage.getItem(speechDiagnosticKey)
    if (stored) {
      const parsed: unknown = JSON.parse(stored)
      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) return parsed
    }
  } catch { /* Session storage may be unavailable in private browsing. */ }
  return [...lastSpeechEvents]
}

/** Reports one final result, including any transcript returned after stop(). */
export function beginArneySpeech(
  onResult: (result: ArneySpeechResult) => void,
  onListeningChange?: (listening: boolean) => void,
): ArneySpeechSession | null {
  const Constructor = getRecognition()
  const startedAt = Date.now()
  lastSpeechEvents = []
  const record = (stage: string) => {
    lastSpeechEvents.push(`+${Date.now() - startedAt}ms ${stage}`)
    lastSpeechEvents = lastSpeechEvents.slice(-24)
    try { window.sessionStorage.setItem(speechDiagnosticKey, JSON.stringify(lastSpeechEvents)) }
    catch { /* Diagnostics are optional; recognition must still work. */ }
  }
  record('start requested')
  if (!Constructor) {
    record('recognition API unavailable')
    return null
  }

  let recognition: RecognitionInstance
  try {
    recognition = new Constructor()
  } catch {
    record('constructor failed')
    onResult({ kind: 'error', reason: 'start-failed' })
    return null
  }
  recognition.lang = typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US'
  recognition.continuous = false
  // Capture tentative Safari transcripts as well as final ones. The command
  // is still submitted only once recognition ends after button release.
  recognition.interimResults = true
  recognition.onstart = () => record('browser start')
  recognition.onaudiostart = () => record('audio start')
  recognition.onspeechstart = () => record('speech detected')
  recognition.onspeechend = () => record('speech ended')
  recognition.onaudioend = () => record('audio ended')
  recognition.onnomatch = () => record('no match')

  let finished = false
  let transcript = ''
  const finish = (result: ArneySpeechResult) => {
    if (finished) return
    finished = true
    record(result.kind === 'transcript' ? 'completed with transcript' : result.kind === 'empty' ? 'completed empty' : 'completed with error')
    onListeningChange?.(false)
    onResult(result)
  }

  recognition.onresult = event => {
    if (finished) return
    const text = Array.from(event.results)
      .map(result => result[0]?.transcript ?? '')
      .join(' ')
      .trim()
    record(text ? 'result received (nonempty)' : 'result received (empty)')
    if (text) transcript = text
  }
  recognition.onerror = event => {
    record('browser error: ' + (event.error || 'unknown'))
    finish({ kind: 'error', reason: event.error || 'unknown' })
  }
  recognition.onend = () => {
    record('browser end')
    finish(transcript ? { kind: 'transcript', text: transcript } : { kind: 'empty' })
  }

  try {
    recognition.start()
    record('start returned')
    onListeningChange?.(true)
  } catch {
    record('start threw')
    finish({ kind: 'error', reason: 'start-failed' })
    return null
  }

  return {
    stop: () => {
      if (finished) return
      record('stop requested')
      try { recognition.stop() }
      catch { finish(transcript ? { kind: 'transcript', text: transcript } : { kind: 'empty' }) }
    },
    cancel: () => {
      if (finished) return
      finished = true
      record('cancel requested')
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      try { recognition.abort() } catch { /* already stopped */ }
      onListeningChange?.(false)
    },
  }
}

/** Speech replies never send text to a paid API. */
export function speakArneyReply(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  if (typeof SpeechSynthesisUtterance === 'undefined') return
  window.speechSynthesis.cancel()
  const message = new SpeechSynthesisUtterance(text)
  message.lang = navigator.language || 'en-US'
  message.rate = 1
  window.speechSynthesis.speak(message)
}
