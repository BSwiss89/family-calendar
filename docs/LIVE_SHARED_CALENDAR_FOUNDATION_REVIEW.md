# LIVE shared calendar foundation — draft, review only

**Verified LIVE origin:** `6377963372c30e8c4c4e33af6bf617d87961e989`

**Verified TEST source:** `8a558d4aa8d129976f058d567bac3754ce4cd519`

This is an isolated review of already-tested, pure source refactors. It does **not** authorize changing the running LIVE calendar. The dedicated PR base branch `review/live-shared-foundation-base-20261119` is pinned to the verified LIVE commit, so the pull request shows only these modifications. It is **not** a production deployment or direct approval for merging to a LIVE release branch.

## Exact proposed changes
1. Extract `isValidDate`, `isValidTitle`, `isValidPersonName`, `isValidColor`, and `cleanOptionalText` into `Server/calendar-input-validation.mjs`.
2. Extract `getRepeatRule` and `doesEventStartOnDate` into `Server/calendar-recurrence.mjs`. All seven original LIVE function bodies were compared byte-for-byte against the TEST-proven module definitions before changing the main server.
3. Make `src/familySiteRoutes.ts` an explicit **LIVE** adapter preserving the exact LIVE push, event invitation, household join, and assignment-notification endpoint paths. It contains no hostname detection and no routing or permission decision logic.
4. Adopt the same four frontend component blobs as TEST: `FamilyPushNotifications.tsx`, `useAssignmentInbox.ts`, `useFamilyEventInvitations.ts`, and `HouseholdEventJoin.tsx`. Each was checked to expand back to exactly the deployed LIVE component when adapter route references and comments are replaced with the original LIVE literals.
5. Run the existing LIVE CI and the new isolated validation, recurrence and endpoint adapter regression tests.

## Production boundaries
Do not copy TEST backend authentication, household sharing, private gateway, invitation data, database migrations, or deployment scripts. **No** database/schema changes, package changes, environment variables, cookies, HTTP registration, static routes, auth, secrets, release infrastructure, or LIVE deployment is included.

Before a production release, check both app health and authenticated/unauthenticated API access; verify all existing LIVE invitation, assignment, push, join/leave, and event recurrence behaviors; run exact-head CI plus protected preflight and backup checks against the actual installed LIVE SHA; request the owner's separate explicit LIVE deployment approval. Passing CI alone is not authorization. The review-only PR should **not** be merged as a shortcut to production.
