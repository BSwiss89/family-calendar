import { useEffect, useState } from 'react'
import './HouseholdEventJoin.css'

type Props = {
  eventId: number
  selectedPersonId: number | null
  joined: boolean
  pendingInvitation?: boolean
  onReviewInvitation?: () => void
  recurring: boolean
  onChanged: () => Promise<void>
}

/**
 * TEST-only self-service participation. Profile selection is a shared-device
 * preference, not authenticated personal identity; this must stay disabled
 * until trusted person/account links exist for multi-family production.
 */
export default function HouseholdEventJoin({
  eventId,selectedPersonId,joined,pendingInvitation=false,onReviewInvitation,recurring,onChanged,
}:Props) {
  const [supported,setSupported] = useState(false)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')

  useEffect(()=>{
    let cancelled=false
    setSupported(false)
    setError('')
    if (!selectedPersonId) return
    fetch('/api/test-household-events/join-capability',{
      credentials:'same-origin',cache:'no-store',
    }).then(async response=>{
      if(!response.ok) return null
      return response.json() as Promise<{enabled?:boolean;canJoin?:boolean}>
    }).then(data=>{
      if(!cancelled) setSupported(data?.enabled===true && data?.canJoin===true)
    }).catch(()=>{if(!cancelled)setSupported(false)})
    return ()=>{cancelled=true}
  },[selectedPersonId])

  if (!supported || !selectedPersonId) return null

  async function changeMembership() {
    if(busy) return
    setBusy(true)
    setError('')
    try {
      const action=joined?'leave':'join'
      const response=await fetch('/api/test-household-events/'+eventId+'/'+action,{
        method:'POST',credentials:'same-origin',cache:'no-store',
      })
      if(!response.ok) throw new Error('Could not update your participation.')
      await onChanged()
    }catch(e) {
      setError(e instanceof Error ? e.message : 'Could not update participation.')
    }finally{setBusy(false)}
  }

  if (pendingInvitation) {
    return <section className="household-event-join" aria-label="Household participation">
      <div className="household-event-join-heading">Household invitation pending</div>
      <p>You are invited, but have not confirmed participation yet.</p>
      <button type="button" onClick={onReviewInvitation}>Review Invitation</button>
    </section>
  }

  return <section className="household-event-join" aria-label="Household participation">
    <div className="household-event-join-heading">Household participation</div>
    <p>{recurring
      ? 'Joining or leaving applies to the entire repeating series.'
      : 'Use your selected person profile to join this household event.'}</p>
    <button type="button" disabled={busy} onClick={()=>void changeMembership()}>
      {busy?'Saving…':joined?'Leave Event':'Join Event'}
    </button>
    {joined && <span className="household-event-joined">Joined</span>}
    {error && <p role="alert">{error}</p>}
  </section>
}
