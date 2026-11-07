// LIVE-only household event Join/Leave preview. This is an expression of the
// selected shared device profile, NOT proof that a person owns an account.
// Do not enable in LIVE or a multi-household gateway without identity linkage.
import path from 'node:path'
import { captureEventMutationAttribution } from './notification-mutation-attribution.mjs'

function isSafeLiveScope({flag,port,authMode,rootFolder}) {
  return flag === 'enabled' && String(port) === '3001' &&
    authMode === 'required' && typeof rootFolder === 'string' &&
    /[\\/]family-calendar(?:-live(?:-[a-z0-9-]+)?)?$/i.test(path.resolve(rootFolder)) &&
    !/family-calendar-test/i.test(rootFolder)
}
function personForSession(db, account, now) {
  if (!account || !Number.isSafeInteger(account.id) ||
    !Number.isSafeInteger(account.user_id)) return null
  const session = db.prepare([
    'SELECT s.selected_profile_kind AS kind,s.selected_person_id AS personId',
    'FROM family_sessions s JOIN family_users u ON u.id=s.user_id',
    'WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL',
    'AND s.expires_at>? AND u.disabled=0',
  ].join(' ')).get(account.id,account.user_id,now)
  if (!session || session.kind !== 'person' ||
    !Number.isSafeInteger(session.personId) || session.personId <= 0) return null
  const person = db.prepare('SELECT id FROM people WHERE id=?').get(session.personId)
  return person ? session.personId : null
}

/** Mount AFTER required family-auth (including its strict HTTPS Origin guard). */
export function installLiveHouseholdEventJoin(app,db,{
  flag = process.env.FAMILY_CALENDAR_LIVE_NOTIFICATIONS,
  port = process.env.FAMILY_CALENDAR_PORT,
  authMode = process.env.FAMILY_CALENDAR_AUTH_MODE,
  rootFolder,
  now = () => Date.now(),
}={}) {
  if (flag === undefined || flag === '' || flag === 'disabled') return {enabled:false}
  if (!isSafeLiveScope({flag,port,authMode,rootFolder})) {
    throw new Error('Household Join preview must remain on authenticated isolated LIVE.')
  }
  if (!app?.get || !app?.post || !db?.prepare || typeof now !== 'function') {
    throw new Error('Valid LIVE application, database and clock required.')
  }

  app.get('/api/live-household-events/join-capability',(req,res)=>{
    const id = personForSession(db,req.familyAccount,now())
    res.set('Cache-Control','no-store')
    res.json({enabled:true,canJoin:id !== null})
  })

  app.post('/api/live-household-events/:eventId/join',(req,res)=>{
    const personId = personForSession(db,req.familyAccount,now())
    if (personId === null) return res.status(403).json({
      error:'Select a person profile; Home cannot join events.',
    })
    const raw = req.params.eventId
    const eventId = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN
    if (!Number.isSafeInteger(eventId)) return res.status(400).json({error:'Invalid event ID.'})
    try {
      db.exec('BEGIN IMMEDIATE')
      const event = db.prepare('SELECT id FROM events WHERE id=?').get(eventId)
      if (!event) {
        db.exec('ROLLBACK')
        return res.status(404).json({error:'Event not found.'})
      }
      const attribution = captureEventMutationAttribution(db,req,[eventId])
      const result = db.prepare(
        'INSERT OR IGNORE INTO event_people(event_id,person_id) VALUES (?,?)'
      ).run(eventId,personId)
      attribution.finish()
      db.exec('COMMIT')
      res.set('Cache-Control','no-store')
      res.json({joined:true,alreadyJoined:result.changes===0})
    } catch(error) {
      try { db.exec('ROLLBACK') } catch {}
      console.error('LIVE household join failed:',error instanceof Error ? error.message : 'unknown')
      res.status(503).json({error:'Cannot join this event right now.'})
    }
  })

  app.post('/api/live-household-events/:eventId/leave',(req,res)=>{
    const personId = personForSession(db,req.familyAccount,now())
    if (personId === null) return res.status(403).json({
      error:'Select a person profile; Home cannot leave events.',
    })
    const raw = req.params.eventId
    const eventId = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN
    if (!Number.isSafeInteger(eventId)) return res.status(400).json({error:'Invalid event ID.'})
    try {
      db.exec('BEGIN IMMEDIATE')
      const event = db.prepare('SELECT id FROM events WHERE id=?').get(eventId)
      if (!event) {
        db.exec('ROLLBACK')
        return res.status(404).json({error:'Event not found.'})
      }
      const attribution = captureEventMutationAttribution(db,req,[eventId])
      const result = db.prepare('DELETE FROM event_people WHERE event_id=? AND person_id=?')
        .run(eventId,personId)
      attribution.finish()
      db.exec('COMMIT')
      res.set('Cache-Control','no-store')
      res.json({joined:false,alreadyLeft:result.changes===0})
    } catch(error) {
      try { db.exec('ROLLBACK') } catch {}
      console.error('LIVE household leave failed:',error instanceof Error ? error.message : 'unknown')
      res.status(503).json({error:'Cannot leave this event right now.'})
    }
  })
  return {enabled:true}
}
