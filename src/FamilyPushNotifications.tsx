import { useCallback, useEffect, useRef, useState } from 'react'

// LIVE-only browser binding: the phone's existing push subscription follows the
// selected family profile. No per-person password/PIN. Home receives no pushes.
// Push alerts never accept/decline an invitation; that stays in Invitations.
type Config = {enabled: true; publicKey: string}
type Status = {enabled: true; profile: 'home' | 'person'; personId: number | null}

const supportsPush = () => (
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window &&
  window.isSecureContext
)

async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url,{
    credentials:'same-origin',cache:'no-store',...options,
  })
  if (!response.ok) throw new Error('Calendar push settings are unavailable.')
  return response.json() as Promise<T>
}

async function currentBrowserSubscription() {
  const registration = await navigator.serviceWorker.getRegistration('/')
  return registration?.pushManager.getSubscription() ?? null
}

async function bindExisting(personId: number | null) {
  if (!supportsPush() || Notification.permission !== 'granted') return false
  const subscription = await currentBrowserSubscription()
  if (!subscription) return false
  if (personId === null) {
    // Disable remote delivery for Home before unsubscribing this browser.
    try {
      await json('/api/live-push/subscriptions',{
        method:'DELETE',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({endpoint:subscription.endpoint}),
      })
    } catch { /* Server session's Home selection independently blocks delivery */ }
    return false
  }
  const status=await json<Status>('/api/live-push/status')
  if (status.profile !== 'person' || status.personId !== personId) return false
  await json('/api/live-push/subscriptions',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(subscription.toJSON()),
  })
  return true
}

export function useFamilyPush(personId: number | null) {
  const [available,setAvailable]=useState(false)
  const [subscribed,setSubscribed]=useState(false)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [help,setHelp]=useState('')
  const publicKey=useRef<string | null>(null)
  const sequence=useRef(0)

  useEffect(()=>{
    const number=++sequence.current
    setSubscribed(false)
    setAvailable(false)
    setError('')
    if (!supportsPush()) {
      setHelp('For iPhone alerts, install this calendar on your Home Screen and open it there.')
      return
    }
    if (personId===null) {
      void bindExisting(null).catch(()=>{})
      return
    }
    void (async()=>{
      try {
        const config=await json<Config>('/api/live-push/config')
        if (!config.enabled) return
        const status=await json<Status>('/api/live-push/status')
        if (status.personId !== personId || status.profile !== 'person') return
        if (number!==sequence.current) return
        publicKey.current=config.publicKey
        setAvailable(true)
        const bound=await bindExisting(personId)
        if (number===sequence.current) setSubscribed(bound)
      } catch {
        if (number===sequence.current) setAvailable(false)
      }
    })()
    return ()=>{ sequence.current++ }
  },[personId])

  const enable=useCallback(async()=>{
    if (busy || !available || !personId || !supportsPush() || !publicKey.current) return
    // Permission must be requested directly from a user tap on iOS.
    const permissionRequest=Notification.requestPermission()
    setBusy(true);setError('')
    try {
      const permission=await permissionRequest
      if (permission!=='granted') throw new Error('Notification permission was not granted.')
      const registration=await navigator.serviceWorker.register('/family-push-sw.js',{
        scope:'/',updateViaCache:'none',
      })
      const ready=await navigator.serviceWorker.ready
      const key=publicKey.current
      if (!key) throw new Error('Public push key unavailable.')
      const bytes=Uint8Array.from(
        atob(key.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-key.length%4)%4)),
        character=>character.charCodeAt(0)
      )
      const existing=await ready.pushManager.getSubscription()
      const subscription=existing || await ready.pushManager.subscribe({
        userVisibleOnly:true,applicationServerKey:bytes,
      })
      const status=await json<Status>('/api/live-push/status')
      if (status.profile!=='person' || status.personId!==personId) {
        throw new Error('Select your profile again before enabling notifications.')
      }
      await json('/api/live-push/subscriptions',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify(subscription.toJSON()),
      })
      void registration.update().catch(()=>{})
      setSubscribed(true)
    } catch (e) {
      setError(e instanceof Error?e.message:'Could not enable calendar notifications.')
    } finally {setBusy(false)}
  },[available,busy,personId])

  const disable=useCallback(async()=>{
    if(busy || !supportsPush()) return
    setBusy(true);setError('')
    try {
      const subscription=await currentBrowserSubscription()
      if(subscription) {
        await json('/api/live-push/subscriptions',{
          method:'DELETE',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({endpoint:subscription.endpoint}),
        })
        await subscription.unsubscribe()
      }
      setSubscribed(false)
    }catch(e) {
      setError(e instanceof Error?e.message:'Unable to disable push notifications.')
    }finally{setBusy(false)}
  },[busy])

  return {available,subscribed,busy,error,help,enable,disable}
}

export type FamilyPushControls = ReturnType<typeof useFamilyPush>

export function PushNotificationsControl({controls}:{controls:FamilyPushControls}) {
  if(!controls.available && !controls.help) return null
  return <section aria-label="Phone notifications" style={{
    margin:'12px 0',padding:'12px',border:'1px solid var(--border-color, #8d95a3)',
    borderRadius:'12px',
  }}>
    <strong>Phone notifications</strong>
    <p style={{margin:'6px 0',fontSize:'0.9em'}}>
      Receive an alert when a family event involves you. Open the calendar to respond.
      No decisions are made from a phone notification.
    </p>
    {controls.available && (
      <button type="button" disabled={controls.busy}
        onClick={()=>{void (controls.subscribed?controls.disable():controls.enable())}}>
        {controls.busy?'Saving…':controls.subscribed?'Turn off phone alerts':'Enable phone alerts'}
      </button>
    )}
    {controls.help && <p style={{fontSize:'0.85em'}}>{controls.help}</p>}
    {controls.error && <p role="alert">{controls.error}</p>}
    {controls.subscribed && <p>Phone alerts are enabled for this profile.</p>}
  </section>
}
