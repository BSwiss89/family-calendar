# Notification inbox pilot — TEST baseline integration

Candidate branch: `feature/notification-pilot-test-release-candidate-20261101`
Origin: current `test-release` SHA `bd890b6933ac6bc90726489f19265bd994a7fb18`.
This branch is deliberately **not** a merge of the older divergent
`feature/auth-current-calendar-two-sites` branch; the existing TEST
household isolation, authentication, release safeguards, and frontend remain
untouched. Source notification modules were copied without incorporating
their older backend or family-auth files.

## Behavior and boundaries

- Default: `FAMILY_CALENDAR_NOTIFICATION_TEST_PILOT` is absent, so
  the new import has **no database migration, endpoints, or output**.
- Explicit opt-in: `FAMILY_CALENDAR_NOTIFICATION_TEST_PILOT=enabled`;
  `FAMILY_CALENDAR_PORT=13002`;
  `FAMILY_CALENDAR_AUTH_MODE=required`;
  backend checkout root matches `family-calendar-test*`.
- Pilot routes mount **after** existing required family-auth middleware.
  They display minimal generic notification events for the chosen person
  profile and deny Home or missing session. This **is not** private person
  identification: every member of one shared-account household can pick any
  profile. Therefore it is suitable only for a **single-family, nonprivate
  TEST pilot**, and never for multi-family tenants.
- The install initializes notification outbox, baselines existing events and
  creates SQL mutation triggers. No old existing event causes a notification.
  Event changes made by regular calendar REST/AI/batch SQL cause dirty rows.
  From `/test-notification-pilot`, **Refresh notifications from calendar
  changes** reconciles dirty rows in one SQLite transaction and shows rows
  corresponding to this device's selected person profile.
- No Web Push, browser push consent, background worker, VAPID, iOS alert,
  delivery guarantee or automatic reconciliation. Even after deployment,
  this only proves real calendar event-to-inbox behavior.
- It does not replace or modify existing holiday, events, shopping lists,
  meals, local AI, household gateway or profile picker code.

## Safeguards before any TEST deployment

1. Verify GitHub Windows CI for the **exact candidate SHA**.
   Its HTTP regression uses temporary synthetic SQLite, not the live site.
2. Independently inspect current Windows TEST checkout, source process and
   supervisor, HTTPS and live authentication. The in-progress TEST server
   typically listens on Tailscale IP port 13002.
3. Verified predeployment TEST SQLite backup:
   `C:\Users\bobby\CalendarBackups\NotificationTest\test-pre-notifications-20261101-194606-708.db`
   (SQLite integrity and independent copied restore verified by operator).
4. Verified source rollback archive:
   `C:\Users\bobby\CalendarBackups\NotificationTest\rollback-20261101-200453-531`;
   contains 261 tracked source files and task configuration exports,
   plus a separate built `dist` archive if the build folder existed.
   **This is not yet proof of a working application rollback.**
5. Before touching TEST, independently preserve any ProgramData launcher,
   updater and pin configuration, confirm unchanged current script hashes,
   prove restore and restart in an isolated disposable directory, and take a
   **fresh** consistent TEST SQLite backup for the cutover.
6. Explicit user authorization required **separately** for temporarily
   disabling Secure TEST Auto Deploy, modifying only TEST staging files,
   changing TEST backend startup environment and restarting TEST.
   Do not touch LIVE, GitHub main, `test-release`, LIVE deployment approvals,
   or the main live server task.
7. Existing TEST auto-deploy references Git checkout and test-release.
   It must be paused with separate explicit approval and later restored
   in a verified state; otherwise it can replace this temporary candidate.
8. Review whether the current TEST checkout is pinned to a commit or a
   branch. Do not reset, amend or move `test-release` automatically.
9. After approval, verify real HTTPS login, profile/Home choice, event
   edit/reassignment/cancellation, inbox, restart, health, unchanged
   previous event count on opt-in, and dry-run restoration. Roll back if
   any preflight fails.

## What GitHub CI does and does not prove

`node --test scripts/test-test-notification-inbox-pilot.mjs` checks
opt-in rejection, disabled default, session profile gating, clean initial
baseline, no repeated reconciliation, event changes, batch deletions,
assignments and recurring exceptions on a disposable Express/SQLite
fixture. Full TEST release Windows CI provides regression coverage for the
rest of the code. Neither proves actual running TEST installation health
until an authorized laptop rollout and end-to-end user test.
