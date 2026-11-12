// Household-shared, same-day scratchpad. Deliberately RAM-only: no SQLite,
// filesystem, localStorage, snapshots, logs, or history. Each authenticated
// server process owns one trusted household; clients cannot select the scope.
const MAX_NOTE_LENGTH = 1200
const chicagoDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
})

function dateKey(value) {
  const parts = Object.fromEntries(chicagoDate.formatToParts(value).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function createDailyFamilyNotesHandlers({ now = () => new Date() } = {}) {
  let day = ''
  let text = ''
  let revision = 0

  function current() {
    const today = dateKey(now())
    if (day !== today) {
      day = today
      text = ''
      revision = 0
    }
    return { day, text, revision }
  }

  function authorized(request, response) {
    response.set('Cache-Control', 'no-store')
    if (!Number.isSafeInteger(request.familyAccount?.user_id)) {
      response.status(401).json({ error: 'Sign in required.' })
      return false
    }
    return true
  }

  function read(request, response) {
    if (!authorized(request, response)) return
    response.json(current())
  }

  function write(request, response) {
    if (!authorized(request, response)) return
    const active = current()
    const body = request.body
    if (!body || typeof body.text !== 'string' || body.text.length > MAX_NOTE_LENGTH ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.text)) {
      return response.status(400).json({ error: 'Note must be plain text, up to 1200 characters.' })
    }
    if (body.day !== active.day || !Number.isSafeInteger(body.revision) ||
      body.revision !== active.revision) {
      return response.status(409).json({
        error: 'Today\'s note changed. Reload before updating.', ...active,
      })
    }
    text = body.text.replace(/\r\n?/g, '\n')
    revision += 1
    response.json(current())
  }
  return { read, write }
}

export function installDailyFamilyNotes(app) {
  const handlers = createDailyFamilyNotesHandlers()
  // Placed AFTER installFamilyAuth: session validation + same-origin write gate.
  // Even if auth is accidentally disabled on an internal test host, fail closed.
  app.get('/api/family-daily-note', handlers.read)
  app.put('/api/family-daily-note', handlers.write)
}
