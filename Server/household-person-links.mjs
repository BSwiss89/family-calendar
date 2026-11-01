// Draft PR #46 only: identity-to-person links for future participant notifications.
// This is a CENTRAL identity database table, NOT a migration of a family's
// existing people/events tables. No public route, account creation or push
// subscription is enabled here.
import { createHouseholdMembershipTables } from './household-memberships.mjs'

function requirePositiveId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(label + ' must be a positive integer.')
  }
  return value
}

function requireHouseholdId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(value)) {
    throw new Error('Invalid household ID.')
  }
  return value
}

function requireTrustedHouseholdDatabase(database) {
  if (!database || typeof database.prepare !== 'function') {
    throw new Error('A verified, selected household SQLite connection is required.')
  }
  // Only a trusted server caller may pass this connection. Never choose a
  // household DB from browser input, and never expose these helpers as routes.
  return database
}

export function createHouseholdPersonLinkTables(identityDatabase) {
  createHouseholdMembershipTables(identityDatabase)
  identityDatabase.exec(`
    CREATE TABLE IF NOT EXISTS household_person_links (
      household_id INTEGER NOT NULL
        REFERENCES household_registry(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      person_id INTEGER NOT NULL CHECK(person_id > 0),
      PRIMARY KEY (household_id, user_id),
      UNIQUE (household_id, person_id),
      FOREIGN KEY (user_id, household_id)
        REFERENCES household_memberships(user_id, household_id)
        ON DELETE CASCADE
    ) STRICT;
  `)
}

function activePersonMember(identityDatabase, householdId, userId) {
  return identityDatabase.prepare(`
    SELECT h.id AS householdKey
    FROM household_registry h
    JOIN household_memberships m ON m.household_id = h.id
    JOIN family_users u ON u.id = m.user_id
    WHERE h.storage_id = ? AND m.user_id = ?
      AND h.disabled = 0 AND m.disabled = 0 AND u.disabled = 0
      AND u.account_kind = 'person'
  `).get(householdId, userId)
}

/**
 * Trusted, offline-only identity migration/provisioning.
 * The caller must already have resolved the exact household's storage through
 * resolveHouseholdStorage and opened its SQLite database. Refuse guesses by
 * username, display name or avatar, duplicate identities and hub mappings.
 * Existing people IDs, colors, pictures and event_people rows are unchanged.
 */
export function linkHouseholdPersonToAccount(identityDatabase, householdDatabase, {
  householdId, serverVerifiedUserId, personId,
}) {
  const slug = requireHouseholdId(householdId)
  const userId = requirePositiveId(serverVerifiedUserId, 'Verified user ID')
  const profileId = requirePositiveId(personId, 'Calendar person ID')
  const local = requireTrustedHouseholdDatabase(householdDatabase)
  const member = activePersonMember(identityDatabase, slug, userId)
  if (!member) throw new Error('Active personal account membership required.')
  if (!local.prepare('SELECT id FROM people WHERE id = ?').get(profileId)) {
    throw new Error('Calendar person does not exist in the selected household.')
  }
  // New links are deliberately insert-only. Reassignment needs a separate
  // audited administrative operation; never silently change old assignments.
  identityDatabase.prepare(`
    INSERT INTO household_person_links (household_id, user_id, person_id)
    VALUES (?, ?, ?)
  `).run(member.householdKey, userId, profileId)
  return { householdId: slug, userId, personId: profileId }
}

/** A verified personal account's local profile, or null after revocation. */
export function getLinkedHouseholdPerson(identityDatabase, householdDatabase, {
  householdId, serverVerifiedUserId,
}) {
  const slug = requireHouseholdId(householdId)
  const userId = requirePositiveId(serverVerifiedUserId, 'Verified user ID')
  const local = requireTrustedHouseholdDatabase(householdDatabase)
  const member = activePersonMember(identityDatabase, slug, userId)
  if (!member) return null
  const link = identityDatabase.prepare(`
    SELECT person_id AS personId
    FROM household_person_links WHERE household_id = ? AND user_id = ?
  `).get(member.householdKey, userId)
  if (!link || !local.prepare('SELECT id FROM people WHERE id = ?').get(link.personId)) {
    return null
  }
  return { householdId: slug, userId, personId: link.personId }
}

/**
 * Resolve an event's existing event_people assignments into intended personal
 * notification recipients. This NEVER controls event visibility or sends push.
 * The actor ID must come from a verified server session, not the request body.
 * Every household member still sees the same calendar, including the Hub.
 */
export function getAssignedHouseholdNotificationRecipients(
  identityDatabase, householdDatabase, {
    householdId, eventId, serverVerifiedActorUserId = null,
  },
) {
  const slug = requireHouseholdId(householdId)
  const id = requirePositiveId(eventId, 'Event ID')
  const local = requireTrustedHouseholdDatabase(householdDatabase)
  if (serverVerifiedActorUserId !== null) {
    requirePositiveId(serverVerifiedActorUserId, 'Verified actor user ID')
  }
  // Event people IDs are scoped to the selected local household DB. Joining to
  // people also excludes deleted/stale profiles.
  const assigned = new Set(local.prepare(`
    SELECT DISTINCT ep.person_id AS personId
    FROM event_people ep
    JOIN people p ON p.id = ep.person_id
    JOIN events e ON e.id = ep.event_id
    WHERE e.id = ?
  `).all(id).map(row => row.personId))
  if (!assigned.size) return []

  const links = identityDatabase.prepare(`
    SELECT l.user_id AS userId, l.person_id AS personId
    FROM household_person_links l
    JOIN household_registry h ON h.id = l.household_id
    JOIN household_memberships m
      ON m.household_id = l.household_id AND m.user_id = l.user_id
    JOIN family_users u ON u.id = l.user_id
    WHERE h.storage_id = ? AND h.disabled = 0 AND m.disabled = 0
      AND u.disabled = 0 AND u.account_kind = 'person'
    ORDER BY l.user_id
  `).all(slug)

  return links
    .filter(link => assigned.has(link.personId)
      && link.userId !== serverVerifiedActorUserId)
    .map(link => ({ userId: link.userId, personId: link.personId }))
}
