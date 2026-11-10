/** Case-insensitive, word-boundary matching prevents accidental activation. */
export function extractArneyWakeCommand(text: string): string | null {
  const normalized = text.trim()
  // Chrome often transcribes the spoken name "Arney" as "Arnie".
  // Accept only these explicit variants at the beginning of an utterance.
  const match = /^(?:(?:hey[\s,]+)?(?:arney|arnie|calendar)|computer)\b[\s,.:;!?-]*(.*)$/i.exec(normalized)
  return match ? match[1].trim() : null
}

export function shouldOfferArneyTextFallback(failures: number): boolean {
  return failures >= 3
}
