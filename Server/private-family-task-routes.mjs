// SOURCE-ONLY, opt-in PRIVATE loopback gateway API. NOT mounted by either
// installed LIVE/TEST calendar. A trusted central signed Person session and
// a server-selected household storage path are mandatory on every request.
// No automatic task-table creation, third site, or browser-supplied actor.
import express from 'express'
import {
  createVerifiedFamilyAssignedTask, listVerifiedFamilyAssignedTasks,
  completeVerifiedFamilyAssignedTask, reopenVerifiedFamilyAssignedTask,
} from './private-family-assigned-tasks.mjs'

const ROOT = '/api/family-assigned-tasks'
const TASK_PATH = /^\/api\/family-assigned-tasks\/([1-9][0-9]{0,14})\/(complete|reopen)$/
const isId = id => Number.isSafeInteger(id) && id > 0

function trustedSignedPerson(identityDatabase, session) {
  if (!isId(session?.id) || !isId(session?.user_id) ||
      typeof session?.username !== 'string') return false
  const row = identityDatabase.prepare([
    'SELECT u.username FROM family_sessions s',
    'JOIN family_users u ON u.id=s.user_id',
    'WHERE s.id=? AND s.user_id=? AND s.revoked_at IS NULL',
    'AND s.expires_at>? AND u.disabled=0',
    "AND u.account_kind='person'",
  ].join(' ')).get(session.id, session.user_id, Date.now())
  return Boolean(row && row.username === session.username)
}

function canonicalTaskOperation(method, originalUrl) {
  if (typeof originalUrl !== 'string' ||
      originalUrl.includes('%') || originalUrl.includes('?') ||
      originalUrl.includes('//') || originalUrl.endsWith('/')) return null
  if (originalUrl === ROOT) {
    if (method === 'GET') return { action: 'list' }
    if (method === 'POST') return { action: 'create' }
    return null
  }
  if (method !== 'POST') return null
  const match = TASK_PATH.exec(originalUrl)
  if (!match) return null
  const taskId = Number(match[1])
  if (!isId(taskId)) return null
  return { action: match[2], taskId }
}

function postedBody(request, fields) {
  // Only finite, tight JSON objects. The only Person ID accepted from a
  // browser is the *target assignment* on a manager's CREATE request;
  // the actor Person is always looked up from central membership.
  if (!request.is('application/json') || !request.body ||
      typeof request.body !== 'object' || Array.isArray(request.body) ||
      Object.keys(request.body).some(key => !fields.includes(key))) {
    throw new Error('Invalid task request body.')
  }
  return request.body
}

function respondError(response, error, operation = null) {
  const reason = String(error?.message || '')
  if (reason === 'This member cannot perform that assigned task action.' &&
      operation?.taskId) {
    // A Child must not be able to enumerate other household task IDs by
    // distinguishing an existing task (403) from an absent task (404).
    return response.status(404).json({ error: 'Assigned task unavailable.' })
  }
  if (reason === 'Active household member required.' ||
      reason === 'This member cannot perform that assigned task action.') {
    return response.status(403).json({ error: 'This account cannot perform that task action.' })
  }
  if (reason === 'Assigned task unavailable.' ||
      reason === 'Assigned Person no longer exists in this household.') {
    return response.status(404).json({ error: 'Assigned task or Person not found.' })
  }
  if (reason === 'Invalid task request body.' || reason.startsWith('Valid task') ||
      reason.startsWith('Valid title,')) {
    return response.status(400).json({ error: 'Invalid task request.' })
  }
  // Never expose a household storage path, task title, member record or
  // identity database error in a response.
  return response.status(503).json({ error: 'Family task service unavailable.' })
}

/**
 * Mount ONLY after real central session/Origin/CSRF authentication and BEFORE
 * the generic private gateway deny-by-default proxy middleware.
 *
 * When enabled=false (the default) this registers no routes or schema.
 * resolveTrustedHousehold MUST derive membership from the authenticated
 * account and server-only per-device choice; openHouseholdDatabase MUST use
 * approved, externally provisioned household storage.
 */
export function installPrivateFamilyTaskRoutes(app, {
  enabled = false, identityDatabase,
  resolveTrustedHousehold, openHouseholdDatabase,
} = {}) {
  if (enabled === false) return { enabled: false }
  if (enabled !== true || typeof app?.use !== 'function' ||
      !identityDatabase?.prepare ||
      typeof resolveTrustedHousehold !== 'function' ||
      typeof openHouseholdDatabase !== 'function') {
    throw new Error('Trusted central identity, household routing and task storage are required.')
  }

  // Includes a final namespace catch-all. Express matches case-insensitively;
  // originalUrl matching below denies uppercase, trailing slash, query,
  // percent-encoded, overlapping and unreviewed task paths.
  const parseJson = express.json({ limit: '4kb', strict: true })
  app.use(ROOT, (request, response, next) => {
    response.set('Cache-Control', 'no-store')
    if (request.method !== 'POST') return next()
    return parseJson(request, response, error => {
      if (error) return response.status(400).json({ error: 'Invalid task JSON.' })
      next()
    })
  }, (request, response) => {
    let db
    let operation
    try {
      operation = canonicalTaskOperation(request.method, request.originalUrl)
      if (!operation) return response.status(404).json({ error: 'Task route not found.' })
      if (!trustedSignedPerson(identityDatabase, request.familyAccount)) {
        return response.status(403).json({ error: 'An active Person account is required.' })
      }
      // Never accept householdId, role, userId, session ID or completion actor
      // from a payload, URL query or People avatar.
      const selected = resolveTrustedHousehold(request, response)
      if (!selected) return
      if (typeof selected.householdId !== 'string') {
        return response.status(503).json({ error: 'Household routing unavailable.' })
      }
      db = openHouseholdDatabase(selected.householdId)
      if (!db?.prepare || !db?.exec || !db?.close || db === identityDatabase) {
        throw new Error('Trusted household database unavailable.')
      }
      // No hidden migrations, task schema creation or shared global DB.
      const schema = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='family_assigned_tasks'"
      ).get()
      if (!schema) return response.status(503).json({
        error: 'Family tasks have not been provisioned for this household.',
      })
      const context = {
        identityDatabase, householdDatabase: db,
        householdId: selected.householdId,
        serverVerifiedUserId: request.familyAccount.user_id,
      }
      if (operation.action === 'list') {
        return response.json({ tasks: listVerifiedFamilyAssignedTasks(context) })
      }
      const fields = operation.action === 'create' ? ['title', 'assignedPersonId'] : []
      const body = postedBody(request, fields)
      if (operation.action === 'create') {
        const created = createVerifiedFamilyAssignedTask(context, {
          title: body.title, assignedPersonId: body.assignedPersonId,
        })
        return response.status(201).json(created)
      }
      if (operation.action === 'complete') {
        return response.json(completeVerifiedFamilyAssignedTask(context, {
          taskId: operation.taskId,
        }))
      }
      if (operation.action === 'reopen') {
        return response.json(reopenVerifiedFamilyAssignedTask(context, {
          taskId: operation.taskId,
        }))
      }
      return response.status(404).json({ error: 'Task route not found.' })
    } catch (error) {
      return respondError(response, error, operation)
    } finally {
      try { db?.close() } catch {}
    }
  })
  return { enabled: true }
}
