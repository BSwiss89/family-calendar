// DRAFT: backend-only member authorization primitives for future family accounts.
// Not wired to the existing LIVE/TEST HTTP application or device profile picker.
// Callers MUST derive userId, householdId, actor and Home session trust from
// validated server sessions; People selection and request JSON grant no authority.
import { createHouseholdMembershipTables } from './household-memberships.mjs'

export const FAMILY_ACTIONS = Object.freeze([
  'calendar.view', 'events.create', 'events.edit', 'events.delete',
  'lists.view', 'lists.edit', 'tasks.view', 'tasks.completeAssigned',
  'invitations.respondOwn', 'notifications.acknowledgeOwn',
  'notifications.receiveOwn',
  'events.joinOwn', 'events.leaveOwn',
  'tasks.manage', 'recipes.view', 'recipes.edit', 'settings.manage',
  'members.invite', 'permissions.manage', 'devices.manage', 'ownership.transfer',
])

const ACTIONS = new Set(FAMILY_ACTIONS)
const OWNER_ONLY = new Set(['permissions.manage', 'devices.manage', 'ownership.transfer'])
const ADULT_ONLY = new Set(['settings.manage', 'members.invite'])
const PERSON_SCOPED = new Set([
  'tasks.completeAssigned', 'invitations.respondOwn', 'notifications.acknowledgeOwn',
  'notifications.receiveOwn',
  'events.joinOwn', 'events.leaveOwn',
])
const ADULT_DEFAULTS = new Set([
  'calendar.view', 'events.create', 'events.edit', 'events.delete',
  'lists.view', 'lists.edit', 'tasks.view', 'tasks.completeAssigned',
  'tasks.manage', 'recipes.view', 'recipes.edit',
  'invitations.respondOwn', 'notifications.acknowledgeOwn',
  'notifications.receiveOwn',
  'events.joinOwn', 'events.leaveOwn',
])
const CHILD_DEFAULTS = new Set([
  'calendar.view', 'tasks.view', 'tasks.completeAssigned',
  'invitations.respondOwn', 'notifications.acknowledgeOwn',
  'notifications.receiveOwn',
  'notifications.receiveOwn',
])
// Home is a verified device mode, NEVER another family member or a role.
// The frontend can show these controls, but a write still needs a verified actor.
const HOME_READS = new Set(['calendar.view', 'lists.view', 'tasks.view', 'recipes.view'])
const HOME_WRITES = new Set([
  'events.create', 'events.edit', 'lists.edit', 'tasks.completeAssigned',
  'recipes.edit',
])

function requireId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid ' + label + '.')
  return value
}

function requireHouseholdId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(value)) {
    throw new Error('Invalid household ID.')
  }
  return value
}

function activeMembership(database, userId, householdId) {
  return database.prepare([
    'SELECT m.role FROM household_memberships m',
    'JOIN household_registry h ON h.id = m.household_id',
    'JOIN family_users u ON u.id = m.user_id',
    'WHERE m.user_id = ? AND h.storage_id = ? AND m.disabled = 0',
    "AND h.disabled = 0 AND u.disabled = 0 AND u.account_kind = 'person'",
  ].join(' ')).get(userId, householdId)
}

function assertOwner(database, householdId, serverVerifiedOwnerUserId) {
  const owner = activeMembership(database, requireId(serverVerifiedOwnerUserId, 'owner'), householdId)
  if (!owner || owner.role !== 'owner') throw new Error('Active household Owner required.')
}

function assertTargetMember(database, householdId, targetUserId) {
  const row = activeMembership(database, requireId(targetUserId, 'target user'), householdId)
  if (!row || row.role !== 'member') {
    throw new Error('Target must be an active non-Owner household member.')
  }
}

