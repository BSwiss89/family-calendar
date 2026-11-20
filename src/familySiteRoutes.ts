// LIVE production site route bindings only. Preserve these authenticated endpoints.
// Common UI components depend on this adapter instead of embedding site names.
// No runtime hostname guessing; route names do not confer authorization.
export const familySiteRoutes = Object.freeze({
  assignmentInbox: '/api/live-notification-pilot',
  assignmentRefresh: '/live-notification-pilot/refresh',
  eventInvitations: '/api/live-event-invitations',
  householdJoin: '/api/live-household-events',
  push: '/api/live-push',
})
