// OPTIONAL one-family LIVE-only notification inbox pilot.
// Does NOT send Web Push. Shared household profile selection is a display
// filter, not identity authorization. Never enable for multi-family tenants.
// No routes/schema are installed unless LIVE operator opts in at startup.
import path from 'node:path'
import { installAssignmentNotificationOutbox } from './event-assignment-notifications.mjs'
import {
  installNotificationMutationCapture, reconcileNotificationMutations,
  fieldsForAssignmentChangeMask,
} from './notification-event-mutation-capture.mjs'

function selectedPerson(db, account, now) {
  if (!account || !Number.isSafeInteger(account.id) || account.id <= 0
    || !Number.isSafeInteger(account.user_id) || account.user_id <= 0) return null
  const row = db.prepare([
    'SELECT s.selected_profile_kind AS kind,s.selected_person_id AS personId',
    'FROM family_sessions s JOIN family_users u ON u.id=s.user_id',
    'WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL',
    'AND s.expires_at>? AND u.disabled=0',
  ].join(' ')).get(account.id,account.user_id,now)
  if (!row) return null
  if (row.kind !== 'person' || !Number.isSafeInteger(row.personId)
    || row.personId <= 0 || !db.prepare('SELECT id FROM people WHERE id=?')
      .get(row.personId)) return {kind:'home',personId:null}
  return {kind:'person',personId:row.personId}
}

function parseCancelledEventJson(value) {
  if (typeof value !== 'string') return null
  try {
    const event = JSON.parse(value)
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
      typeof event.title !== 'string' || typeof event.date !== 'string' ||
      ['endDate','time','endTime','location'].some(key =>
        event[key] != null && typeof event[key] !== 'string')) return null
    return {
      title: event.title, date: event.date,
      endDate: event.endDate ?? null, time: event.time ?? null,
      endTime: event.endTime ?? null, location: event.location ?? null,
    }
  } catch { return null }
}

function latest(db, personId) {
  return db.prepare([
    'SELECT id,event_id AS eventId,kind,created_at AS createdAt,',
    'change_mask AS changeMask,cancelled_details_json AS cancelledDetailsJson',
    'FROM assignment_notification_outbox n WHERE n.person_id=?',
    // An event cancellation supersedes its earlier assignment, update and
    // unassignment alerts for this same recipient. Keep stored records and
    // acknowledgements intact; do not resurface stale alerts after confirming.
    // Notice ID ordering permits a later new event reusing an old event ID.
    "AND NOT (n.kind IN ('assigned','changed','unassigned') AND EXISTS (",
    'SELECT 1 FROM assignment_notification_outbox newer',
    'WHERE newer.person_id=n.person_id AND newer.event_id=n.event_id',
    "AND newer.kind='cancelled' AND newer.id>n.id))",
    'ORDER BY n.id DESC LIMIT 50',
  ].join(' ')).all(personId).map(({changeMask,cancelledDetailsJson,...note}) => ({
    ...note,
    // Only the authenticated selected recipient gets cancellation details.
    // This response is not the public page or a Web Push transport.
    cancelledEvent: note.kind === 'cancelled'
      ? parseCancelledEventJson(cancelledDetailsJson) : null,
    changedFields: note.kind === 'changed'
      ? fieldsForAssignmentChangeMask(changeMask) : [],
  }))
}

function page(selected, rows) {
  const notice = rows.length
    ? rows.map(row =>
      '<li>Event #' + Number(row.eventId) + ': ' +
      ({assigned:'Assigned',changed:'Updated',unassigned:'Unassigned',
        cancelled:'Cancelled'}[row.kind] || 'Changed') +
      ' (' + new Date(row.createdAt).toISOString() + ')</li>'
    ).join('')
    : '<li>No recorded notifications yet.</li>'
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>LIVE Notifications</title></head><body><main>',
    '<h1>LIVE Notification Inbox</h1>',
    '<p>This is the single-family LIVE preview, not phone push delivery.',
    'A shared login/profile picker does not establish private identity.</p>',
    '<p>Selected LIVE person ID: ' + Number(selected.personId) + '</p>',
    '<form method="post" action="/live-notification-pilot/refresh">',
    '<button type="submit">Refresh notifications from calendar changes</button>',
    '</form><ul>' + notice + '</ul>',
    '<p><a href="/">Back to LIVE Calendar</a></p>',
    '</main></body></html>',
  ].join('\n')
}

/**
 * Mount AFTER installFamilyAuth. Its existing required-mode middleware must
 * validate the session and enforce secure same-origin POST protections.
 * No current app enables this mode. It is ready for separately approved
 * LIVE-only rollout and LIVE SQLite backup/rollback rehearsal.
 */
