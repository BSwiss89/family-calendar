// Gated one-household LIVE Web Push transport. No push action buttons or RSVP.
// Device association follows the current authenticated session's chosen person;
// selecting Home or logging out prevents delivery. Not for multi-tenant release.
import path from 'node:path'
import { createHash } from 'node:crypto'
import { approvedPushEndpoint, publicVapidKey, decodeUrl64, sendWebPush } from './live-web-push-crypto.mjs'
import { reconcileNotificationMutations } from './notification-event-mutation-capture.mjs'

const isId = n => Number.isSafeInteger(n) && n > 0
const digest = endpoint => createHash('sha256').update(endpoint).digest('hex')

function scopeAllowed({flag,port,authMode,rootFolder}) {
  return flag === 'enabled' && String(port) === '3001' && authMode === 'required' &&
    typeof rootFolder === 'string' &&
    /[\\/]family-calendar(?:-live(?:-[a-z0-9-]+)?)?$/i.test(path.resolve(rootFolder)) &&
    !/family-calendar-test/i.test(rootFolder)
}

function selectedPerson(db,account,now) {
  if (!account || !isId(account.id) || !isId(account.user_id)) return null
  const row = db.prepare([
    'SELECT s.id AS sessionId,s.user_id AS userId,',
    's.selected_profile_kind AS kind,s.selected_person_id AS personId',
    'FROM family_sessions s JOIN family_users u ON u.id=s.user_id',
    'WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL',
    'AND s.expires_at>? AND u.disabled=0',
  ].join(' ')).get(account.id,account.user_id,now)
  if (!row) return null
  if (row.kind !== 'person' || !isId(row.personId) ||
      !db.prepare('SELECT id FROM people WHERE id=?').get(row.personId)) {
    return {...row,kind:'home',personId:null}
  }
  return row
}

function validatedSubscription(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !approvedPushEndpoint(input.endpoint) || !input.keys ||
      typeof input.keys !== 'object') return null
  try {
    const client = decodeUrl64(input.keys.p256dh,65)
    if (client[0] !== 4) return null
    decodeUrl64(input.keys.auth,16)
  } catch { return null }
  return {endpoint:input.endpoint,p256dh:input.keys.p256dh,auth:input.keys.auth}
}

function notificationMessage(kind,noticeId) {
  const bodies = {
    assigned:'An event involving you was added. Open your calendar to review it.',
    changed:'An event involving you was updated. Open your calendar for details.',
    unassigned:'An event assignment changed. Open your calendar for details.',
    cancelled:'An event involving you was cancelled. Open your calendar for details.',
  }
  return {title:'Family Calendar',body:bodies[kind] || bodies.changed,url:'/',
    tag:'family-event-'+noticeId}
}

