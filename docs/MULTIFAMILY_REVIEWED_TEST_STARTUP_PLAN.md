# Reviewed primary-household TEST startup plan — development only

## Why this step exists

The existing `private-approved-household-startup.mjs` is deliberately hard-coded to two **synthetic** test households (`family-a` and `family-b`). Those IDs must not become the real migrated family's identity or Windows service defaults.

`Server/private-reviewed-test-startup-plan.mjs` provides a separate **read-only** selection preflight for an operator-specified real primary family and previously approved invited households. It is not a Windows Task Scheduler task, installed supervisor, or gateway. Its result explicitly sets `deploymentAuthorized:false`.

## Required offline inputs

An operator must open a separately staged central identity SQLite database containing the household registry, active owner memberships, private activation records and redeemed invitations. The operator explicitly supplies the intended migrated first-family ID; it is never guessed from the filesystem or an incoming HTTP request. The household storage root must already be provisioned **outside** the application checkout, with a distinct existing supervisor state directory.

The planner refuses:

- Demo `family-a` / `family-b` or generated invited-household IDs as the primary; missing or disabled registry entries
- Any household missing a currently active owner, or any login belonging to multiple households
- Active additional households without the generated ID and valid trusted invitation/activation record; stale activations
- Missing or invalid storage, duplicate household SQLite files, invalid SQLite quick-check or foreign-key references
- Existing gateway/backend writer lock files or persistent supervisor crash-hold marker
- A supervisor state directory nested in household storage or application code

It does **not** create or alter SQLite, back up files, launch a Node process, register tasks, clear a lock, modify networking, or deploy code.

## Prototype API (offline reviewer only)

```js
import { DatabaseSync } from 'node:sqlite'
import { planReviewedPrivateTestStartup } from './Server/private-reviewed-test-startup-plan.mjs'

const db = new DatabaseSync('ABSOLUTE_OFFLINE_CENTRAL_IDENTITY_DB', { readOnly: true })
try {
  const plan = planReviewedPrivateTestStartup({
    identityDatabase: db,
    serverDirectory: 'ABSOLUTE_REVIEWED_CANDIDATE_CHECKOUT/Server',
    storageRoot: 'ABSOLUTE_OFFLINE_HOUSEHOLD_STORAGE',
    stateDirectory: 'ABSOLUTE_OFFLINE_SUPERVISOR_STATE',
    primaryHouseholdId: 'REVIEWED_NON_DEMO_PRIMARY_HOUSEHOLD_ID',
  })
  // planVerifiedReadOnly=true; deploymentAuthorized=false
} finally {
  db.close()
}
```

The current fixtures use the illustrative primary ID `home-family`; **that is not an instruction to rename or migrate the existing calendar.** A migration ID and any in-place changes require a separate reviewed operator plan.

Run `node --test scripts/test-private-reviewed-test-startup-plan.mjs` on synthetic test data. CI uses the same fixture tests on Windows.

## Still required before TEST cutover

1. Fully deployable Windows startup supervisor with fixed commit/code identity, verified OS process ownership, one writer per database, crash hold and fail-closed recovery. This planner must not be interpreted as that supervisor.
2. Quiesced, coherent acquisition of central + every household SQLite database and uploads, external backup-time attestation, isolated restore, and session-revocation policy.
3. Browser session continuity and People-account association after legacy migration, plus actual two-household login/Events/Lists/event-share acceptance.
4. Review current `test-release` auto-deployer, scheduled tasks and existing TEST 13003 → 13002 portproxy/HTTPS route. No new site and no route or service changes without explicit TEST authorization.
5. An independent operator approval to amend the private-preview release denylist and deploy to TEST; `main` and LIVE remain untouched.

Neither this PR nor a passing workflow authorizes deployment.
