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

## Important: not yet multi-family login

PR #44's accounts are currently associated with ONE SQLite database, and all
signed-in users still see that database. This library does not change that.
**Do not create friend accounts in the existing calendar. Do not enable a public
Funnel for other families on the basis of this PR.**

The production migration needs a separate review and verified restore test:
the existing live database stays intact until the owner's household has
been migrated and tested with the new storage layout. Back up accounts,
calendar data and image uploads before any such move.

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

## Later hosting considerations

For a handful of friends/families, several small Node processes and individual
SQLite files on the existing laptop may be sufficient for basic calendar
workloads. This has NOT been benchmarked. Local Arney inference is shared
hardware and requires fair queueing and independent per-family budgets.

The chosen storage separation reduces the size of the existing giant backend
refactor, but **process isolation and a secure gateway are prerequisites** for
multi-family use. It does not by itself guarantee tenant confidentiality.
