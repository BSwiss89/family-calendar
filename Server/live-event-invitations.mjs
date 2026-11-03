// LIVE-only, single-family invitation decisions in the existing calendar.
// An event assignment is a proposal until the selected family profile accepts.
// Existing events/assignments are never silently converted into invitations.
// This module must be mounted after required family-auth and stays off by default.
import path from 'node:path'

const goodId = id => Number.isSafeInteger(id) && id > 0

function safeScope({flag,port,authMode,rootFolder}) {
  return flag === 'enabled' && String(port) === '3001' &&
    authMode === 'required' && typeof rootFolder === 'string' &&
    /[\\/]family-calendar(?:-live(?:-[a-z0-9-]+)?)?$/i.test(path.resolve(rootFolder)) &&
    !/family-calendar-test/i.test(rootFolder)
}

function sessionProfile(db,account,now) {
  if (!account || !goodId(account.id) || !goodId(account.user_id)) return null
  const person = db.prepare([
    'SELECT s.id AS sessionId,s.user_id AS userId,s.selected_profile_kind AS kind,',
    's.selected_person_id AS personId',
    'FROM family_sessions s JOIN family_users u ON u.id=s.user_id',
    'WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL',
    'AND s.expires_at>? AND u.disabled=0',
  ].join(' ')).get(account.id,account.user_id,now)
  if (!person) return null
  if (person.kind !== 'person' || !goodId(person.personId) ||
    !db.prepare('SELECT 1 FROM people WHERE id=?').get(person.personId)) {
    return {...person,kind:'home',personId:null}
  }
  return person
}

export function installLiveEventInvitations(app,db,{
  flag=process.env.FAMILY_CALENDAR_LIVE_NOTIFICATIONS,
  port=process.env.FAMILY_CALENDAR_PORT,
  authMode=process.env.FAMILY_CALENDAR_AUTH_MODE,
  rootFolder,
  now=()=>Date.now(),
}={}) {
  const off={enabled:false,recordAssignments:()=>{}}
  if (flag===undefined || flag==='' || flag==='disabled') return off
  if (!safeScope({flag,port,authMode,rootFolder})) {
    throw new Error('Personal invitations are limited to required-auth isolated LIVE.')
  }
  if (!app?.get || !app?.post || !db?.exec || !db?.prepare) {
    throw new Error('LIVE invitation database or route registry unavailable.')
  }
  // Kept independent of event_people for old data compatibility; only
  // new adds from user-driven event create/edit generate pending invitations.
  db.exec([
    'CREATE TABLE IF NOT EXISTS live_event_invitations(',
    'id INTEGER PRIMARY KEY,',
    'event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,',
    'person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,',
    'invited_by_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,',
    "status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined')),",
    'created_at INTEGER NOT NULL,responded_at INTEGER,',
    'UNIQUE(event_id,person_id)',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS live_invitations_pending',
    'ON live_event_invitations(person_id,status,created_at);',
  ].join(' '))

  // Caller invokes while the same event CRUD transaction is active.
  // A self-assignment is an accepted participation, not an invitation to self.
  function recordAssignments(request,eventId,priorPeople,newPeople) {
    if (!goodId(eventId) || !Array.isArray(priorPeople) || !Array.isArray(newPeople) ||
      [...priorPeople,...newPeople].some(x=>!goodId(x))) {
      throw new Error('Invalid event invitation assignments.')
    }
    const selection=sessionProfile(db,request.familyAccount,now())
    // No authenticated profile means legacy/AI automation: do not fabricate
    // an author or silently invite recipients through a background task.
    if (!selection) return
    const prior=new Set(priorPeople)
    const desired=new Set(newPeople)
    // A removal closes pending invitations; keep declined tombstones so the
    // next explicit re-add becomes a new invitation instead of a stale RSVP.
    db.prepare([
      "DELETE FROM live_event_invitations WHERE event_id=? AND status!='declined'",
      'AND person_id NOT IN (SELECT person_id FROM event_people WHERE event_id=?)',
    ].join(' ')).run(eventId,eventId)
    const insert=db.prepare([
      'INSERT INTO live_event_invitations(',
      'event_id,person_id,invited_by_person_id,status,created_at,responded_at)',
      'VALUES (?,?,?,?,?,?) ON CONFLICT(event_id,person_id) DO UPDATE SET',
      'invited_by_person_id=excluded.invited_by_person_id,',
      'status=excluded.status,created_at=excluded.created_at,',
      'responded_at=excluded.responded_at',
    ].join(' '))
    for (const personId of desired) {
      if (prior.has(personId)) continue
      const self=selection.personId===personId
      insert.run(eventId,personId,selection.personId,self?'accepted':'pending',
        now(),self?now():null)
    }
  }

  function requirePerson(request,response) {
    const selection=sessionProfile(db,request.familyAccount,now())
    if (!selection) { response.status(401).json({error:'Sign in to LIVE first.'});return null }
    if (selection.kind!=='person') {
      response.status(403).json({error:'Select a person profile to answer event invitations.'})
      return null
    }
    return selection
  }

  app.get('/api/live-event-invitations',(request,response)=>{
    const profile=requirePerson(request,response)
    if (!profile) return
    const invitations=db.prepare([
      'SELECT i.id,i.event_id AS eventId,i.created_at AS createdAt,',
      'e.title,e.date,e.time,p.name AS invitedBy',
      'FROM live_event_invitations i',
      'JOIN events e ON e.id=i.event_id',
      'JOIN event_people ep ON ep.event_id=i.event_id AND ep.person_id=i.person_id',
      'LEFT JOIN people p ON p.id=i.invited_by_person_id',
      "WHERE i.person_id=? AND i.status='pending'",
      'ORDER BY i.created_at DESC,i.id DESC LIMIT 50',
    ].join(' ')).all(profile.personId)
    response.set('Cache-Control','no-store')
    response.json({profile:'person',personId:profile.personId,invitations})
  })

  app.post('/api/live-event-invitations/:id/respond',(request,response)=>{
    const profile=requirePerson(request,response)
    if (!profile) return
    const id=/^[1-9][0-9]*$/.test(request.params.id) ? Number(request.params.id) : NaN
    const decision=request.body?.decision
    if (!goodId(id) || !['accepted','declined'].includes(decision)) {
      return response.status(400).json({error:'Choose Accept or Decline.'})
    }
    try {
      db.exec('BEGIN IMMEDIATE')
      const entry=db.prepare([
        'SELECT id,event_id AS eventId,status FROM live_event_invitations',
        'WHERE id=? AND person_id=?',
      ].join(' ')).get(id,profile.personId)
      if (!entry || entry.status!=='pending' ||
        !db.prepare('SELECT 1 FROM event_people WHERE event_id=? AND person_id=?')
          .get(entry.eventId,profile.personId)) {
        db.exec('ROLLBACK')
        return response.status(404).json({error:'Invitation is no longer pending.'})
      }
      db.prepare([
        'UPDATE live_event_invitations SET status=?,responded_at=? WHERE id=?',
      ].join(' ')).run(decision,now(),id)
      if (decision==='declined') {
        db.prepare('DELETE FROM event_people WHERE event_id=? AND person_id=?')
          .run(entry.eventId,profile.personId)
      }
      db.exec('COMMIT')
      response.set('Cache-Control','no-store')
      response.json({decision,eventId:entry.eventId,joined:decision==='accepted'})
    } catch(error) {
      try {db.exec('ROLLBACK')} catch {}
      response.status(503).json({error:'Unable to save invitation response.'})
    }
  })
  return {enabled:true,recordAssignments}
}
