// Central identity-only, owner-scoped household roster for the private gateway.
// Never read calendar People profiles or expose password and session records.
export function listHouseholdMembers(identityDatabase, {
  householdId, serverVerifiedOwnerUserId,
}) {
  if (typeof householdId !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(householdId) ||
      !Number.isSafeInteger(serverVerifiedOwnerUserId) ||
      serverVerifiedOwnerUserId < 1) {
    throw new Error('Active household owner permission required.')
  }
  const owner = identityDatabase.prepare(`
    SELECT h.id FROM household_registry h
    JOIN household_memberships m ON m.household_id = h.id
    JOIN family_users u ON u.id = m.user_id
    WHERE h.storage_id = ? AND m.user_id = ?
      AND h.disabled = 0 AND m.disabled = 0
      AND m.role = 'owner' AND u.disabled = 0
      AND u.account_kind = 'person'
  `).get(householdId, serverVerifiedOwnerUserId)
  if (!owner) throw new Error('Active household owner permission required.')

  // Only active human logins: hub/kiosk accounts are a separate future UI.
  // Do not expose password hashes, sessions, invitations, or access to People.
  return identityDatabase.prepare(`
    SELECT u.id AS userId, u.username,
      u.display_name AS displayName, m.role
    FROM household_memberships m
    JOIN family_users u ON u.id = m.user_id
    WHERE m.household_id = ? AND m.disabled = 0 AND u.disabled = 0
      AND u.account_kind = 'person'
    ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,
      u.display_name COLLATE NOCASE, u.id
  `).all(owner.id).map(row => ({ ...row }))
}
