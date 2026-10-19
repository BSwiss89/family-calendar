# Phase 2 foundation: isolated storage per household

Status: **draft / private test-only**. The regular Family Calendar server
continues to use its original SQLite database. The storage resolver is wired
into the backend only behind an explicit test flag with a loopback-only
listener on a nonproduction port. No households are created at startup.
This PR does NOT expose another calendar to outside devices and does NOT
change existing preview or live data.

Tracking: issue #45. Depends on draft auth PR #44 and Arney PR #43.

## Private upstream credentials and AI lockdown — nonproduction only

Private household Node backends in test mode now refuse ALL direct HTTP requests
without their server-configured 256-bit, household-specific upstream secret,
including event APIs, lists, uploaded files, static assets and health checks.
The test gateway strips any browser-provided service-token header and inserts
only the trusted secret for the household selected by the authenticated session.
Secrets must be nonempty, well-formed and distinct per household. The
disposable demo provisions new random credentials for every run; neither
tokens nor backend routes are included in the browser or exposed by APIs.
Tests prove missing, malformed and wrong-family direct credentials cannot
access local endpoints, while authenticated proxying still works.

**Important limitation:** This protects against other ordinary localhost
clients, but secrets stored in process environment do NOT defend against a
compromised same-account operating-system process, administrator, or malicious
package. It is not a substitute for OS account/process isolation, service
identity attestations and audited production networking. Loopback-only
listeners are STILL mandatory; do not enable Tailscale Funnel or expose a
backend listener outside localhost.

Until a durable per-household AI usage cap, GPU scheduling, and AI route/data
privacy review exist, the private multi-family gateway responds with 409 to
POST AI command/model routes and vision/capture-analysis routes. Otherwise,
one household could exhaust the shared Ollama GPU budget or execute an
unreviewed calendar write path. These guards apply ONLY to the draft private
gateway; the live single-family calendar retains all its existing Arney and
photo analysis capabilities. Household capture-inbox records and uploads
remain stored in each household's isolated folders, but analysis is withheld
in this private preview.

## Private gateway: fail closed on unaudited event mutations

The private multi-family gateway now uses one canonical mutation route policy
(`Server/private-gateway-mutation-policy.mjs`) both to authorize an event
write and to determine which individual event must be written to the durable
sharing journal. This avoids separate URL parsers disagreeing about a route.

It rejects alternate calendar-changing API paths which are **not** yet
journaled: `POST /api/ai/cancel-confirmed`,
`POST /api/ai/reschedule-confirmed`,
`DELETE /api/event-batches/:batchId`, recurrence-exception mutations, and
noncanonical event paths (case variations, leading-zero numeric IDs,
trailing slashes, encoded identifiers). These are blocked ONLY through the
test household gateway; they remain unchanged on the existing live,
single-family calendar. Canonical `POST /api/events`,
`PUT /api/events/:id` and `DELETE /api/events/:id` remain available and
the latter two use the durable per-event journal.

Regression checks run in the deployment-safety workflow as both pure policy
unit tests and an authenticated two-family gateway integration test. These
blocks are temporary product limitations, not final implementations: each
currently rejected action needs a trusted affected-event change journal,
atomic reconciliation and cross-family tests before it can be enabled in
the multi-household service. More work remains on local AI privacy,
unauthenticated backend bypass prevention, endpoint inventory,
uploads, resource budgets and privileged account administration.

## Offline multi-household restore preflight (no restoration implemented)

`Server/private-restore-preflight.mjs` is a read-only safety gate for an
**explicitly staged, offline private-test restore set**, NOT an instruction to
restore the running Calendar. Its test-only fixture lives entirely in the OS
temporary directory. No backend, gateway, scheduler, Tailscale or live SQLite
database is stopped, replaced, or reconfigured by this module.

The staged root must be OUTSIDE the checkout, be marked by an explicit
`.family-calendar-restore-review.json` with
`{ "kind": "private-household-offline-restore-review", "version": 1 }`,
and contain exactly:

    staging/
      .family-calendar-restore-review.json
      central/identity.db
      households/<registered-id>/
        .family-calendar-household.json
        data/calendar.db
        uploads/... all backup image files ...

