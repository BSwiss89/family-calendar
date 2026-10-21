// Only explicit event changes enter the authenticated, signed-preview flow.
export function isPrivateArneyEventCandidate(input) {
  if (typeof input !== 'string' || input.length > 500) return false
  const text = input.trim()
    .replace(/^(?:(?:hey[\s,]+)?(?:arney|arnie|calendar)|computer)\b[\s,.:;!?-]*/i, '')
    .replace(/^please\s+/i, '')
  return /^(?:cancel|delete|remove|move|reschedule)\s+/i.test(text)
}