export function installLiveInformationalPush(app,db,{
  flag=process.env.FAMILY_CALENDAR_LIVE_NOTIFICATIONS,
  port=process.env.FAMILY_CALENDAR_PORT,
  authMode=process.env.FAMILY_CALENDAR_AUTH_MODE,
  rootFolder,
  privateKey=process.env.FAMILY_CALENDAR_LIVE_VAPID_PRIVATE,
  subject=process.env.FAMILY_CALENDAR_LIVE_VAPID_SUBJECT,
  now=()=>Date.now(),
  send=sendWebPush,
  intervalMs=15000,
  schedule=true,
}={}) {
  if (flag === undefined || flag === '' || flag === 'disabled') return {enabled:false}
  if (!scopeAllowed({flag,port,authMode,rootFolder})) {
    throw new Error('Web Push pilot requires isolated authenticated single-family LIVE.')
  }
  if (typeof privateKey !== 'string' || typeof subject !== 'string' ||
      !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject) ||
      !db?.exec || !db?.prepare || !app?.get || !app?.post || !app?.delete) {
    throw new Error('LIVE Web Push must be explicitly configured.')
  }
  const publicKey=publicVapidKey(privateKey)

  // Existing LIVE notification inbox must be installed first. Never create a
  // parallel outbox or silently start a worker that cannot see calendar edits.
  const required=new Set(['assignment_notification_outbox',
    'notification_event_baselines','notification_dirty_events'])
  const present=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
  for(const row of present) required.delete(row.name)
  if(required.size) throw new Error('LIVE notification inbox prerequisite is missing.')

  db.exec([
    'CREATE TABLE IF NOT EXISTS live_push_subscriptions(',
    'endpoint_hash TEXT PRIMARY KEY,endpoint TEXT NOT NULL,',
    'p256dh TEXT NOT NULL,auth TEXT NOT NULL,',
    'user_id INTEGER NOT NULL,session_id INTEGER NOT NULL,',
    'person_id INTEGER NOT NULL,subscribed_at INTEGER NOT NULL',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS live_push_profiles',
    'ON live_push_subscriptions(person_id,session_id);',
    'CREATE TABLE IF NOT EXISTS live_push_deliveries(',
    'notification_id INTEGER NOT NULL,endpoint_hash TEXT NOT NULL,',
    'attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,',
    'status TEXT NOT NULL DEFAULT \'pending\',',
    'PRIMARY KEY(notification_id,endpoint_hash)',
    ') STRICT;',
  ].join(' '))

  function current(request,response,{personRequired=false}={}) {
    const person=selectedPerson(db,request.familyAccount,now())
    if (!person) { response.status(401).json({error:'Sign in to LIVE first.'});return null }
    if (personRequired && person.kind !== 'person') {
      response.status(403).json({error:'Select a person profile to enable notifications.'})
      return null
    }
    return person
  }

  app.get('/api/live-push/config',(request,response)=>{
    if (!current(request,response)) return
    response.set('Cache-Control','no-store')
    response.json({enabled:true,publicKey})
  })

  app.get('/api/live-push/status',(request,response)=>{
    const person=current(request,response)
    if (!person) return
    const row=person.personId && db.prepare([
      'SELECT COUNT(*) AS n FROM live_push_subscriptions',
      'WHERE user_id=? AND session_id=? AND person_id=?',
    ].join(' ')).get(person.userId,person.sessionId,person.personId)
    response.set('Cache-Control','no-store')
    response.json({enabled:true,profile:person.kind,personId:person.personId,
      activeDeviceSubscriptions:row?.n || 0})
  })

  app.post('/api/live-push/subscriptions',(request,response)=>{
    const person=current(request,response,{personRequired:true})
    if (!person) return
    const value=validatedSubscription(request.body)
    if (!value) return response.status(400).json({error:'Invalid browser push subscription.'})
    const at=now()
    db.prepare([
      'INSERT INTO live_push_subscriptions(',
      'endpoint_hash,endpoint,p256dh,auth,user_id,session_id,person_id,subscribed_at)',
      'VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(endpoint_hash) DO UPDATE SET',
      'endpoint=excluded.endpoint,p256dh=excluded.p256dh,auth=excluded.auth,',
      'user_id=excluded.user_id,session_id=excluded.session_id,',
      'person_id=excluded.person_id,subscribed_at=excluded.subscribed_at',
    ].join(' ')).run(digest(value.endpoint),value.endpoint,value.p256dh,value.auth,
      person.userId,person.sessionId,person.personId,at)
    response.set('Cache-Control','no-store')
    response.json({registered:true,personId:person.personId})
  })

  app.delete('/api/live-push/subscriptions',(request,response)=>{
    const person=current(request,response)
    if (!person) return
    const endpoint=request.body?.endpoint
    if (!approvedPushEndpoint(endpoint)) {
      return response.status(400).json({error:'Invalid push endpoint.'})
    }
    const removed=db.prepare([
      'DELETE FROM live_push_subscriptions WHERE endpoint_hash=? AND user_id=?',
    ].join(' ')).run(digest(endpoint),person.userId).changes
    response.set('Cache-Control','no-store')
    response.json({removed:removed>0})
  })

  let working=false
  async function tick() {
    if (working) return {skipped:true}
    working=true
    try {
      // Reconcile independently of whether any browser has the calendar open.
      // The existing LIVE outbox records intents; no private event text leaves.
      reconcileNotificationMutations(db,{limit:100,at:now()})
      const invitationTable=db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_event_invitations'"
      ).get()
      // The creator is already participating, so exclude their own new-event
      // assignment push. Invited relatives still receive the alert.
      const inviteJoin=invitationTable
        ? "LEFT JOIN live_event_invitations ei ON ei.event_id=n.event_id AND ei.person_id=n.person_id"
        : ""
      // An RSVP already answered in the calendar should never trigger
      // a redundant "assigned" alert, and declining should never cause a
      // separate "you were removed" phone notification.
      const suppressAnswered=invitationTable
        ? "AND NOT (n.kind='assigned' AND ei.responded_at IS NOT NULL)" +
          " AND NOT (n.kind='unassigned' AND COALESCE(ei.status,'')='declined')"
        : ""
      const entries=db.prepare([
        'SELECT n.id AS noticeId,n.kind,s.endpoint_hash AS endpointHash,',
        's.endpoint,s.p256dh,s.auth',
        'FROM assignment_notification_outbox n',
        'JOIN live_push_subscriptions s ON s.person_id=n.person_id',
        'JOIN family_sessions fs ON fs.id=s.session_id AND fs.user_id=s.user_id',
        'JOIN family_users fu ON fu.id=s.user_id',
        'LEFT JOIN live_push_deliveries d ON d.notification_id=n.id',
        'AND d.endpoint_hash=s.endpoint_hash',
        inviteJoin,
        'WHERE n.created_at>=s.subscribed_at AND fs.revoked_at IS NULL',
        'AND fs.expires_at>? AND fs.selected_profile_kind=\'person\'',
        'AND fs.selected_person_id=s.person_id AND fu.disabled=0',
        suppressAnswered,
        'AND (d.status IS NULL OR (d.status=\'pending\' AND d.attempts<3',
        'AND d.next_attempt<=?))',
        'ORDER BY n.id,s.endpoint_hash LIMIT 20',
      ].join(' ')).all(now(),now())
      let accepted=0
      for(const entry of entries) {
        // Recheck after awaiting another send, including Home/profile switch.
        const valid=db.prepare([
          'SELECT 1 FROM live_push_subscriptions s',
          'JOIN family_sessions fs ON fs.id=s.session_id AND fs.user_id=s.user_id',
          'WHERE s.endpoint_hash=? AND s.endpoint=? AND fs.revoked_at IS NULL',
          'AND fs.expires_at>? AND fs.selected_profile_kind=\'person\'',
          'AND fs.selected_person_id=s.person_id',
        ].join(' ')).get(entry.endpointHash,entry.endpoint,now())
        if (!valid) continue
        let status=0
        try {
          status=await send(entry,notificationMessage(entry.kind,entry.noticeId),{privateKey,subject})
        } catch { /* best effort, bounded retry; do not log endpoint or token */ }
        if (status===404 || status===410) {
          db.prepare('DELETE FROM live_push_subscriptions WHERE endpoint_hash=?')
            .run(entry.endpointHash)
        }
        const delivered=status>=200 && status<300
        const permanent=delivered || status===404 || status===410 || status===400 || status===401 || status===403
        db.prepare([
          'INSERT INTO live_push_deliveries(notification_id,endpoint_hash,attempts,next_attempt,status)',
          'VALUES (?,?,1,?,?) ON CONFLICT(notification_id,endpoint_hash) DO UPDATE SET',
          'attempts=attempts+1,next_attempt=excluded.next_attempt,status=excluded.status',
        ].join(' ')).run(entry.noticeId,entry.endpointHash,now()+60000,
          permanent?(delivered?'accepted':'discarded'):'pending')
        if (delivered) accepted++
      }
      return {processed:entries.length,accepted}
    } finally { working=false }
  }

  const timer=schedule?setInterval(()=>{
    void tick().catch(()=>{ /* LIVE-only worker retries; no endpoint logging */ })
  },intervalMs):null
  timer?.unref?.()
  return {enabled:true,publicKey,tick,close:()=>{if(timer)clearInterval(timer)}}
}