The preflight refuses uncheckpointed SQLite `-wal`/`-shm` companions,
unknown or absent tenants, symlink escapes, missing markers/files, SQLite
quick_check/foreign-key-check errors, missing permanent event IDs, duplicated
event IDs, and **any** queued/unacknowledged share changes. Each pending or
accepted invitation must match its *current* source event's permanent UID and
all allowlisted title/date/time fields. A mixed snapshot cannot silently
rebind another event under a reused numeric row ID.

It also **refuses any restored login session that is still active**. A separate
audited process must revoke sessions on a disposable, offline staging copy;
users must log in again after any future approved restore. This is a defense
against reviving lost/revoked devices through a database rollback; it is NOT
a complete protection against reverting membership changes or account
disabled flags recorded after the snapshot.

`attestOfflinePrivateRestoreSet(...)` builds a deterministic SHA-256 inventory
of the staged central database, every family DB and marker, every upload and
the review marker. Capture only after all database writers have been fenced
and every SQLite file consistently checkpointed/copied, then keep its
attestation in a **separate trusted backup catalog**. Later
`verifyOfflinePrivateRestoreSet(..., approvedAttestation)` requires that
external attestation and rejects changes/swapped copies. Recalculating or
accepting a new attestation from a suspect restore candidate would defeat
this independent integrity check. File hashes establish equality with the
approved catalog, **not** authenticity, backup-time consistency, or a safe
point-in-time recovery on their own.

**Still not production-ready:** coordinated multi-SQLite snapshot creation,
trusted/offline catalog signing and retention, external account/role
revocation checks, backend fencing, staged session sanitization,
restoration order and atomic cutover, durable journal resolution,
upload-reference coverage, offsite copies, complete rollback, and a verified
full end-to-end restoration rehearsal. This is a conservative REJECTION
preflight only, with no automatic restore/promotion path and no production
configuration touched.

## Event identity hardening — private household test mode

The private household backend now installs `Server/private-event-identity.mjs`
**only when explicitly running the nonproduction household test mode**. Every
source event has a persistent, randomly generated 128-bit `event_uid`, separate
from its SQLite integer row ID. A one-time backfill runs only on the selected
private test household database; SQL triggers assign identities for later
inserts and prohibit changing or explicitly supplying an identity. Edits keep
the same identity. A delete followed by an insert using the old numeric ID
receives a new identity.

The central event-share table stores `source_event_uid` alongside the
numeric row ID. Invitations are created only when the trusted source has an
assigned identity. During synchronization, a shared snapshot updates **only**
when its saved identity matches the current source event. Pending or accepted
grants from a deleted event are cancelled when their numeric row ID is reused;
they can never be refreshed with the replacement event's title/date/time.
Any legacy active share with no verified identity is cancelled rather than
silently rebound. Historical inactive invitation records are kept for review.

**Limitations:** This is not an authorization to migrate the live family
database. No production household routing exists yet. Out-of-band SQLite
changes and restores still need authoritative change detection and source
database fencing; an unjournaled out-of-band delete may temporarily leave
an OLD snapshot visible until reconciliation. UUIDs prevent it from silently
becoming a share of an unrelated NEW event, but do not substitute for a
production-grade transactional change log and restore-safety design.
Restore/replacement of a whole household database and the central identity
database must be coordinated and reverified before external access.

## First slice in this PR

Server/household-storage.mjs provides two intentionally separate operations:

- provisionEmptyHousehold(...): **explicit**, new-only provisioning. Creates
  an empty SQLite database and its own uploads folder under a household slug.
  Refuses to overwrite an existing household. Never copies a family's events,
  photos, passwords or lists into a friend's calendar.
- resolveHouseholdStorage(...): read-only validation. A configured household
  MUST already have a matching marker, data folder, SQLite database and uploads
  folder. Missing or mismatched components stop startup instead of silently
  falling back to the original family's database.

