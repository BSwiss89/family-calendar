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

/** Reports one final result, including any transcript returned after stop(). */
export function beginArneySpeech(
  onResult: (result: ArneySpeechResult) => void,
  onListeningChange?: (listening: boolean) => void,
): ArneySpeechSession | null {
  const Constructor = getRecognition()
  if (!Constructor) return null

  let recognition: RecognitionInstance
  try {
    recognition = new Constructor()
  } catch {
    onResult({ kind: 'error', reason: 'start-failed' })
    return null
  }
  recognition.lang = typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US'
  recognition.continuous = false
  recognition.interimResults = false

  let finished = false
  let transcript = ''
  const finish = (result: ArneySpeechResult) => {
    if (finished) return
    finished = true
    onListeningChange?.(false)
    onResult(result)
  }

  recognition.onresult = event => {
    if (finished) return
    const text = Array.from(event.results)
      .map(result => result[0]?.transcript ?? '')
      .join(' ')
      .trim()
    if (text) transcript = text
  }
  recognition.onerror = event => {
    finish({ kind: 'error', reason: event.error || 'unknown' })
  }
  recognition.onend = () => {
    finish(transcript ? { kind: 'transcript', text: transcript } : { kind: 'empty' })
  }

  try {
    recognition.start()
    onListeningChange?.(true)
  } catch {
    finish({ kind: 'error', reason: 'start-failed' })
    return null
  }

  return {
    stop: () => {
      if (finished) return
      try { recognition.stop() }
      catch { finish(transcript ? { kind: 'transcript', text: transcript } : { kind: 'empty' }) }
    },
    cancel: () => {
      if (finished) return
      finished = true
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
