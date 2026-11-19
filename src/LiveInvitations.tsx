import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FamilyEventInvitation } from './useFamilyEventInvitations'
import type { AssignmentNotice, AssignmentChangeField } from './useAssignmentInbox'
import './LiveInvitations.css'

type EventDetails = {
  title: string
  date: string
  endDate: string | null
  time: string | null
  endTime: string | null
  location: string | null
  notes: string | null
  repeatUnit: string | null
  repeatInterval: number | null
  repeatEndType: string | null
  repeatEndDate: string | null
  repeatCount: number | null
}
type Props = {
  invitations: readonly FamilyEventInvitation[]
  notifications: readonly AssignmentNotice[]
  responseBusy: number | null
  notificationBusy: number | null
  error: string
  onRespond: (id: number, decision: 'accepted'|'declined') => Promise<boolean>
  onAcknowledge: (id: number) => Promise<boolean>
  onView: (eventId: number) => void
  eventDetails: (eventId: number) => EventDetails | null
}

function formatTime(time?:string|null) {
  if (!time) return 'All day'
  const match = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!match) return time
  const hours = Number(match[1])
  if (hours > 23) return time
  return (hours % 12 || 12) + ':' + match[2] + (hours < 12 ? ' AM' : ' PM')
}
function formatDate(date:string,time?:string|null) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date + (time ? ' · ' + formatTime(time) : '')
  const parts=date.split('-')
  const d=new Date(Number(parts[0]),Number(parts[1])-1,Number(parts[2]))
  return d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}) +
    ' · ' + formatTime(time)
}
const recurringFields = new Set<AssignmentChangeField>([
  'repeatUnit','repeatInterval','repeatEndType','repeatEndDate','repeatCount',
])
function repeatDescription(event:EventDetails) {
  const period:Record<string,string>={daily:'day',weekly:'week',monthly:'month',yearly:'year'}
  const unit=event.repeatUnit?.toLowerCase()||'none'
  if (unit==='none') return 'Repeats removed'
  if (!period[unit]) return 'Repeat schedule updated'
  const n=event.repeatInterval && event.repeatInterval>0 ? event.repeatInterval : 1
  let description=n===1 ? 'Every '+period[unit] : 'Every '+n+' '+period[unit]+'s'
  if(event.repeatEndType==='date'&&event.repeatEndDate)description+=' until '+formatDate(event.repeatEndDate).split(' · ')[0]
  else if(event.repeatEndType==='count'&&event.repeatCount)description+=' for '+event.repeatCount+' occurrences'
  return description
}
function changeDescription(field:AssignmentChangeField,event:EventDetails) {
  switch(field) {
    // The event heading already contains these values, so do not repeat them.
    case 'title': return 'Event name'
    case 'date': return 'Start date'
    case 'time': return 'Start time'
    case 'endDate': return 'End date: '+(event.endDate?formatDate(event.endDate).split(' · ')[0]:'Removed')
    case 'endTime': return 'End time: '+(event.endTime?formatTime(event.endTime):'Removed')
    case 'location': return 'Location: '+(event.location?.trim()||'Removed')
    case 'notes': return event.notes?.trim() ? 'Notes updated' : 'Notes removed'
    case 'occurrences': return 'Recurring dates updated'
    default: return 'Repeats: '+repeatDescription(event)
  }
}
const kindLabels:Record<AssignmentNotice['kind'],string>={
  assigned:'Added to an event',
  changed:'Event updated',
  unassigned:'Removed from an event',
  cancelled:'Event cancelled',
}

function Cards({invitations,notifications,responseBusy,notificationBusy,error,onRespond,
  onAcknowledge,onView,eventDetails,compact=false}:Props&{compact?:boolean}) {
  return <div className="live-invitations-list">
    {invitations.map(invite=><article key={'family-'+invite.id} className="live-invitation-card">
      <small>From {invite.invitedBy ?? 'your family'}</small>
      <strong>{invite.title}</strong>
      <p>{formatDate(invite.date,invite.time)}</p>
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
    {notifications.map(note=>{
      const event=eventDetails(note.eventId)
      const firstRepeatIndex=note.changedFields.findIndex(field=>recurringFields.has(field))
      const fields=note.changedFields.filter((field,index)=>
        !recurringFields.has(field)||index===firstRepeatIndex)
      return <article key={'update-'+note.id}
        className={`live-invitation-card${compact?' live-invitation-compact':''}`}>
        {!compact&&<strong className="live-notice-kind">{kindLabels[note.kind]}</strong>}
        {event ? <>
          <strong className="live-notice-event-title">{event.title}</strong>
          <p className="live-notice-date">{formatDate(event.date,event.time)}</p>
        </> : <p>Event details unavailable</p>}
        {event&&note.kind==='changed'&&fields.length>0&&
          <p className="live-notice-changes"><b>Changed:</b> {fields.map(field=>
            changeDescription(field,event)).join(' · ')}</p>}
        <div className="live-invitation-buttons">
          {event&&<button type="button" onClick={()=>onView(note.eventId)}>View Event</button>}
          <button type="button" disabled={notificationBusy!==null}
            onClick={()=>{void onAcknowledge(note.id)}}>
            {notificationBusy===note.id?'Saving…':'Acknowledge'}
          </button>
        </div>
      </article>
    })}
    {error&&<p role="alert">{error}</p>}
  </div>
}

export function LiveInvitationsPage(props:Props) {
  return <section className="live-invitations-page" aria-label="Invitations">
    <h2>Invitations</h2>
    <p>Respond to events involving you, and review family calendar updates.</p>
    {props.invitations.length===0&&props.notifications.length===0
      ? <p>No pending invitations or notifications.</p> : <Cards {...props}/>}
  </section>
}

// Remind Later and View Event dismiss only the pop-up. Neither acknowledges
// an event update or accepts/declines a household invitation.
export function LiveInvitationReminder(props:Props&{suppressed?:boolean}) {
  const [mobile,setMobile]=useState(()=>window.matchMedia('(max-width:760px)').matches)
  const [remindLater,setRemindLater]=useState(false)
  const seen=useRef(new Set<string>())
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
  const count=props.invitations.length+props.notifications.length
  const onlyUpdate=props.invitations.length===0&&props.notifications.length===1
  const heading=onlyUpdate ? kindLabels[props.notifications[0].kind]
    : count===1?'Notification':count+' notifications'
  const openFromReminder=(id:number)=>{
    setRemindLater(true)
    props.onView(id)
  }
  return createPortal(<div className="live-invitation-backdrop">
    <section className="live-invitation-dialog" role="dialog" aria-modal="true"
      aria-labelledby="live-invitation-title">
      <h2 id="live-invitation-title">{heading}</h2>
      <Cards {...props} compact={onlyUpdate} onView={openFromReminder}/>
      <button type="button" className="live-remind-later"
        onClick={()=>setRemindLater(true)}>Ask Again Later</button>
    </section>
  </div>,document.body)
}
