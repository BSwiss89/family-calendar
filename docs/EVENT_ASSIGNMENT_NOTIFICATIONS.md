# Event Assignment Notifications — staged implementation

This work is **development-only** until the user separately approves integration
and deployment. The Secure LIVE automatic release allowlist is *frontend-only*;
this module is backend code and must NEVER be deployed through the frontend-only
approval manifest.

## Agreed user behavior

- A **new event** alerts the people assigned to it.
- A **date, time or material detail change** alerts those still assigned.
- A **newly assigned person** gets an assignment notice; a **removed person**
  gets an unassigned notice, not a cancellation of the whole event.
- A **deleted event** alerts former assignees about cancellation.
- Reordered assignees, unchanged event saves, and unassigned events generate
  no noise. Recurring occurrence exceptions need separate handling.
- A wall-mounted **Home** profile is NOT a person and must not subscribe to
  private person notifications. User-selected profiles are not yet securely
  bound to a login identity.

## Stage 1: in this PR (NOT wired to LIVE)

`Server/event-assignment-notifications.mjs` contains a tested planner and a
small durable SQLite outbox. Rows only contain event ID, assignee person ID,
kind, and timestamps; **no event title, notes, or personal device endpoints**.
The queue helper is designed to run inside the caller's transaction so aborted
calendar edits cannot create phantom notifications. This PR does NOT alter
existing calendar event routes or migrations, register push subscriptions,
ask for browser permission, or send messages.

## Stage 2: prerequisites before user-visible notifications

1. Explicitly scope identity and device registration. Bind each user-owned
   device to an authorized person/account, not only to a selectable on-screen
   profile; owner/wall shared sessions must not leak assignee notifications.
   Keep household boundaries when the private multi-family candidate lands.
2. Integrate outbox insertion *atomically* into every relevant mutation:
   normal create/edit/delete, batch deletes, confirmed AI cancellations and
   reschedules, and one-off recurring exceptions. Create-before/after
   snapshots should use `event_people`, not the legacy `events.person` string.
3. Only with household access controls: authenticated per-assignee inbox and
   read/unread/dismiss APIs, isolated by household and authorized identity.
4. Register a service worker and a consent-driven push subscription flow
   on HTTPS. On iPhone/iPad, Web Push requires a Home Screen web app and an
   explicit user gesture to request notifications; no paid Apple developer
   membership is required. Use standard VAPID/Web Push delivery without paid
   external notification APIs, and no notification payload containing private
   event details.
5. Persist subscriptions per **device/session plus verified person identity**;
   revoke on logout, device revoke or household membership removal, purge
   expired endpoints; retry queued delivery with caps and avoid duplicate
   alerts. Device-switching profiles must not reroute private notifications.
6. Complete isolated two-family privacy and restart tests, then secure TEST
   and gated LIVE cutover with approved backups/restore/rollback.

## Relationship to existing PR #70

PR #70 contains a *different* private event-source outbox,
`Server/private-event-source-outbox.mjs`, used for event-only sharing and
central source reconciliation. It is not a push-notification delivery queue.
Do **not** install its triggers in the legacy LIVE database or merge the
household branches merely to enable notifications. Reconcile identity and
household scoping before connecting these features.


## Stage 2B: verified, consented device registry (this PR, still isolated)

`Server/verified-push-subscriptions.mjs` is a central-identity SQLite
**opt-in registry** with no HTTP routes, no service worker, no VAPID transport,
and no notifications sent. Nothing is added to the LIVE calendar schema.
It is not run automatically by any current server startup.

Important controls:

- Registration requires an actual unexpired, unrevoked, active login session,
  `explicitOptIn: true`, and an authoritative **server-side**
  account→household→person resolver. It refuses a shared Home display session
  or mismatched selected person. Selecting another person's UI profile is
  deliberately insufficient to gain notification access.
- The resolver must use a verified gateway session (not a body/query/header
  identity) and recheck member/account status, household and the person row.
  The already-written `getLinkedHouseholdPerson` under draft PR #70 supplies
  this foundation once approved and safely integrated. Both helper interfaces
  will need a narrow, reviewed adapter — no automatic integration is implied.
- The endpoint is uniquely owned by one verified session and identity; another
  account cannot silently take it. The module accepts only standard HTTPS
  push-provider hostnames (Apple, Google and Mozilla) with correctly shaped
  encryption keys. URLs are never treated as arbitrary fetch destinations.
- The internal dispatch lookup **rechecks** session validity, selected
  profile, account status and current verified person link on each lookup.
  When a device is revoked, Home is selected, or membership is removed,
  that device stops qualifying immediately. The returned endpoints/keys are
  secret server-side material and must never be echoed through a browser API.
- Per-device unsubscribe is restricted to the signed-in session. This is
  important before exposing actual opt-in registration.

Privacy caveats: This stage does not implement physical device ownership,
service workers, push transport, iOS permission UX, subscription expiry cleanup
or delivery retry. It does not verify a person account in LIVE because the
household account-to-person membership system is not yet installed there.
For a production rollout, the browser registration route must require secure
same-origin CSRF protection, an explicit user action and a freshly checked
authenticated account-person link. The dispatcher must recheck the event's
original household and the active recipient assignment before each send.
