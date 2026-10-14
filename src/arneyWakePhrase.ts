/** Case-insensitive, word-boundary matching prevents accidental activation. */
export function extractArneyWakeCommand(text: string): string | null {
  const normalized = text.trim()
  const match = /^(?:hey[\s,]+arney|arney|computer)\b[\s,.:;!?-]*(.*)$/i.exec(normalized)
  return match ? match[1].trim() : null
}

export function shouldOfferArneyTextFallback(failures: number): boolean {
  return failures >= 3
}