With no household configuration, resolution returns the legacy paths unchanged.

Example logical layout (not created on a laptop by this PR):

    <PRIVATE_STORAGE_ROOT>/
      households/
        family-a/
          .family-calendar-household.json
          data/calendar.db
          uploads/
        friends-b/
          .family-calendar-household.json
          data/calendar.db
          uploads/

An account from family A has no direct path or database connection to family B
simply by virtue of knowing its slug. Slugs are validated and chosen by trusted
administration, NOT from request URL, headers, body or browser local storage.

A test fixture creates empty household databases in disposable OS temp folders,
writes family-A-only data, and confirms no such data appears in family B.
The tests also exercise refusal of path traversal, missing marker, missing DB,
overlapping source checkout and repeat provisioning. No live data is read.

## Real two-household backend smoke test

scripts/test-household-instance-isolation.mjs creates two disposable empty
households outside all checkouts, starts two real backend Node instances on
separate random 127.0.0.1 ports, and verifies events, lists, and identically
named uploaded files remain isolated. It stops both servers and removes the
disposable databases. This is a physical-storage test, not an authentication
or public-gateway test.

When both environment settings FAMILY_CALENDAR_HOUSEHOLD_STORAGE_ROOT and
FAMILY_CALENDAR_HOUSEHOLD_ID are set, the backend also demands
FAMILY_CALENDAR_HOUSEHOLD_TEST_ONLY=YES, HOST=127.0.0.1, and a
nonproduction port. An unknown household is rejected before accessing any
SQLite database. Without those settings, legacy behavior remains unchanged.

## Offline household membership grant model

The new Server/household-memberships.mjs module builds tables for household
names and user-to-household role grants in a **separate, central identity
database**. It reuses the PR #44 family_users model for the *future central*
identity registry; it does NOT transfer or read any existing passwords or
sessions. Only a server-authenticated user's identity may be passed to the
lookup function. The requested household name is an untrusted *filter*, not
permission to access its storage.

The lookup returns a household only when that account is active, the
household is active, and a non-revoked membership exists. Synthetic tests
cover guessed household IDs, disabled users, revoked memberships, duplicate
grants, and deliberate shared memberships. No membership HTTP endpoints
or administrative provisioning UI exist yet.

CRITICAL: This registry is still **unconnected to network routing**. The
temporary household backend instances intentionally disable login and bind
only to 127.0.0.1 for tests. They are NOT safe to publish, including through
a reverse proxy that lacks an authenticated, membership-checking gateway.
Do not invite additional families yet.

## End-to-end central authentication test gateway (private only)

Server/private-household-gateway.mjs combines the previously isolated pieces
in a **loopback-only test harness**. It starts on an OS-selected 127.0.0.1
port, accepts existing PR #44 password login and trusted-device sessions
against a disposable CENTRAL identity SQLite database, checks the authenticated
account's currently active household membership for every request, and streams
calendar API calls, lists, frontend assets and uploads to the corresponding
**loopback-only** household backend.

A person with a single active membership is routed to that household.
Zero memberships return HTTP 403. Multiple memberships return HTTP 409
until the user explicitly chooses one via an authenticated, CSRF-checked
POST /api/households/select call. The selection is saved server-side for
that particular trusted-device session, rather than in URL, local storage
or a client-controlled cookie. GET /api/households lists only households
the current account is authorized to use, and an inactive session or
revoked membership instantly invalidates a selection. Different devices
can make independent choices. A client-supplied household in a forwarded
API query/header NEVER overrides this trusted selection. Login endpoints
are never sent to a backend. Auth cookies and proxy-forwarding headers
are stripped before a request reaches the household; upstream Set-Cookie
and unsafe redirects are not passed back to the browser.

scripts/test-private-household-gateway.mjs creates two disposable family
databases and a central identity database, runs two real private backend
Node processes and a single test gateway, performs distinct password logins,
and tests events, shopping lists, identically named uploaded pictures,
unauthenticated requests, malicious tenant hints, explicit household
selection, independent device preferences, CSRF rejection, immediate
membership revocation and disabled users.

