// Private-household Arney event decision contract.
// It never performs an event mutation. Selection produces a NEW preview request
// that the server must authenticate and sign after rereading the selected event.
export function selectionPreviewRequest(result, chosenId) {
  if (result?.status !== 'needs_selection' || result.readOnly !== true ||
      result.requiresSelection !== true || !Array.isArray(result.options) ||
      !Number.isSafeInteger(chosenId) || chosenId < 1) return null
  const matches = result.options.filter(option => option.eventId === chosenId)
  if (matches.length !== 1 || matches[0].supported !== true) return null
  const proposal = result.previewRequest
  if (!proposal || !['cancel', 'reschedule'].includes(proposal.action) ||
      proposal.action !== result.action) return null
  return {
    action: proposal.action,
    eventId: chosenId,
    ...(proposal.action === 'reschedule' && proposal.newDate
      ? { newDate: proposal.newDate } : {}),
    ...(proposal.action === 'reschedule' && Object.hasOwn(proposal, 'newTime')
      ? { newTime: proposal.newTime } : {}),
  }
}
