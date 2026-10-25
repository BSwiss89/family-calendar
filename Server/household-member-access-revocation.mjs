// Central-identity-only revocation. Never delete logins, People, calendar data,
// uploads, or access belonging to another household.
export function revokeHouseholdMemberAccess(identityDatabase, {
  householdId, serverVerifiedOwnerUserId, targetUserId,
}) {
  if (typeof householdId !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(householdId) ||
      !Number.isSafeInteger(serverVerifiedOwnerUserId) ||
      serverVerifiedOwnerUserId < 1) {
    throw new Error('Active household owner permission required.')
  }
  if (!Number.isSafeInteger(targetUserId) || targetUserId < 1) {
    throw new Error('Invalid member.')
  }
  identityDatabase.exec('BEGIN IMMEDIATE')
  try {
    const owner = identityDatabase.prepare(`
      SELECT h.id AS householdKey FROM household_registry h
      JOIN household_memberships m ON m.household_id = h.id
      JOIN family_users u ON u.id = m.user_id
      WHERE h.storage_id = ? AND m.user_id = ?
        AND h.disabled = 0 AND m.disabled = 0 AND m.role = 'owner'
        AND u.disabled = 0 AND u.account_kind = 'person'
    `).get(householdId, serverVerifiedOwnerUserId)
    if (!owner) throw new Error('Active household owner permission required.')

    // Scope the update to the specific household and an active person member.
    // Owners/hubs cannot be removed through this endpoint.
    const removed = identityDatabase.prepare(`
      UPDATE household_memberships SET disabled = 1
      WHERE household_id = ? AND user_id = ? AND role = 'member' AND disabled = 0
        AND user_id IN (SELECT id FROM family_users
          WHERE account_kind = 'person' AND disabled = 0)
    `).run(owner.householdKey, targetUserId).changes === 1
    identityDatabase.exec('COMMIT')
    return removed
  } catch (error) {
    identityDatabase.exec('ROLLBACK')
    throw error
  }
}
