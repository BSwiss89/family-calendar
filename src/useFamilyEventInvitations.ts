import {useEffect,useRef,useState} from 'react'

// Personal invitations share the existing Invitations view. No standalone inbox,
// separate login, or system-notification RSVP actions.
export type FamilyEventInvitation = {
  id:number
  eventId:number
  title:string
  date:string
  time:string|null
  invitedBy:string|null
  createdAt:number
}
function valid(entry:unknown):entry is FamilyEventInvitation {
  if (!entry || typeof entry!=='object') return false
  const x=entry as Record<string,unknown>
  return Number.isSafeInteger(x.id) && (x.id as number)>0 &&
    Number.isSafeInteger(x.eventId) && (x.eventId as number)>0 &&
    typeof x.title==='string' && typeof x.date==='string' &&
    (x.time===null || typeof x.time==='string') &&
    (x.invitedBy===null || typeof x.invitedBy==='string') &&
    Number.isSafeInteger(x.createdAt)
}
export function useFamilyEventInvitations(personId:number|null) {
  const [available,setAvailable]=useState(false)
  const [invitations,setInvitations]=useState<FamilyEventInvitation[]>([])
  const [respondingFamilyId,setRespondingFamilyId]=useState<number|null>(null)
  const [familyInvitationError,setFamilyInvitationError]=useState('')
  const serial=useRef(0)
  const busy=useRef(false)

  async function refresh() {
    const request=++serial.current
    if(!personId) {setAvailable(false);setInvitations([]);return}
    try {
      const response=await fetch('/api/live-event-invitations',{
        credentials:'same-origin',cache:'no-store',
      })
      if(!response.ok) throw Error('Family invitations unavailable.')
      const body:unknown=await response.json()
      if(!body || typeof body!=='object') throw Error('Invalid invitations response.')
      const x=body as {personId?:unknown;invitations?:unknown}
      if(x.personId!==personId || !Array.isArray(x.invitations) || !x.invitations.every(valid)) {
        throw Error('Current profile does not match server.')
      }
      if(request!==serial.current)return
      setAvailable(true)
      setInvitations(x.invitations)
      setFamilyInvitationError('')
    }catch {
      if(request!==serial.current)return
      setAvailable(false)
      setInvitations([])
    }
  }

  useEffect(()=>{
    void refresh()
    const onVisible=()=>{if(document.visibilityState==='visible')void refresh()}
    window.addEventListener('focus',onVisible)
    document.addEventListener('visibilitychange',onVisible)
    const interval=window.setInterval(onVisible,30000)
    return ()=>{
      serial.current++
      window.clearInterval(interval)
      window.removeEventListener('focus',onVisible)
      document.removeEventListener('visibilitychange',onVisible)
    }
    // Rebind on selected person only, not the render's local refresh closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[personId])

  async function respondFamily(id:number,decision:'accepted'|'declined') {
    if(!available || busy.current || !invitations.some(x=>x.id===id))return false
    busy.current=true
    setRespondingFamilyId(id)
    setFamilyInvitationError('')
    try {
      const response=await fetch('/api/live-event-invitations/'+id+'/respond',{
        method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({decision}),
      })
      if(!response.ok)throw Error('Could not save your invitation response.')
      setInvitations(existing=>existing.filter(x=>x.id!==id))
      return true
    }catch(e){
      setFamilyInvitationError(e instanceof Error?e.message:'Could not save your response.')
      return false
    }finally{
      busy.current=false
      setRespondingFamilyId(null)
    }
  }
  return {familyInvitesAvailable:available,familyInvitations:invitations,
    respondingFamilyId,familyInvitationError,respondFamily,refreshFamilyInvitations:refresh}
}
