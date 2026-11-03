import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FamilyEventInvitation } from './useFamilyEventInvitations'
import type { AssignmentNotice } from './useAssignmentInbox'
import './LiveInvitations.css'

type Props = {
  invitations: readonly FamilyEventInvitation[]
  notifications: readonly AssignmentNotice[]
  responseBusy: number | null
  notificationBusy: number | null
  error: string
  onRespond: (id: number, decision: 'accepted'|'declined') => Promise<boolean>
  onAcknowledge: (id: number) => Promise<boolean>
  onView: (eventId: number) => void
  eventTitle: (eventId: number) => string | null
}

function formatDate(date: string, time?: string | null) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date
  const parts = date.split('-')
  const d = new Date(Number(parts[0]),Number(parts[1])-1,Number(parts[2]))
  return d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}) +
    (time ? ' · ' + time : '')
}

function Cards({invitations,notifications,responseBusy,notificationBusy,error,onRespond,
  onAcknowledge,onView,eventTitle}: Props) {
  const labels: Record<AssignmentNotice['kind'],string> = {
    assigned:'A family event involves you',
    changed:'A family event was updated',
    unassigned:'An event assignment was removed',
    cancelled:'A family event was cancelled',
  }
  return <div className="live-invitations-list">
    {invitations.map(invite=><article key={'family-'+invite.id} className="live-invitation-card">
      <small>From {invite.invitedBy ?? 'your family'}</small>
      <strong>{invite.title}</strong>
      <p>{formatDate(invite.date,invite.time)}</p>
      <p>You're invited to participate in this event.</p>
      <div className="live-invitation-buttons">
        <button type="button" disabled={responseBusy!==null}
          onClick={()=>{void onRespond(invite.id,'accepted')}}>
          {responseBusy===invite.id?'Saving…':'Accept'}
        </button>
        <button type="button" disabled={responseBusy!==null}
          onClick={()=>{void onRespond(invite.id,'declined')}}>Decline</button>
        <button type="button" onClick={()=>onView(invite.eventId)}>View Event</button>
      </div>
    </article>)}
    {notifications.map(note=><article key={'update-'+note.id} className="live-invitation-card">
      <small>Calendar notification</small>
      <strong>{labels[note.kind]}</strong>
      <p>{eventTitle(note.eventId) ?? 'Event #'+note.eventId}</p>
      <div className="live-invitation-buttons">
        {eventTitle(note.eventId) && <button type="button"
          onClick={()=>onView(note.eventId)}>View Event</button>}
        <button type="button" disabled={notificationBusy!==null}
          onClick={()=>{void onAcknowledge(note.id)}}>
          {notificationBusy===note.id?'Saving…':'Acknowledge'}
        </button>
      </div>
    </article>)}
    {error && <p role="alert">{error}</p>}
  </div>
}

export function LiveInvitationsPage(props: Props) {
  return <section className="live-invitations-page" aria-label="Invitations">
    <h2>Invitations</h2>
    <p>Respond to events involving you, and review family calendar updates.</p>
    {props.invitations.length===0 && props.notifications.length===0
      ? <p>No pending invitations or notifications.</p> : <Cards {...props}/>}
  </section>
}

// Remind Later hides only the pop-up on this device. Invitations persist
// server-side; this is not a decline, acknowledgement or response.
export function LiveInvitationReminder(props: Props & {suppressed?:boolean}) {
  const [mobile,setMobile] = useState(()=>window.matchMedia('(max-width:760px)').matches)
  const [remindLater,setRemindLater] = useState(false)
  const seen = useRef(new Set<string>())
  useEffect(()=>{
    const media=window.matchMedia('(max-width:760px)')
    const update=()=>setMobile(media.matches)
    media.addEventListener('change',update)
    return()=>media.removeEventListener('change',update)
  },[])
  useEffect(()=>{
    const tokens=[
      ...props.invitations.map(i=>'family-'+i.id),
      ...props.notifications.map(n=>'notice-'+n.id),
    ]
    if(tokens.some(token=>!seen.current.has(token)))setRemindLater(false)
    seen.current=new Set(tokens)
  },[props.invitations,props.notifications])
  useEffect(()=>{
    const onVisible=()=>{if(document.visibilityState==='visible')setRemindLater(false)}
    document.addEventListener('visibilitychange',onVisible)
    return()=>document.removeEventListener('visibilitychange',onVisible)
  },[])
  const visible=mobile&&!props.suppressed&&!remindLater&&
    (props.invitations.length>0||props.notifications.length>0)
  useEffect(()=>{
    if(!visible)return
    const before=document.body.style.overflow
    document.body.style.overflow='hidden'
    return()=>{document.body.style.overflow=before}
  },[visible])
  if(!visible)return null
  return createPortal(<div className="live-invitation-backdrop">
    <section className="live-invitation-dialog" role="dialog" aria-modal="true"
      aria-labelledby="live-invitation-title">
      <h2 id="live-invitation-title">Family Calendar notification</h2>
      <p>Review your invitations inside the calendar.</p>
      <Cards {...props}/>
      <button type="button" className="live-remind-later"
        onClick={()=>setRemindLater(true)}>Ask Again Later</button>
    </section>
  </div>,document.body)
}