export function installLiveNotificationInboxPilot(app, db, {
  flag = process.env.FAMILY_CALENDAR_LIVE_NOTIFICATIONS,
  port = process.env.FAMILY_CALENDAR_PORT,
  authMode = process.env.FAMILY_CALENDAR_AUTH_MODE,
  rootFolder,
  now = () => Date.now(),
} = {}) {
  if (flag === undefined || flag === '' || flag === 'disabled') return {enabled:false}
  if (flag !== 'enabled' || String(port) !== '3001' || authMode !== 'required'
    || typeof rootFolder !== 'string'
    || !/[\\/]family-calendar(?:-live(?:-[a-z0-9-]+)?)?$/i.test(path.resolve(rootFolder))
    || /family-calendar-test/i.test(rootFolder)) {
    throw new Error('LIVE notification pilot requires isolated LIVE auth, port and checkout.')
  }
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
    || !db || typeof db.prepare !== 'function' || typeof now !== 'function') {
    throw new Error('Trusted LIVE app, SQLite and clock required.')
  }
  installAssignmentNotificationOutbox(db)
  installNotificationMutationCapture(db)
  // Acknowledging in the Invitations UI is distinct from push delivery.
  // This additive LIVE-only state never mutates the delivery outbox.
  db.exec([
    'CREATE TABLE IF NOT EXISTS live_assignment_acknowledgements(',
    'notification_id INTEGER PRIMARY KEY REFERENCES assignment_notification_outbox(id),',
    'acknowledged_at INTEGER NOT NULL CHECK(acknowledged_at > 0)',
    ') STRICT;',
  ].join(' '))

  function requirePerson(request,response) {
    const selected = selectedPerson(db,request.familyAccount,now())
    if (!selected) {
      response.status(401).json({error:'Sign in to LIVE first.'})
      return null
    }
    if (selected.kind !== 'person') {
      response.status(403).json({error:'Select a person profile; Home cannot see the inbox.'})
      return null
    }
    return selected
  }

  app.get('/live-notification-pilot',(request,response)=>{
    const selected = requirePerson(request,response)
    if (!selected) return
    response.set('Cache-Control','no-store')
    // Only this LIVE inbox page needs a same-origin referrer policy:
    // native HTML form POSTs otherwise use Origin: null under no-referrer.
    // Keep family-auth's strict secure Origin validation unchanged.
    response.set('Referrer-Policy','same-origin')
    response.type('html').send(page(selected,latest(db,selected.personId)))
  })
  app.get('/api/live-notification-pilot',(request,response)=>{
    const selected = requirePerson(request,response)
    if (!selected) return
    response.set('Cache-Control','no-store')
    const hasInvitations = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_event_invitations'"
    ).get()
    // When a proposed assignment has a pending/answered RSVP record, show
    // Accept/Decline in the same Invitations screen rather than a duplicate
    // generic Acknowledge alert. Previously existing notices remain unchanged.
    const notifications = latest(db,selected.personId).filter(note => {
      if (!hasInvitations || (note.kind!=='assigned' && note.kind!=='unassigned')) return true
      return !db.prepare([
        'SELECT 1 FROM live_event_invitations WHERE event_id=? AND person_id=?',
      ].join(' ')).get(note.eventId,selected.personId)
    }).map(note => ({
      ...note,
      acknowledged: Boolean(db.prepare(
        'SELECT 1 FROM live_assignment_acknowledgements WHERE notification_id=?'
      ).get(note.id)),
    }))
    response.json({
      pilot:true,profile:'person',personId:selected.personId,
      notifications,
    })
  })
  app.post('/api/live-notification-pilot/:notificationId/acknowledge',(request,response)=>{
    const selected = requirePerson(request,response)
    if (!selected) return
    const raw = request.params.notificationId
    const id = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN
    if (!Number.isSafeInteger(id)) return response.status(400).json({error:'Invalid notification.'})
    const item = db.prepare([
      'SELECT id FROM assignment_notification_outbox WHERE id=? AND person_id=?',
    ].join(' ')).get(id,selected.personId)
    if (!item) return response.status(404).json({error:'Notification unavailable.'})
    db.prepare([
      'INSERT OR IGNORE INTO live_assignment_acknowledgements(notification_id,acknowledged_at)',
      'VALUES (?,?)',
    ].join(' ')).run(id,now())
    response.set('Cache-Control','no-store')
    response.json({acknowledged:true})
  })
  app.post('/live-notification-pilot/refresh',(request,response)=>{
    if (!requirePerson(request,response)) return
    try {
      reconcileNotificationMutations(db,{limit:100,at:now()})
      response.set('Cache-Control','no-store')
      response.redirect(303,'/live-notification-pilot')
    } catch(error) {
      console.error('LIVE notification pilot reconciliation failed:',
        error instanceof Error ? error.message : 'unknown')
      response.status(503).json({error:'LIVE notification inbox unavailable.'})
    }
  })
  return {enabled:true}
}
