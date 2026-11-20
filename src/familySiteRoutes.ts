// TEST installation route bindings only. Keep these exact deployed API paths.
// Shared UI logic must import this adapter instead of embedding site names.
// This is compile-time binding, not a runtime host guess or authorization check.
export const familySiteRoutes = Object.freeze({
  assignmentInbox: '/api/test-notification-pilot',
  assignmentRefresh: '/test-notification-pilot/refresh',
  eventInvitations: '/api/test-event-invitations',
  householdJoin: '/api/test-household-events',
  push: '/api/test-push',
})
