/**
 * Browser speech recognition foundation for Arney.
 * Recognition availability varies by browser, OS and permission settings.
 * Some browser implementations may send audio to a cloud speech service.
 */
export type ArneySpeechResult =
  | { kind: 'transcript'; text: string }
  | { kind: 'error'; reason: string }
  | { kind: 'empty' }

type RecognitionEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> }
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

function getRecognition(): RecognitionConstructor | null {
  const browser = window as Window & {
    SpeechRecognition?: RecognitionConstructor
    webkitSpeechRecognition?: RecognitionConstructor
  }
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null
}

export function arneySpeechAvailable(): boolean {
  return typeof window !== 'undefined' && getRecognition() !== null
}

export function beginArneySpeech(
  onResult: (result: ArneySpeechResult) => void,
  onListeningChange?: (listening: boolean) => void,
): { stop: () => void; cancel: () => void } | null {
  if (!arneySpeechAvailable()) return null
  const Constructor = getRecognition()!
  const recognition = new Constructor()
  recognition.lang = navigator.language || 'en-US'
  recognition.continuous = false
  recognition.interimResults = false

  let finished = false
  let hasTranscript = false
  const finish = (result: ArneySpeechResult) => {
    if (finished) return
    finished = true
    onListeningChange?.(false)
    onResult(result)
  }

  recognition.onresult = event => {
    const transcript = Array.from(event.results)
      .map(result => result[0]?.transcript ?? '')
      .join(' ')
      .trim()
    if (transcript) {
      hasTranscript = true
      finish({ kind: 'transcript', text: transcript })
    }
  }
  recognition.onerror = event => finish({ kind: 'error', reason: event.error || 'unknown' })
  recognition.onend = () => {
    onListeningChange?.(false)
    if (!hasTranscript) finish({ kind: 'empty' })
  }

  try {
    recognition.start()
    onListeningChange?.(true)
  } catch {
    finish({ kind: 'error', reason: 'start-failed' })
  }

  return {
    stop: () => {
      if (!finished) recognition.stop()
    },
    cancel: () => {
      if (finished) return
      finished = true
      recognition.abort()
      onListeningChange?.(false)
    },
  }
}