**This is NOT production/public-ready.** The gateway intentionally has no
public listener or stable deployment port, and the individual backend
processes deliberately disable auth in this isolated test. Future work must
attest the upstream server's household identity, enforce local service
isolation and administrative-only configuration, provide a safe household
switcher, examine every endpoint including local AI and backup jobs, and
run dedicated recovery and security reviews. No existing preview or live
accounts are migrated by this test.

## Username-based profiles (Account UI)

The Family Account page now displays the authenticated username and a
**Switch username** control. This signs out the current trusted-device
session and returns to the username/password login. The next login selects
the identity account, and the server checks which household(s) that
identity has been granted. A username is NOT itself proof of access.

Two usernames can share one household (one family calendar) through their
own explicit memberships; a different username can be a member of a
different household. The private gateway automatically selects a household
when the account belongs to exactly one household. Advanced accounts with
multiple household memberships still have protected server-side selection
support, but are NOT given an account-page household picker in this
username-focused design. The existing preview still has only its
legacy familyadmin identity until central account provisioning/migration.

Never silently change an account by typing a new username in a request
header, URL, or local setting, and never switch without authenticating
that separate account.

## Important: not yet multi-family login

PR #44's accounts are currently associated with ONE SQLite database, and all
signed-in users still see that database. This library does not change that.
**Do not create friend accounts in the existing calendar. Do not enable a public
Funnel for other families on the basis of this PR.**

The production migration needs a separate review and verified restore test:
the existing live database stays intact until the owner's household has
been migrated and tested with the new storage layout. Back up accounts,
calendar data and image uploads before any such move.

## Event-only cross-family sharing — strict product requirement

Cross-household sharing does **NOT** grant access to another family's
calendar. Every household keeps its own independent calendar, and every
individual has a personal username mapped to their authorized household
membership(s). Household members may share one manually selected event,
several manually selected events as independent grants, or one selected
event with multiple recipient households. **Never implement a full
calendar subscription / Share entire calendar feature.**

- Events are private unless the source household expressly invites
  a named, authorized recipient household to one particular event.
- The recipient sees only each accepted shared event interleaved with
  its own household's events. Receiving one invitation conveys ZERO
  membership/access to the sending family, including its other events,
  event IDs, people, lists, meals, photos, notes, or AI history.
- Repeated events require an explicit scope choice: one occurrence
  or an entire recurrence series, never an implicit wider grant.
- Share invitations have pending, accepted, declined and revoked states.
  Optional fields (notes, address, attachments, participant names)
  require an explicit field-level privacy decision and should default
  to not shared.
- All synchronization is from the source of truth to a controlled
  shared-event view/snapshot in the recipient household. Recipients
  cannot change the originating event. Edits, cancellations and
  revocations affect ONLY selected event/share grants.
- A sender can revoke one recipient's access to one event without
  impacting a different event or a different recipient.
- Build regression tests: sharing A's BBQ with B must not expose
  either of A's other events; sharing A's second selected event
  adds only that event; B cannot fetch the source household through
  crafted URLs, IDs or direct uploads.
- Individual usernames are authentication identities. Event invitation
  or acceptance NEVER creates household membership in the source.

### Implemented in this PR: offline selected-event sharing model

Server/event-only-shares.mjs now provides an explicitly selected-event,
central-database invitation model and privacy-limited event snapshots. Its
server-only functions create pending grants for individual event/recipient
pairs, accept/decline by recipient household membership, revoke individual
grants from the source, list a recipient's pending/accepted *selected*
events, and refresh/cancel one source event's existing snapshots. Title,
date, start/end time and source household display name are the only
fields copied; source notes, location, people and other calendar records
are NEVER copied to shared snapshots.

Sending several events creates independent grants, so revoking one does
not revoke another event or a second recipient. Each batch is atomic and
bounded. Recurrence is deliberately REJECTED until there is an explicit
single-occurrence vs series-sharing choice. Unknown events, invalid IDs,
unauthorized users, wildcard recipients and accidental full-calendar
sharing are rejected. All rules are covered by disposable SQLite tests.

