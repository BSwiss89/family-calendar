import type { ArneySpeechResult, ArneySpeechSession } from './arneySpeech'

type PlusHoldHandlers = {
  /** Browser recognition starts only after a deliberate hold threshold. */
  begin: (onResult: (result: ArneySpeechResult) => void) => ArneySpeechSession | null
  onHold: () => void
  onFinished: (result: ArneySpeechResult) => void
  onCanceled: () => void
  delayMs?: number
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clear?: (handle: ReturnType<typeof setTimeout>) => void
}

export type ArneyPlusHoldController = {
  down: (pointerId: number) => void
  up: (pointerId: number) => void
  cancel: (pointerId: number) => void
  consumeClick: () => boolean
  destroy: () => void
}

/**
 * Keeps normal taps separate from speech. Nothing is submitted to the AI here:
 * onFinished only supplies a transcript to the existing editable review dialog.
 */
export function createArneyPlusHoldController(handlers: PlusHoldHandlers): ArneyPlusHoldController {
  const schedule = handlers.schedule ?? ((callback, delay) => setTimeout(callback, delay))
  const clear = handlers.clear ?? (handle => clearTimeout(handle))
  let timer: ReturnType<typeof setTimeout> | null = null
  let session: ArneySpeechSession | null = null
  let pointer: number | null = null
  let generation = 0
  let held = false
  let released = false
  let finished = false
  let pending: ArneySpeechResult | null = null
  let suppressClick = false

  const clearTimer = () => {
    if (timer !== null) clear(timer)
    timer = null
  }

  function finish(result: ArneySpeechResult) {
    if (finished) return
    finished = true
    const previous = session
    session = null
    previous?.cancel()
    handlers.onFinished(result)
  }

  function destroy() {
    generation += 1
    clearTimer()
    session?.cancel()
    session = null
    pending = null
    pointer = null
    released = true
    finished = true
  }

  function down(pointerId: number) {
    if (pointer !== null || !Number.isInteger(pointerId)) return
    generation += 1
    const attempt = generation
    pointer = pointerId
    held = false
    released = false
    finished = false
    pending = null
    suppressClick = false
    timer = schedule(() => {
      timer = null
      if (generation !== attempt || pointer !== pointerId || released) return
      held = true
      suppressClick = true
      handlers.onHold()
      try {
        const started = handlers.begin(result => {
          if (generation !== attempt || finished) return
          if (!released) {
            pending = result
            return
          }
          finish(result)
        })
        if (generation !== attempt || finished) {
          started?.cancel()
          return
        }
        session = started
        if (!started && !pending) pending = { kind: 'error', reason: 'start-failed' }
      } catch {
        pending = { kind: 'error', reason: 'start-failed' }
      }
    }, handlers.delayMs ?? 375)
  }

  function up(pointerId: number) {
    if (pointer !== pointerId) return
    pointer = null
    clearTimer()
    if (!held) return // Short tap: the ordinary onClick opens Quick Add.
    released = true
    if (pending) {
      finish(pending)
    } else if (session) {
      try { session.stop() }
      catch { finish({ kind: 'error', reason: 'stop-failed' }) }
    } else {
      finish({ kind: 'error', reason: 'start-failed' })
    }
  }

  function cancel(pointerId: number) {
    if (pointer !== pointerId) return
    const wasHeld = held
    destroy()
    // Pointer cancellations must not open Quick Add or submit speech.
    suppressClick = true
    if (wasHeld) handlers.onCanceled()
  }

  function consumeClick(): boolean {
    const consumed = suppressClick
    suppressClick = false
    return consumed
  }

  return { down, up, cancel, consumeClick, destroy }
}
