// OPTIONAL one-family TEST-only notification inbox pilot.
// Does NOT send Web Push. Shared household profile selection is a display
// filter, not identity authorization. Never enable for multi-family tenants.
// No routes/schema are installed unless TEST operator opts in at startup.
import path from 'node:path'
import { installAssignmentNotificationOutbox } from './event-assignment-notifications.mjs'
import {
  installNotificationMutationCapture, reconcileNotificationMutations,
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

function latest(db, personId) {
  return db.prepare([
    'SELECT id,event_id AS eventId,kind,created_at AS createdAt',
    'FROM assignment_notification_outbox WHERE person_id=?',
    'ORDER BY id DESC LIMIT 50',
  ].join(' ')).all(personId)
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
    '<title>TEST Notifications</title></head><body><main>',
    '<h1>TEST Notification Inbox</h1>',
    '<p>This is the single-family TEST preview, not phone push delivery.',
    'A shared login/profile picker does not establish private identity.</p>',
    '<p>Selected TEST person ID: ' + Number(selected.personId) + '</p>',
    '<form method="post" action="/test-notification-pilot/refresh">',
    '<button type="submit">Refresh notifications from calendar changes</button>',
    '</form><ul>' + notice + '</ul>',
    '<p><a href="/">Back to TEST Calendar</a></p>',
    '</main></body></html>',
  ].join('\n')
}

/**
 * Mount AFTER installFamilyAuth. Its existing required-mode middleware must
 * validate the session and enforce secure same-origin POST protections.
 * No current app enables this mode. It is ready for separately approved
 * TEST-only rollout and TEST SQLite backup/rollback rehearsal.
 */
export function installTestNotificationInboxPilot(app, db, {
  flag = process.env.FAMILY_CALENDAR_NOTIFICATION_TEST_PILOT,
  port = process.env.FAMILY_CALENDAR_PORT,
  authMode = process.env.FAMILY_CALENDAR_AUTH_MODE,
  rootFolder,
  now = () => Date.now(),
} = {}) {
  if (flag === undefined || flag === '' || flag === 'disabled') return {enabled:false}
  if (flag !== 'enabled' || String(port) !== '13002' || authMode !== 'required'
    || typeof rootFolder !== 'string'
    || !/[\\/]family-calendar-test[^\\/]*$/i.test(path.resolve(rootFolder))
    || /family-calendar-live/i.test(rootFolder)) {
    throw new Error('TEST notification pilot requires isolated TEST auth, port and checkout.')
  }
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
    || !db || typeof db.prepare !== 'function' || typeof now !== 'function') {
    throw new Error('Trusted TEST app, SQLite and clock required.')
  }
  installAssignmentNotificationOutbox(db)
  installNotificationMutationCapture(db)
  // Acknowledging in the Invitations UI is distinct from push delivery.
  // This additive TEST-only state never mutates the delivery outbox.
  db.exec([
    'CREATE TABLE IF NOT EXISTS test_assignment_acknowledgements(',
    'notification_id INTEGER PRIMARY KEY REFERENCES assignment_notification_outbox(id),',
    'acknowledged_at INTEGER NOT NULL CHECK(acknowledged_at > 0)',
    ') STRICT;',
  ].join(' '))

  function requirePerson(request,response) {
    const selected = selectedPerson(db,request.familyAccount,now())
    if (!selected) {
      response.status(401).json({error:'Sign in to TEST first.'})
      return null
    }
    if (selected.kind !== 'person') {
      response.status(403).json({error:'Select a person profile; Home cannot see the inbox.'})
      return null
    }
    return selected
  }

  app.get('/test-notification-pilot',(request,response)=>{
    const selected = requirePerson(request,response)
    if (!selected) return
    response.set('Cache-Control','no-store')
    // Only this TEST inbox page needs a same-origin referrer policy:
    // native HTML form POSTs otherwise use Origin: null under no-referrer.
    // Keep family-auth's strict secure Origin validation unchanged.
    response.set('Referrer-Policy','same-origin')
    response.type('html').send(page(selected,latest(db,selected.personId)))
  })
  app.get('/api/test-notification-pilot',(request,response)=>{
    const selected = requirePerson(request,response)
    if (!selected) return
    response.set('Cache-Control','no-store')
    const notifications = latest(db,selected.personId).map(note => ({
      ...note,
      acknowledged: Boolean(db.prepare(
        'SELECT 1 FROM test_assignment_acknowledgements WHERE notification_id=?'
      ).get(note.id)),
    }))
    response.json({
      pilot:true,profile:'person',personId:selected.personId,
      notifications,
    })
  })
  app.post('/api/test-notification-pilot/:notificationId/acknowledge',(request,response)=>{
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
      'INSERT OR IGNORE INTO test_assignment_acknowledgements(notification_id,acknowledged_at)',
      'VALUES (?,?)',
    ].join(' ')).run(id,now())
    response.set('Cache-Control','no-store')
    response.json({acknowledged:true})
  })
  app.post('/test-notification-pilot/refresh',(request,response)=>{
    if (!requirePerson(request,response)) return
    try {
      reconcileNotificationMutations(db,{limit:100,at:now()})
      response.set('Cache-Control','no-store')
      response.redirect(303,'/test-notification-pilot')
    } catch(error) {
      console.error('TEST notification pilot reconciliation failed:',
        error instanceof Error ? error.message : 'unknown')
      response.status(503).json({error:'TEST notification inbox unavailable.'})
    }
  })
  return {enabled:true}
}