### Authenticated private gateway integration (in-progress testing)

The loopback-only test gateway now owns these authenticated, CSRF-checked
event-only endpoints (not reachable from the public internet):

- GET /api/shared-events/recipients lists only explicitly trusted contacts
  for the signed-in household, never a public household directory.
- POST /api/shared-events/invite requires specifically selected event IDs
  and recipient household IDs. The gateway resolves the current household
  from the verified login and opens only its approved SQLite file read-only.
  The browser cannot choose another source family or a database path.
- GET /api/shared-events/invitations returns only pending invitations to the
  currently authorized recipient household.
- POST /api/shared-events/:shareId/respond accepts or declines an invitation
  for the current recipient household, not another household the same user
  might belong to.
- GET /api/shared-events/accepted returns only accepted event snapshots.
- GET /api/shared-events/sent shows the current source household's active
  individual invitations, their approved recipient names and statuses; this
  does not disclose recipient calendar content.
- POST /api/shared-events/:shareId/revoke removes an individual invitation or
  accepted share from its originating household.

The gateway blocks all other /api/shared-events paths instead of proxying
them to an unauthenticated per-household backend. Trusted household
connections are provisioned only by server-side administration in tests;
there is no client endpoint to link households or expose a directory.

### First automatic synchronization slice (private gateway only)

Successful PUT /api/events/:id and DELETE /api/events/:id requests routed
through the authenticated, loopback-only gateway now trigger a read-only
lookup of the matching source event and update/cancel only its existing
explicit share snapshots in central SQLite. Failed validation, rejected
HTTP responses and wrong-household requests cause no sync. Editing a
previously shared, nonrecurring event into a recurrence cancels the old
one-time grant; it does not expand sharing to an entire series.

A disposable integration test changes a shared source event's title/date/time
through a real backend and checks the recipient sees exactly those new
fields without private notes, location or other events. It tests that a
deletion cancels the share and leaves both household calendars unchanged
apart from the owner's requested mutation.

**Known limitation: this is not yet guaranteed crash-safe delivery.** A
backend commit and central share snapshot update are different SQLite
transactions. A power failure or sharing sync error between them can
temporarily leave stale data. The hook currently logs failures; a future
durable replay/reconciliation mechanism is required. The code does NOT
yet cover delete-by-batch, AI reschedule endpoints, edits made directly
in SQLite, recurring-event exceptions, or any other mutation route.
Permanent source-event IDs now protect the private test sharing model against
reused numeric SQLite IDs. Production still needs comprehensive mutation
coverage, coordinated restores and stale-share reconciliation.

**Remaining incomplete:** This is test-only HTTP routing; the
invitation controls and calendar overlay are present only as frontend
code and not connected to a real multi-family browser deployment yet.
Cancellation notices, durable retries and reconciliation, restoration,
safe recurring sharing, attachment permissions, trusted friend-contact
onboarding and production security review are pending. The existing
preview and live calendar are not migrated or opened publicly.

## Next small implementation slices

1. Completed in this PR: a private, loopback-only opt-in with real two-server
   isolation tests. This feature is NOT a deployable multi-household gateway.
2. Build a central identity/household membership registry and authenticated
   router/gateway. The gateway determines authorized household context
   from server-side membership. User input must not select arbitrary tenants.
   Backend listeners are not publicly accessible, and no direct URL may bypass
   the gateway. Keep login persistence and device revocation from PR #44.
3. Audit all calendar APIs, uploads, AI commands, list/meal/recipe endpoints
   and backups for tenant-specific storage and deny-by-default behavior.
   Test crafted requests, guessed IDs, upload filenames and role changes.
4. Only after isolation passes, add cross-household event invitations and
   an authoritative shared-event mirror with accepted/rejected/revoked states.
   Recipients see ONLY explicitly shared fields. Never duplicate unrelated
   household data or allow the recipient to change the source event.
5. Rehearse restoring every household's data and central identity/share
   records together. Enable remote public access only after review, security
   tests, approval and correct authentication on every path.