export function createFamilyMemberAccessTables(database) {
  createHouseholdMembershipTables(database)
  // At most one active Owner per household, even during concurrent provisioning.
  // Legacy conflicting rows abort the migration; never delete or auto-demote one.
  database.exec([
    'CREATE UNIQUE INDEX IF NOT EXISTS household_one_active_owner',
    "ON household_memberships(household_id) WHERE role = 'owner' AND disabled = 0;",
    'CREATE TABLE IF NOT EXISTS family_member_access (',
    'user_id INTEGER NOT NULL, household_id INTEGER NOT NULL,',
    "member_type TEXT NOT NULL CHECK(member_type IN ('adult','child')),",
    'person_id INTEGER CHECK(person_id IS NULL OR person_id > 0),',
    'PRIMARY KEY(user_id, household_id),',
    'FOREIGN KEY(user_id, household_id)',
    'REFERENCES household_memberships(user_id, household_id) ON DELETE CASCADE',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS family_member_grants (',
    'user_id INTEGER NOT NULL, household_id INTEGER NOT NULL,',
    'action TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),',
    'PRIMARY KEY(user_id, household_id, action),',
    'FOREIGN KEY(user_id, household_id)',
    'REFERENCES family_member_access(user_id, household_id) ON DELETE CASCADE',
    ') STRICT;',
    // The same calendar Person cannot silently become two different logins.
    // Existing duplicates fail this migration rather than being overwritten.
    'CREATE UNIQUE INDEX IF NOT EXISTS family_member_one_person_per_household',
    'ON family_member_access(household_id, person_id) WHERE person_id IS NOT NULL;',
  ].join(' '))
}

// Owner-only trusted operation. Existing People mapping is intentionally left
// untouched; linking a People row requires verification against that household's
// separate calendar database in a later, reviewed gateway integration.
export function setFamilyMemberType(database, {
  householdId, serverVerifiedOwnerUserId, targetUserId, memberType,
}) {
  const home = requireHouseholdId(householdId)
  if (memberType !== 'adult' && memberType !== 'child') {
    throw new Error('Member type must be adult or child.')
  }
  createFamilyMemberAccessTables(database)
  database.exec('BEGIN IMMEDIATE')
  try {
    assertOwner(database, home, serverVerifiedOwnerUserId)
    assertTargetMember(database, home, targetUserId)
    const household = database.prepare(
      'SELECT id FROM household_registry WHERE storage_id = ? AND disabled = 0'
    ).get(home)
    database.prepare([
      'INSERT INTO family_member_access(user_id, household_id, member_type)',
      'VALUES (?, ?, ?) ON CONFLICT(user_id, household_id)',
      'DO UPDATE SET member_type = excluded.member_type',
    ].join(' ')).run(targetUserId, household.id, memberType)
    // Role changes invalidate old grants; no accidental privilege carryover.
    database.prepare(
      'DELETE FROM family_member_grants WHERE user_id = ? AND household_id = ?'
    ).run(targetUserId, household.id)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export function setFamilyMemberPermission(database, {
  householdId, serverVerifiedOwnerUserId, targetUserId, action, enabled,
}) {
  const home = requireHouseholdId(householdId)
  if (!ACTIONS.has(action) || OWNER_ONLY.has(action)) {
    throw new Error('Permission is not delegable.')
  }
  if (typeof enabled !== 'boolean') throw new Error('Permission enabled must be a boolean.')
  createFamilyMemberAccessTables(database)
  database.exec('BEGIN IMMEDIATE')
  try {
    assertOwner(database, home, serverVerifiedOwnerUserId)
    assertTargetMember(database, home, targetUserId)
    const row = database.prepare([
      'SELECT a.household_id AS householdKey, a.member_type AS memberType',
      'FROM family_member_access a JOIN household_registry h ON h.id = a.household_id',
      'WHERE a.user_id = ? AND h.storage_id = ?',
    ].join(' ')).get(targetUserId, home)
    if (!row) throw new Error('Member must be enrolled before granting permissions.')
    if (row.memberType === 'child' && ADULT_ONLY.has(action)) {
      throw new Error('Adult administrative permission requires an Adult account.')
    }
    database.prepare([
      'INSERT INTO family_member_grants(user_id, household_id, action, enabled)',
      'VALUES (?, ?, ?, ?) ON CONFLICT(user_id, household_id, action)',
      'DO UPDATE SET enabled = excluded.enabled',
    ].join(' ')).run(targetUserId, row.householdKey, action, enabled ? 1 : 0)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

// Trusted owner operation only: associate an authenticated account with an
// EXISTING Person in that household's separate calendar database. The caller
// must obtain householdDatabase from server-owned, authenticated routing; the
// browser may never choose the database or storage path. No calendar People,
// events, assignments or photos are created, renamed or modified.
export function setFamilyMemberPersonLink(identityDatabase, {
  householdId, serverVerifiedOwnerUserId, targetUserId, personId, householdDatabase,
}) {
  const home = requireHouseholdId(householdId)
  const target = requireId(targetUserId, 'target user')
  if (personId !== null && (!Number.isSafeInteger(personId) || personId < 1)) {
    throw new Error('A current Person ID or explicit null is required.')
  }
  if (!householdDatabase || typeof householdDatabase.prepare !== 'function') {
    throw new Error('Trusted household calendar database is required.')
  }
  createFamilyMemberAccessTables(identityDatabase)
  identityDatabase.exec('BEGIN IMMEDIATE')
  try {
    assertOwner(identityDatabase, home, serverVerifiedOwnerUserId)
    const member = identityDatabase.prepare([
      'SELECT m.role AS membershipRole, a.member_type AS memberType,',
      'h.id AS householdKey FROM household_memberships m',
      'JOIN household_registry h ON h.id = m.household_id',
      'JOIN family_users u ON u.id = m.user_id',
      'LEFT JOIN family_member_access a ON a.user_id = m.user_id',
      'AND a.household_id = m.household_id',
      'WHERE h.storage_id = ? AND m.user_id = ? AND m.disabled = 0',
      "AND h.disabled = 0 AND u.disabled = 0 AND u.account_kind = 'person'",
    ].join(' ')).get(home, target)
    if (!member || !['owner', 'member'].includes(member.membershipRole)) {
      throw new Error('Target must be an active household person account.')
    }
    if (member.membershipRole === 'member' &&
        !['adult', 'child'].includes(member.memberType)) {
      throw new Error('Member must have an Adult or Child type first.')
    }
    if (personId !== null) {
      const existingPerson = householdDatabase.prepare(
        'SELECT id FROM people WHERE id = ?'
      ).get(personId)
      if (!existingPerson) {
        throw new Error('Person does not exist in this household calendar.')
      }
    }
    // Owner is still Owner regardless of the storage-only member_type value.
    // A type change by setFamilyMemberType preserves the verified link.
    const storedType = member.membershipRole === 'owner'
      ? 'adult' : member.memberType
    identityDatabase.prepare([
      'INSERT INTO family_member_access(user_id, household_id, member_type, person_id)',
      'VALUES (?, ?, ?, ?) ON CONFLICT(user_id, household_id)',
      'DO UPDATE SET person_id = excluded.person_id',
    ].join(' ')).run(target, member.householdKey, storedType, personId)
    identityDatabase.exec('COMMIT')
    return { userId: target, personId, membershipRole: member.membershipRole }
  } catch (error) {
    identityDatabase.exec('ROLLBACK')
    throw error
  }
}

// Resolve the account from a SERVER-authenticated session, then revalidate
// its Person link against the verified household's calendar DB. A removed
// profile immediately loses task attribution; avatar selection is ignored.
export function getVerifiedFamilyMemberAuthorization(identityDatabase, {
  householdId, serverVerifiedUserId, householdDatabase,
}) {
  if (!householdDatabase || typeof householdDatabase.prepare !== 'function') {
    return null
  }
  const actor = getFamilyMemberAuthorization(identityDatabase, {
    householdId, serverVerifiedUserId,
  })
  if (!actor || actor.personId === null) return actor
  const linkedPerson = householdDatabase.prepare(
    'SELECT id FROM people WHERE id = ?'
  ).get(actor.personId)
  return linkedPerson ? actor : { ...actor, personId: null }
}

// Read membership from the CENTRAL identity DB for EACH protected request.
// A member with no enrolled Adult/Child type is denied pending migration.
export function getFamilyMemberAuthorization(database, { householdId, serverVerifiedUserId }) {
  if (!Number.isSafeInteger(serverVerifiedUserId) || serverVerifiedUserId < 1 ||
      typeof householdId !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(householdId)) return null
  const row = database.prepare([
    'SELECT h.id AS householdKey, m.role AS membershipRole,',
    'a.member_type AS memberType, a.person_id AS personId',
    'FROM household_memberships m',
    'JOIN household_registry h ON h.id = m.household_id',
    'JOIN family_users u ON u.id = m.user_id',
    'LEFT JOIN family_member_access a ON a.user_id = m.user_id',
    'AND a.household_id = m.household_id',
    'WHERE m.user_id = ? AND h.storage_id = ? AND m.disabled = 0',
    "AND h.disabled = 0 AND u.disabled = 0 AND u.account_kind = 'person'",
  ].join(' ')).get(serverVerifiedUserId, householdId)
  if (!row) return null
  if (row.membershipRole === 'owner') {
    return { role: 'owner', personId: row.personId ?? null, permissions: [...FAMILY_ACTIONS] }
  }
  if (row.membershipRole !== 'member' || !['adult', 'child'].includes(row.memberType)) return null
  const permissions = new Set(row.memberType === 'adult' ? ADULT_DEFAULTS : CHILD_DEFAULTS)
  const grants = database.prepare([
    'SELECT action, enabled FROM family_member_grants',
    'WHERE user_id = ? AND household_id = ?',
  ].join(' ')).all(serverVerifiedUserId, row.householdKey)
  for (const grant of grants) {
    if (!ACTIONS.has(grant.action) || OWNER_ONLY.has(grant.action) ||
        (row.memberType === 'child' && ADULT_ONLY.has(grant.action))) continue
    if (grant.enabled === 1) permissions.add(grant.action)
    else permissions.delete(grant.action)
  }
  return { role: row.memberType, personId: row.personId ?? null, permissions: [...permissions] }
}

export function canFamilyMemberAct(actor, action, { assignedPersonId = null } = {}) {
  if (!actor || !['owner', 'adult', 'child'].includes(actor.role) ||
      !ACTIONS.has(action) || !Array.isArray(actor.permissions) ||
      !actor.permissions.includes(action)) return false
  if (PERSON_SCOPED.has(action)) {
    return Number.isSafeInteger(actor.personId) && actor.personId > 0 &&
      actor.personId === assignedPersonId
  }
  return true
}

// Requires a SERVER-verified kiosk session, not selectedProfile === 'Home'.
// All Home writes also require a verified human actor. UI should prompt for a
// PIN (or later local face + PIN fallback) without hiding everyday controls.
// Sensitive owner-only/admin actions require a separate protected screen.
export function canActFromHome({ serverVerifiedHomeDevice, actor = null, action, assignedPersonId = null }) {
  if (serverVerifiedHomeDevice !== true || !ACTIONS.has(action)) return false
  if (HOME_READS.has(action)) return true
  return HOME_WRITES.has(action) &&
    canFamilyMemberAct(actor, action, { assignedPersonId })
}
