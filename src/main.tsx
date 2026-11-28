import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App, { type PersonalMemberAccess } from './App.tsx'
import ArneySettingsEntry from './ArneySettingsEntry'

type Entry = { kind: 'loading' | 'pending' | 'error' | 'owner' } | { kind: 'member'; access: PersonalMemberAccess }

function CalendarEntry() {
  const [entry, setEntry] = useState<Entry>({kind:'loading'})
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      const options = {credentials:'same-origin' as const,cache:'no-store' as const,signal:controller.signal}
      const result = await fetch('/api/households/my-member-access',options)
      if(result.status===401){ window.location.assign('/login'); return }
      if(result.status===403){setEntry({kind:'pending'});return}
      // Older single-household installs do not implement this route.
      if(result.status===404||(result.ok&&!result.headers.get('content-type')?.includes('application/json'))){setEntry({kind:'owner'});return}
      if(!result.ok)throw new Error('Member access unavailable')
      const access=await result.json()
      if(access.memberType==='owner'){setEntry({kind:'owner'});return}
      if(!['adult','child'].includes(access.memberType)||!Array.isArray(access.allowedActions)||
        !access.allowedActions.every((action:unknown)=>typeof action==='string')||
        (access.linkedPersonId!==null&&(!Number.isSafeInteger(access.linkedPersonId)||access.linkedPersonId<1)))throw new Error('Invalid member access')
      const auth=await fetch('/api/auth/status',options)
      if(!auth.ok)throw new Error('Login unavailable')
      const account=await auth.json()
      if(account.authenticated!==true||typeof account.displayName!=='string')throw new Error('Login unavailable')
      setEntry({kind:'member',access:{memberType:access.memberType,allowedActions:access.allowedActions,linkedPersonId:access.linkedPersonId,displayName:account.displayName}})
    }
    void load().catch(()=>{if(!controller.signal.aborted)setEntry({kind:'error'})})
    return ()=>controller.abort()
  },[])
  if(entry.kind==='owner')return <><App/><ArneySettingsEntry/></>
  if(entry.kind==='member')return <App personalMember={entry.access}/>
  return <main style={{maxWidth:440,margin:'12vh auto',padding:24}}>
    <h1>Family Calendar</h1>
    <p>{entry.kind==='loading'?'Checking your household…':entry.kind==='pending'?'Your account is registered. Ask your household Owner to choose your Adult or Child account type, then refresh.':'Your household access could not be verified.'}</p>
    {entry.kind!=='loading'&&<><button type="button" onClick={()=>location.reload()}>Refresh</button>{' '}<a href="/account">My account</a></>}
  </main>
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><CalendarEntry/></StrictMode>,
)
