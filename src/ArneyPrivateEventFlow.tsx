import ArneyEventDecision, {
  type ArneyEventDecisionData, type PreviewRequest, type Confirm,
} from './ArneyEventDecision'

type Props = {
  data: ArneyEventDecisionData
  onRefresh: () => Promise<unknown>
  onSuccess: () => void
  onDismiss: () => void
}

async function postPrivateEvent<T>(endpoint: string, payload: object): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const result = await response.json()
  if (!response.ok) throw Error(result.error || 'Unable to review this event.')
  return result as T
}

export default function ArneyPrivateEventFlow({data,onRefresh,onSuccess,onDismiss}: Props) {
  async function onPreview(request: PreviewRequest): Promise<Confirm> {
    // Direct preview endpoint returns a signed preview without a status field.
    // Only the text-interpreter endpoint wraps it in ready_for_confirmation.
    const result = await postPrivateEvent<Omit<Confirm, 'status'>>(
      '/api/ai/event-action-preview', request,
    )
    if (result.requiresConfirmation !== true || !result.previewToken ||
        result.action !== request.action || result.eventId !== request.eventId ||
        !result.current || !result.expiresAt) {
      throw Error('The preview did not match the selected event.')
    }
    return { ...result, status: 'ready_for_confirmation' }
  }

  async function onConfirm(token: string): Promise<void> {
    const result = await postPrivateEvent<{success:boolean}>(
      '/api/ai/event-action-confirm', {confirm:true,previewToken:token},
    )
    if (result.success !== true) throw Error('Event confirmation was not acknowledged.')
    await onRefresh()
    onSuccess()
  }

  return <ArneyEventDecision data={data} onPreview={onPreview}
    onConfirm={onConfirm} onDismiss={onDismiss} />
}
