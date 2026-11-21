// SOURCE-ONLY: verified, per-household assigned-task primitives for a future
// multi-household calendar. This module is NOT mounted on TEST or LIVE.
// The caller MUST select householdDatabase and serverVerifiedUserId from
// authenticated, server-owned household routing; never from JSON or an avatar.
// Installing schema is explicit: importing the module never writes a database.
import {
  getVerifiedFamilyMemberAuthorization, canFamilyMemberAct,
} from './family-member-access.mjs'

const HOUSEHOLD = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const isId = value => Number.isSafeInteger(value) && value > 0

function checkedContext({ identityDatabase, householdDatabase, householdId, serverVerifiedUserId }) {
  if (!identityDatabase?.prepare || !householdDatabase?.prepare ||
      identityDatabase === householdDatabase || typeof householdId !== 'string' ||
      !HOUSEHOLD.test(householdId) || !isId(serverVerifiedUserId)) {
    throw new Error('Trusted household task identity and separate calendar database required.')
  }
  const actor = getVerifiedFamilyMemberAuthorization(identityDatabase, {
    householdId, serverVerifiedUserId, householdDatabase,
  })
  if (!actor) throw new Error('Active household member required.')
  return { identityDatabase, householdDatabase, householdId, serverVerifiedUserId, actor }
}

function requirePermission(actor, action, assignedPersonId = null) {
  if (!canFamilyMemberAct(actor, action, { assignedPersonId })) {
    throw new Error('This member cannot perform that assigned task action.')
  }
}

function existingPerson(db, personId) {
  return isId(personId) &&
    Boolean(db.prepare('SELECT id FROM people WHERE id = ?').get(personId))
}

function writeTransaction(db, action) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = action()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
}

export function createFamilyAssignedTaskTables(householdDatabase) {
  if (!householdDatabase?.exec || !householdDatabase?.prepare) {
    throw new Error('Trusted household calendar SQLite database required.')
  }
  // No foreign key into central identity: member accounts live in a different
  // SQLite file. Keep task completion audit even if the Person is later removed;
  // a missing Person cannot make another account eligible to complete the task.
  householdDatabase.exec([
    'CREATE TABLE IF NOT EXISTS family_assigned_tasks (',
    'id INTEGER PRIMARY KEY AUTOINCREMENT,',
    'household_id TEXT NOT NULL,',
    'title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),',
    'assigned_person_id INTEGER NOT NULL CHECK(assigned_person_id > 0),',
    'created_by_user_id INTEGER NOT NULL CHECK(created_by_user_id > 0),',
    'created_at INTEGER NOT NULL CHECK(created_at > 0),',
    'completed_at INTEGER,',
    'completed_by_user_id INTEGER,',
    'completed_by_person_id INTEGER,',
    'CHECK((completed_at IS NULL AND completed_by_user_id IS NULL',
    'AND completed_by_person_id IS NULL) OR',
    '(completed_at > 0 AND completed_by_user_id > 0',
    'AND completed_by_person_id = assigned_person_id))',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS family_assigned_tasks_household_person',
    'ON family_assigned_tasks(household_id,assigned_person_id,id);',
  ].join(' '))
}

export function createVerifiedFamilyAssignedTask(context, {
  title, assignedPersonId, at = Date.now(),
} = {}) {
  const { householdDatabase: db, householdId, serverVerifiedUserId, actor } =
    checkedContext(context)
  requirePermission(actor, 'tasks.manage')
  if (typeof title !== 'string' || title.trim().length < 1 ||
      title.trim().length > 200 || !isId(assignedPersonId) ||
      !Number.isSafeInteger(at) || at < 1) {
    throw new Error('Valid title, assigned Person and timestamp required.')
  }
  return writeTransaction(db, () => {
    if (!existingPerson(db, assignedPersonId)) {
      throw new Error('Assigned Person no longer exists in this household.')
    }
    const saved = db.prepare([
      'INSERT INTO family_assigned_tasks',
      '(household_id,title,assigned_person_id,created_by_user_id,created_at)',
      'VALUES (?,?,?,?,?)',
    ].join(' ')).run(householdId, title.trim(), assignedPersonId, serverVerifiedUserId, at)
    return { taskId: Number(saved.lastInsertRowid), assignedPersonId }
  })
}