## Accepted event display: read-only calendar overlay (test candidate)

The calendar frontend now loads `GET /api/shared-events/accepted` only
when the Calendar page is open. Accepted share snapshots are stored in
separate React state, **never in the editable local `CalendarEvent[]`**
array, so coincidentally matching event IDs cannot invoke local event
edit/delete actions. The display uses a strict field allowlist
(shareId, sharedBy, title, start/end date/time), rejecting malformed
dates/IDs and ignoring notes, locations, attachments, participant details
and any other unexpected server fields.

A clearly labeled "Shared with our family" read-only strip shows
received events for the calendar's visible month/week/day/schedule date
range. Month cells also show a read-only shared-event label, separate
from local event buttons, while preserving space for existing local
events. The strip provides access to multiple received events for a day
without treating a share ID as a local event ID.

The legacy single-family backend does not implement that endpoint:
unexpected HTML/404/non-JSON or fetch failures produce **no overlay**,
leaving live and existing preview calendars unaffected. The view
refreshes on focus, visibility and a 30-second interval; it never
chooses a tenant or performs any sharing mutation.

The read-only field/parser and date-range filtering have dedicated
Node tests (`scripts/test-shared-event-overlay.mjs`) included in
Deployment safety. There is **not yet a live multi-family gateway
preview** to visually inspect these chips as actual accepted shares;
this is code and automated tests only.

## Individual-event sharing, desktop Invitations and mobile reminders

There is now exactly **one Share Event button per eligible event**, located
inside that event's detail window. The former "Share Events & Invitations"
button on the Events page is removed. Clicking Share Event opens a centered
modal **over Event Details** in a document-body portal, with an independent
scroll area, visible backdrop, Escape-to-close and keyboard focus management.
The opened event is already selected and fixed: the user chooses one or more
previously connected families (up to 8) and must explicitly confirm sending.
This cannot expand into a calendar-wide subscription. Recurring source events
cannot be shared yet; a safe occurrence/series selector is still required.

The desktop/tablet **left sidebar has an Invitations tab** with a pending
count and Accept/Decline controls. Accepted events are read-only on the
recipient's normal calendar, including cards under the Day view's
Today's Events section. They never become an editable source event in
the receiving family's SQLite database.

On mobile (viewport up to 760px), pending invitations automatically show
in a separate foreground dialog when the app opens. For each event:
**Accept**, **Decline**, or **Remind Later**. Remind Later changes ONLY local
presentation state; the invitation remains pending on the server and is
offered again when the app reopens/reloads or next comes back from the
background. It does not set a background push notification or depend
on a permanently running app. Multiple invitations can be reviewed in
that same dialog. Desktop/tablet do not get an automatic interruption.

Invitation responses are still authorized against the logged-in
household by the central private gateway; other families' event details,
contacts, people, lists, photos and unrelated events remain private.
The old single-family preview lacks these endpoints and safely hides
sharing features.

### Personal mobile accounts and a separate household hub account

The central login now distinguishes `accountKind = person` from
`accountKind = hub`. Each family member can use an independent
username/password and remembered session on their personal phone; the
household tablet/hub has its **own** username/password and remembered
session but is granted membership in the **same** family calendar.
Device sessions remain individually revocable. The existing central
`family_users` table is migrated in place with a default `person`
role for older users; no existing account or session is deleted simply
because this field was added. Adding a household member or hub account
is a trusted offline provisioning step for now; **self-service member
invites/account registration and owner-controlled provisioning are not
implemented yet**.

New event creation through the private authenticated gateway records
a separate authoritative `event_creator_audit` entry in the central
identity database. The actor is taken exclusively from the verified
login/session and selected authorized family, NOT from any client
`createdBy` field, calendar person tag, guessed ID, or device label.
The household-only `GET /api/event-creators` returns its own
existing-event authorship labels and distinguishes member-created from
hub-created events. The calendar displays the verified "Created by"
information in Event Details and shows the current account before
creating events; mobile also offers a profile shortcut to switch accounts
by signing out and signing in under another username. Existing events
created outside the authenticated gateway remain **unattributed**;
they are not guessed or retroactively assigned to someone.

