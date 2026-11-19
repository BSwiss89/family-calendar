# Environment route isolation for common calendar UI

This targeted TEST refactor separates intentional site-specific route names from four otherwise shared React components. **It does not change any API path or API behavior.** TEST keeps its currently deployed authenticated single-household endpoints.

- \`src/familySiteRoutes.ts\`: the only route-specific binding for assignment inbox, event invitations, household participation, and family push.
- \`src/FamilyPushNotifications.tsx\`, \`src/useAssignmentInbox.ts\`, \`src/useFamilyEventInvitations.ts\`, and \`src/HouseholdEventJoin.tsx\`: use those constants instead of embedded TEST-specific paths.
- CI verifies exact TEST endpoint strings and that these components no longer embed site-specific URL literals.

**Important:** This is preparation for a future separately reviewed LIVE code change. Do not copy TEST's \`familySiteRoutes.ts\` to LIVE, because LIVE uses different endpoint names. When an explicit LIVE change is approved, create a separate LIVE adapter preserving LIVE's exact authenticated endpoints and independently confirm its production behavior. This PR does not change LIVE, branch topology, databases, routes, auth, cookies, deployment tasks, or test-release safeguards.

The separate LIVE-only and TEST-only backend implementations remain intentionally distinct. Multi-household preview and sharing experiments remain outside this refactor. A matched shared component does not, by itself, prove that promoting TEST code to LIVE is safe.
