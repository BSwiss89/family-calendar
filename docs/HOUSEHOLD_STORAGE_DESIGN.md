# Phase 2 foundation: isolated storage per household

Status: **draft / private test-only**. The regular Family Calendar server
continues to use its original SQLite database. The storage resolver is wired
into the backend only behind an explicit test flag with a loopback-only
listener on a nonproduction port. No households are created at startup.
This PR does NOT expose another calendar to outside devices and does NOT
change existing preview or live data.

Tracking: issue #45. Depends on draft auth PR #44 and Arney PR #43.

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
Before production sharing, immutable source-event identity must protect
against reuse of numeric SQLite IDs after deletion, and readers must
reconcile missing/out-of-date shares before showing them.

**Remaining incomplete:** This is test-only HTTP routing. There is no
recipient-facing invitation UI or calendar overlay yet. Cancellation
notices, durable retries and reconciliation, restoration, safe recurring
sharing, attachment permissions, friend invitation onboarding and the
production security review are pending. The existing preview and live
calendar are not migrated or opened publicly.

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
this is code and automated tests only. Accept/decline/share controls
and invitations in the calendar UI are separate future work.
Source-event sync still needs durable reconciliation and additional
mutation coverage. Do not publish or merge based solely on this view.

## Later hosting considerations

For a handful of friends/families, several small Node processes and individual
SQLite files on the existing laptop may be sufficient for basic calendar
workloads. This has NOT been benchmarked. Local Arney inference is shared
hardware and requires fair queueing and independent per-family budgets.

The chosen storage separation reduces the size of the existing giant backend
refactor, but **process isolation and a secure gateway are prerequisites** for
multi-family use. It does not by itself guarantee tenant confidentiality.
