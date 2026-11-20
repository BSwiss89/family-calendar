// OFFLINE TEST account planning only. The existing TEST family_users,
// family_sessions, People, events, lists and photos are READ-ONLY inputs.
// No user/role is inferred from avatar selections or usernames. A human
// explicitly chooses the one Owner and every other active Person account.
//
// A separate new SQLite is populated with non-login shadow users. Password
// hashes and session tokens NEVER leave the existing TEST login database.
// The central shadow is NOT a second login provider and must never be used
// for direct login, only session-bound authorization.
import { createFamilyMemberAccessTables } from './family-member-access.mjs'

const HOUSEHOLD = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const USERNAME = /^[a-z0-9._-]{3,40}$/
const SHADOW_PASSWORD = '!no-login:verified-existing-test-session-only'

function strictShape(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.keys(value)
  return entries.every(key => keys.includes(key)) &&
    required.every(key => Object.hasOwn(value, key))
}

function existingPerson(source, id) {
  if (id === null) return
  if (!Number.isSafeInteger(id) || id <= 0 ||
      !source.prepare('SELECT id FROM people WHERE id = ?').get(id)) {
    throw new Error('Every linked Person must already exist in this TEST calendar.')
  }
}

/** Validate a complete, explicit, sensitive local plan; never write source. */
export function inspectExistingTestFamilyPlan(source, draft) {
  if (!source || typeof source.prepare !== 'function' ||
      !strictShape(draft, [
        'householdId', 'householdName', 'ownerUsername', 'ownerPersonId', 'members',
      ], ['householdId', 'householdName', 'ownerUsername', 'members'])) {
    throw new Error('Explicit TEST household setup plan is required.')
  }
  if (!HOUSEHOLD.test(draft.householdId) ||
      typeof draft.householdName !== 'string' ||
      draft.householdName.trim().length < 1 || draft.householdName.trim().length > 80 ||
      typeof draft.ownerUsername !== 'string' || !USERNAME.test(draft.ownerUsername) ||
      !Array.isArray(draft.members)) {
    throw new Error('Invalid TEST household plan identifiers.')
  }

  // Only already enabled, human TEST accounts can be mapped. Hub accounts
  // require their own separately verified Home-device security design.
  const accounts = source.prepare([
    'SELECT id, username, display_name FROM family_users',
    "WHERE disabled = 0 AND account_kind = 'person' ORDER BY id",
  ].join(' ')).all()
  if (accounts.length === 0 || accounts.length > 200 ||
      accounts.some(a => !Number.isSafeInteger(a.id) || a.id < 1 ||
        !USERNAME.test(a.username) ||
        typeof a.display_name !== 'string' || !a.display_name.trim())) {
    throw new Error('Existing TEST account inventory is invalid or too large.')
  }
  const byUsername = new Map(accounts.map(a => [a.username, a]))
  if (byUsername.size !== accounts.length ||
      !byUsername.has(draft.ownerUsername) ||
      draft.members.length !== accounts.length - 1) {
    throw new Error('Plan must explicitly cover every active person login, with exactly one Owner.')
  }
  const links = new Set()
  const ownerPersonId = draft.ownerPersonId ?? null
  existingPerson(source, ownerPersonId)
  if (ownerPersonId !== null) links.add(ownerPersonId)
  const owner = byUsername.get(draft.ownerUsername)
  const people = [{
    userId: owner.id, username: owner.username,
    displayName: owner.display_name, membershipRole: 'owner',
    memberType: 'adult', personId: ownerPersonId,
  }]
  const encountered = new Set([draft.ownerUsername])
  for (const member of draft.members) {
    if (!strictShape(member, ['username', 'memberType', 'personId'],
      ['username', 'memberType'])) {
      throw new Error('Every Member needs an explicitly listed account and type.')
    }
    const personId = member.personId ?? null
    const account = byUsername.get(member.username)
    if (!account || encountered.has(member.username) ||
        !['adult', 'child'].includes(member.memberType)) {
      throw new Error('Plan contains unknown, duplicated or invalid Member identities.')
    }
    encountered.add(member.username)
    existingPerson(source, personId)
    if (personId !== null) {
      if (links.has(personId)) {
        throw new Error('One existing Person cannot belong to two different logins.')
      }
      links.add(personId)
    }
    people.push({
      userId: account.id, username: account.username,
      displayName: account.display_name, membershipRole: 'member',
      memberType: member.memberType, personId,
    })
  }
  if (encountered.size !== accounts.length) {
    throw new Error('Every active Person account must have an explicit role.')
  }
  return {
    householdId: draft.householdId,
    householdName: draft.householdName.trim(),
    people: people.sort((a, b) => a.userId - b.userId),
    accountCount: accounts.length,
    linkedPeopleCount: links.size,
  }
}

