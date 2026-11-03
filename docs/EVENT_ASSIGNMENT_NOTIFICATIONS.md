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


## Stage 2C: trusted assignment-to-device dispatch preview (isolated)

\`Server/trusted-assignment-dispatch.mjs\` joins the event assignment outbox
from Stage 2A with the verified device registry from Stage 2B, but **does
not send any push notification, acknowledge delivery, or expose an HTTP API**.

The caller must supply a physically verified single-household SQLite DB and
the independent central identity DB. A \`verifySourceHousehold\` function must
confirm the database is exactly the claimed trusted household from the
server-side gateway's storage selection; a browser-provided household label
does not count. Failure stops before looking up event or device data.

Every notification is checked against the CURRENT household event state:
- \`assigned\` and \`changed\` require a current \`event_people\` assignment;
- \`unassigned\` requires the event still exists and person is no longer assigned;
- \`cancelled\` requires the event no longer exists;
- when multiple pending intents exist for one event/person, only the latest
  pending intent is eligible;
- expired/revoked/disabled sessions, changed Home selections, and revoked
  person memberships are filtered by the Stage 2B verified-device resolver.

Secrets (push endpoints and encryption keys) are provided only to internal
future dispatch code, **never** to a browser. Tests include same numeric event
and person IDs in TWO different household databases, mismatched physical
storage, replay/stale suppression, cancellation, reassignment, Home switching,
account and session revocation, and fail-closed resolver behavior.

**Not yet completed:** production wiring to event create/edit/AI/batch routes,
immutable event identities across DB restores, authorization-bound dispatch
serialization and durable delivery receipts, duplicate handling across crashes,
device permissions/service workers/VAPID, explicit recipient preferences,
and end-to-end two-household tests. In particular, merely running this
preview repeatedly is NOT a production deduplication strategy: a sender
can deliver twice if it crashes after sending but before acknowledging.
Do not infer readiness for production Web Push from these tests.


## Stage 2D: transaction-bound SQL mutation capture and restart-safe intent reconciliation

**Development-only, NOT installed in any calendar server.** The optional
\`Server/notification-event-mutation-capture.mjs\` module creates
\`notification_dirty_events\` and \`notification_event_baselines\` only when
\`installNotificationMutationCapture\` is explicitly called by an isolated
test or a future authorized migration. No current application startup calls it.

Rather than adding notification hooks to just one event form handler, nine
SQLite triggers record mutations to \`events\`, \`event_people\` and
\`event_exceptions\`, including direct SQL changes made by AI and batch deletes.
They run inside the **same transaction** as the event change and roll back
with failed edits. A recipient-agnostic revision per event records the net
change even across restarts, without storing titles, notes or event location in
the dirty queue. (The hashed material fingerprint and sorted assigned person IDs
are stored in the protected local baseline table.)

The installer baselines pre-existing event data *before* arming triggers, and
never re-baselines on a subsequent call, preventing existing appointments from
spontaneously alerting everyone. \`reconcileNotificationMutations\` acquires a
SQLite write lock, checks committed current data against the persisted prior
baseline, uses Stage 2A to queue per-person assigned, changed, unassigned and
cancelled intents, updates that baseline and acknowledges the dirty revision,
then commits everything atomically. A crash or error rolls the entire
reconciliation transaction back. Replaying an already-reconciled event doesn't
create duplicate intent rows.

Recurring exception inserts/deletes currently produce **series changed**
intents, not occurrence-specific cancellation notifications. We need an
occurrence-aware design before sending individual recurring-event alerts.

**Known limitations / next gates:**
- This is event ID-based and coalesces all changes before reconciliation;
  deleting and recreating the *same numeric event ID* before the next
  reconciliation yields a net change. Production should use immutable event
  identities from isolated PR #70 and a versioned dispatch receipt.
- A reconciliation can collapse intermediate changes even across separate
  committed SQL transactions; this is useful for noise prevention, but a
  delivery worker must not presume every historical intermediate action was
  emitted.
- This only durably queues **notification intents**. It does not provide
  exactly-once phone delivery. A crash after Web Push sends but before an
  acknowledgement can resend; design per-device receipts/idempotency before
  enabling delivery.
- Must still stage the approved migration, trust boundaries, selected-household
  binding, opt-in browser UX, Web Push/VAPID and two-household integration
  checks. No LIVE database migration, no TEST change, no automatic deploy.

Dedicated tests exercise direct SQL/AI-style edits, new event assignments,
person removals/additions, recurring exceptions, batch deletion with cascades,
rollback, read/ack atomicity, coalesced no-op, simulated restart of an actual
file-backed SQLite DB, and missing outbox recovery.


## Single-family real TEST inbox pilot — optional, disabled by default

This pilot addresses the gap between isolated GitHub unit tests and the actual
running calendar. It adds a guarded \`Server/test-notification-inbox-pilot.mjs\`
integration after the existing secure family-auth middleware. It is
**disabled by default** and installs no schema or routes when disabled.

Only a separately authorized **TEST** operator may set
\`FAMILY_CALENDAR_NOTIFICATION_TEST_PILOT=enabled\` for the existing test
backend. All of the following are required or startup refuses to enable:
- Actual server port \`13002\`, not LIVE \`3001\`.
- \`FAMILY_CALENDAR_AUTH_MODE=required\`, including HTTPS session-cookie
  authentication and same-origin POST protection from the existing middleware.
- The source checkout directory must be a \`family-calendar-test*\` tree,
  not a LIVE or general preview folder.

Once explicitly enabled, it installs the optional Stage 2A outbox and 2D SQL
mutation capture on the TEST SQLite database. Existing events are baselined,
so they do **not** generate an initial notification flood. A signed-in person
may open \`/test-notification-pilot\` on the TEST site's HTTPS origin, perform
real calendar creates/edits/AI reschedules/cancellations in the normal TEST UI,
then press **Refresh notifications from calendar changes**. The server
reconciles the TEST event changes and renders a read-only inbox for the
person profile selected on *that session*. Refresh is same-origin POST.
A Home profile is denied; event title/notes are not returned in the inbox.
The \`/api/test-notification-pilot\` endpoint provides the same records as
minimal JSON, without push credentials or other people's rows.

**Very important:** The existing one-family calendar uses a **shared login
with selectable people profiles**. That selection is not strong person
authorization; this is a household TEST display-only pilot, NOT a private
multi-family notification inbox, NOT production push, and NOT evidence that
the eventual server-verified per-person account/device mapping is installed.
It must not be enabled for the private multi-household gateway or on LIVE.

Before any TEST activation:
1. Record current LIVE/TEST commit and actual process/port identity; confirm
   dedicated nonshared TEST SQLite and enabled cookie authentication.
2. Verify scheduled TEST updater policy; do not let an auto-deploy or boot task
   overwrite a manually staged candidate. Preserve current task definitions.
3. Make and verify a consistent TEST SQLite backup (integrity check), source
   checkout and rollback artifacts. Test restoring onto an **isolated** path.
4. Run the entire existing Windows CI suite and isolated real-backend
   checks, then seek **separate explicit authorization** for TEST deployment,
   backend restart, and enabling the opt-in flag.
5. Check HTTPS TEST health, login/profile, normal event/list behavior,
   changes to the TEST inbox, Home exclusion, restart behavior and rollback.
6. Do not deploy to LIVE without a separate fully reviewed cutover, and never
   use the frontend-only Secure LIVE automatic release approval for this.

The pilot only records and displays **generic in-app notices**. It cannot yet
send notifications to an iPhone while the web app is closed. True Web Push
still requires VAPID, a service worker, consent flow, device-specific delivery
tracking, and complete identity/household authorization.

The HTTP tests in \`scripts/test-test-notification-inbox-pilot.mjs\` use isolated
synthetic SQLite and a synthetic authentication fixture. They prove the
route functionality and secure opt-in gates, **not** the state of the real
Windows TEST website. That site must be explicitly checked and exercised.
