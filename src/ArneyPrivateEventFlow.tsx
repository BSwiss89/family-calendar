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
    const result = await postPrivateEvent<Confirm>('/api/ai/event-action-preview', request)
    if (result.status !== 'ready_for_confirmation' ||
        result.requiresConfirmation !== true || !result.previewToken ||
        result.action !== request.action || result.eventId !== request.eventId) {
      throw Error('The preview did not match the selected event.')
    }
    return result
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