This audit is a **test-gateway first slice**, not a production-ready
immutable event provenance system. In addition to normal PUT/DELETE,
other event creation paths (including AI commands and direct DB writes)
must be fully covered or disabled before relying on authorship across
every creation path. Central and household DB commits are not atomic
together and require durable replay/reconciliation; source event UUIDs
are also needed to guard numeric ID reuse across out-of-band restores.
Member-person assignment in the People Manager is a separate concept
from the creator's account and should require explicit linking before
auto-assigning a person to an event. The hub should not be assumed
to be an individual calendar person.

Source-event share synchronization still needs durable reconciliation
and additional mutation coverage. This must remain a private draft
until isolation, restore and authentication security review is complete.

## Private two-family hands-on browser rehearsal (DISPOSABLE)

`scripts/run-household-browser-demo.mjs` now starts an entirely separate
**loopback-only** test fixture from a built PR #46 checkout. It creates a
unique operating-system temporary folder **outside all Git checkouts**,
provisions blank Family A and Family B SQLite databases/uploads, builds
a fresh central identity database, creates two *random*, independent
test-only username/password accounts, allows sharing invitations in both
directions, and starts two real `Server/index.mjs` backend processes and
the central authenticated gateway on random, nonproduction 127.0.0.1 ports.

The test calendars are seeded with fake events, including Family A's
explicitly shareable BBQ and separate private events in A and B. **No
invitations are pre-sent.** Both families must deliberately send and
accept individual-event invitations using the new calendar UI.

The runner prints the demo-only credentials **in the local terminal**
rather than storing them in files, and stays open until Ctrl+C.
Clean shutdown stops only its own child processes, closes its central
DB and deletes only the unique OS temp folder it created. Abnormal
termination may leave temporary demo data, but never touches the live,
test or existing preview SQLite files.

A separate `scripts/test-household-browser-demo.mjs` integration test
starts the whole fixture, verifies that the normal frontend is served
behind a secure-login gateway, logs into both temporary accounts, checks
distinct private calendars, explicitly sends/accepts only one event,
checks the recipient overlay, and shuts down the test fixture. It runs
in the Deployment safety workflow and never changes Tailscale settings.

### Manual browser access — separate HTTPS port, never Funnel

The gateway listens only on localhost, but secure browser login requires
HTTPS for its `__Host-fc_session` cookie. After a successful local
demo start and inspecting `tailscale serve status`, the user may choose
to launch a **foreground** Tailscale **Serve** endpoint on a separate
HTTPS port, e.g. port 8443, aimed at the printed loopback gateway port.
This endpoint is available only to authorized devices in the tailnet,
not the public internet. Do **not** use Funnel, Tailscale Serve reset, or
change the existing port 443 Serve mapping; if 8443 is already in use,
STOP rather than overwriting a configured service.

Use a **fresh Chrome Incognito window** for this rehearsal: cookies are
scoped by hostname and not by port, so signing into the temporary demo
on `:8443` from the normal Chrome profile would overwrite the
existing trusted-device login cookie for the same `.ts.net` hostname
on port 443. Incognito keeps the real account's remembered login intact.

A second terminal runs foreground Serve while the first terminal runs
the gateway demo. Press Ctrl+C in the Serve terminal to remove that
foreground mapping, and Ctrl+C in the demo terminal to delete its
test-only servers/data. The preview URL on port 13002 and production
port 3001 are never repointed or stopped. This is a test-only harness,
not a multi-household production deployment.

## Later hosting considerations

For a handful of friends/families, several small Node processes and individual
SQLite files on the existing laptop may be sufficient for basic calendar
workloads. This has NOT been benchmarked. Local Arney inference is shared
hardware and requires fair queueing and independent per-family budgets.

The chosen storage separation reduces the size of the existing giant backend
refactor, but **process isolation and a secure gateway are prerequisites** for
multi-family use. It does not by itself guarantee tenant confidentiality.