/**
 * Provision a fresh, EMPTY, distinct central SQLite provided by the caller.
 * The caller must verify filesystem paths and keep the original TEST source
 * connection strictly read-only. No passwords, tokens or sessions copied.
 * Transactional row writes: if a row fails, roll back every identity grant.
 */
export function provisionFreshTestFamilyIdentity(source, destination, explicitPlan) {
  if (!source || !destination || source === destination ||
      typeof destination.prepare !== 'function' ||
      typeof destination.exec !== 'function') {
    throw new Error('Separate source and new identity databases are required.')
  }
  const hasTables = destination.prepare([
    "SELECT 1 FROM sqlite_master WHERE type IN ('table','view','index')",
    "AND name NOT LIKE 'sqlite_%' LIMIT 1",
  ].join(' ')).get()
  if (hasTables) throw new Error('Target identity database must be completely empty.')
  const normalized = inspectExistingTestFamilyPlan(source, explicitPlan)
  destination.exec('PRAGMA foreign_keys = ON')
  createFamilyMemberAccessTables(destination)
  destination.exec('BEGIN IMMEDIATE')
  try {
    const addUser = destination.prepare([
      'INSERT INTO family_users(id, username, display_name, password_hash)',
      'VALUES (?, ?, ?, ?)',
    ].join(' '))
    const addMembership = destination.prepare([
      'INSERT INTO household_memberships(user_id, household_id, role)',
      'VALUES (?, ?, ?)',
    ].join(' '))
    const addPerson = destination.prepare([
      'INSERT INTO family_member_access(user_id, household_id, member_type, person_id)',
      'VALUES (?, ?, ?, ?)',
    ].join(' '))
    const household = destination.prepare([
      'INSERT INTO household_registry(storage_id, display_name) VALUES (?, ?)',
    ].join(' ')).run(normalized.householdId, normalized.householdName)
    for (const account of normalized.people) {
      addUser.run(account.userId, account.username, account.displayName, SHADOW_PASSWORD)
      addMembership.run(account.userId, Number(household.lastInsertRowid),
        account.membershipRole)
      addPerson.run(account.userId, Number(household.lastInsertRowid),
        account.memberType, account.personId)
    }
    destination.exec('COMMIT')
  } catch (error) {
    destination.exec('ROLLBACK')
    throw error
  }
  const owners = destination.prepare([
    "SELECT COUNT(*) AS n FROM household_memberships WHERE role = 'owner' AND disabled = 0",
  ].join(' ')).get().n
  const users = destination.prepare('SELECT COUNT(*) AS n FROM family_users').get().n
  const sessions = destination.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n
  const hashes = destination.prepare([
    "SELECT COUNT(*) AS n FROM family_users WHERE password_hash <> ?",
  ].join(' ')).get(SHADOW_PASSWORD).n
  if (owners !== 1 || users !== normalized.accountCount || sessions !== 0 || hashes !== 0) {
    throw new Error('Fresh identity verification failed; reject this candidate file.')
  }
  return {
    householdId: normalized.householdId,
    accounts: users, owners, linkedPeople: normalized.linkedPeopleCount,
    sessionsCopied: sessions, realPasswordHashesCopied: hashes,
  }
}
