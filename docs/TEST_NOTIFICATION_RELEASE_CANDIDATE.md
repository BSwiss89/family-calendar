# Notification-only candidate for the **current TEST release**

**Status: prepared for GitHub CI only.** This branch originates from TEST
`bd890b6933ac6bc90726489f19265bd994a7fb18`. It is not the
`feature/auth-current-calendar-two-sites` development branch, which has
diverged substantially from the running TEST release.

## Scope

This carries only the tested opt-in single-family notification inbox from PR
#118 and its two local SQLite modules, plus a tiny TEST backend import/mount
and Windows regression test. It intentionally preserves the newer TEST
backend, private household isolation foundations, auth improvements, existing
configuration, and frontend exactly as they are in TEST release.

All behavior is **off by default**. The opt-in startup flag is
`FAMILY_CALENDAR_NOTIFICATION_TEST_PILOT=enabled`. Enabling it requires:
- TEST port `13002`, not LIVE `3001`;
- `FAMILY_CALENDAR_AUTH_MODE=required`;
- actual application folder ending in `family-calendar-test*`.

The optional `/test-notification-pilot` page uses the existing authenticated
TEST session, session-selected person profile and a read-only notification
outbox. Home has no inbox. A same-origin POST refreshes outbox intents from
actual event changes in TEST SQLite. This **does not send iPhone Web Push**
and cannot claim individual privacy when a family shares a login and may
switch profiles.

Do not use the pilot in the multi-household gateway or for independently
verified recipients. Underlying notification SQL creates and maintains
`assignment_notification_outbox`, `notification_event_baselines` and
`notification_dirty_events`, plus local SQLite triggers. No schema is
installed while the flag is disabled.

## Safety gates before any real TEST deployment

1. Obtain explicit permission for `test-release` merge and **separately**
   for updating the running TEST backend. This candidate PR must remain
   unmerged until deployment and auto-update behavior is understood.
2. Confirm `Family Calendar Secure TEST Auto Deploy` is not racing
   a manual rollout. Inspect and preserve its task definition. Do **not**
   alter scheduled tasks until the operator explicitly approves.
3. Verify the known TEST commit, clean source tree, expected SHA and service
   PID. Confirm the actual TEST data path and private household storage mode
   are the expected single-household legacy site.
4. A previous consistent TEST SQLite backup already passed an isolated
   hash, integrity and FK-check restoration rehearsal. Take a **new**
   consistent backup immediately before any schema migration and verify
   it again. Preserve upload content and the running TEST frontend/package
   trees if needed for full application rollback.
5. Record the original TEST and LIVE HTTP health, user logins, device
   profiles, events and lists. Rehearse restoration on **isolated paths
   and ports** before changing the live TEST service.
6. CI must pass for the candidate **built from test-release**, not only
   PR #118 on the older development branch. Protect both LIVE and TEST
   from any change to package manifests/locks or running scheduled tasks.
7. Stage via a reviewed manual, narrow TEST release process using exact
   expected SHAs. Restart only the TEST server with an explicitly approved
   temporary flag; verify its HTTPS origin, auth/cookies, events, inbox,
   cross-profile display and Home exclusion. Never alter LIVE or main.
8. Rollback plan: stop only the approved TEST process, restore the
   previously verified TEST source/build, SQLite database backup and
   original startup configuration if any step fails. Validate TEST
   HTTPS health, accounts, events/lists and DB integrity before re-enabling
   the original updater configuration.
9. Profile picker is **not** a person-verified identity. These generic
   notices are suitable only for a private, single-family demonstration.

## Recovery artifacts already verified on the laptop

- SQLite backup:
  `C:\Users\bobby\CalendarBackups\NotificationTest\test-pre-notifications-20261101-194606-708.db`
  (120 KiB, integrity and isolated copy/hash/FK rehearsal passed)
- Source checkout + task XML checkpoint:
  `C:\Users\bobby\CalendarBackups\NotificationTest\rollback-20261101-200453-531`
  (261 source archive entries, based on `bd890b69`).
- These backups alone do not prove an application restart/rollback.
  There is no evidence yet of a successful **actual** TEST notification
  trial; none is claimed.

**Do not merge this draft PR into test-release without separate permission.**