export function listVerifiedFamilyAssignedTasks(context) {
  const { householdDatabase: db, householdId, actor } = checkedContext(context)
  requirePermission(actor, 'tasks.view')
  // A Child (or nonmanager Adult) sees only their verified Person's tasks.
  // A manager may view every task but cannot impersonate an assigned completer.
  const mayManage = canFamilyMemberAct(actor, 'tasks.manage')
  if (!mayManage && !existingPerson(db, actor.personId)) return []
  const rows = mayManage
    ? db.prepare([
      'SELECT id AS taskId,title,assigned_person_id AS assignedPersonId,',
      'created_at AS createdAt,completed_at AS completedAt',
      'FROM family_assigned_tasks WHERE household_id = ? ORDER BY id DESC LIMIT 100',
    ].join(' ')).all(householdId)
    : db.prepare([
      'SELECT id AS taskId,title,assigned_person_id AS assignedPersonId,',
      'created_at AS createdAt,completed_at AS completedAt',
      'FROM family_assigned_tasks WHERE household_id = ?',
      'AND assigned_person_id = ? ORDER BY id DESC LIMIT 100',
    ].join(' ')).all(householdId, actor.personId)
  return rows
}

export function completeVerifiedFamilyAssignedTask(context, {
  taskId, at = Date.now(),
} = {}) {
  const { householdDatabase: db, householdId, serverVerifiedUserId, actor } =
    checkedContext(context)
  if (!isId(taskId) || !Number.isSafeInteger(at) || at < 1) {
    throw new Error('Valid task and completion timestamp required.')
  }
  // Even the household Owner cannot complete a Child's assigned task by
  // selecting that Child's avatar; only the verified linked account can do it.
  return writeTransaction(db, () => {
    const task = db.prepare([
      'SELECT id,assigned_person_id AS assignedPersonId,',
      'completed_at AS completedAt,completed_by_user_id AS completedByUserId',
      'FROM family_assigned_tasks WHERE id = ? AND household_id = ?',
    ].join(' ')).get(taskId, householdId)
    if (!task || !existingPerson(db, task.assignedPersonId)) {
      throw new Error('Assigned task unavailable.')
    }
    requirePermission(actor, 'tasks.completeAssigned', task.assignedPersonId)
    if (task.completedAt !== null) {
      // Repeat delivery from the SAME account is idempotent; a different
      // account cannot claim another user's prior completion.
      if (task.completedByUserId !== serverVerifiedUserId) {
        throw new Error('Assigned task was completed by another account.')
      }
      return { taskId, completed: true, alreadyCompleted: true }
    }
    const changed = db.prepare([
      'UPDATE family_assigned_tasks SET completed_at = ?,',
      'completed_by_user_id = ?,completed_by_person_id = ?',
      'WHERE id = ? AND household_id = ? AND assigned_person_id = ?',
      'AND completed_at IS NULL',
    ].join(' ')).run(at, serverVerifiedUserId, actor.personId,
      taskId, householdId, task.assignedPersonId)
    if (changed.changes !== 1) throw new Error('Task was not safely completed.')
    return { taskId, completed: true, alreadyCompleted: false }
  })
}

export function reopenVerifiedFamilyAssignedTask(context, { taskId } = {}) {
  const { householdDatabase: db, householdId, actor } = checkedContext(context)
  requirePermission(actor, 'tasks.manage')
  if (!isId(taskId)) throw new Error('Valid task required.')
  return writeTransaction(db, () => {
    const task = db.prepare([
      'SELECT id FROM family_assigned_tasks WHERE id = ? AND household_id = ?',
    ].join(' ')).get(taskId, householdId)
    if (!task) throw new Error('Assigned task unavailable.')
    const changes = db.prepare([
      'UPDATE family_assigned_tasks SET completed_at = NULL,',
      'completed_by_user_id = NULL,completed_by_person_id = NULL',
      'WHERE id = ? AND household_id = ? AND completed_at IS NOT NULL',
    ].join(' ')).run(taskId, householdId)
    return { taskId, reopened: changes.changes === 1 }
  })
}
