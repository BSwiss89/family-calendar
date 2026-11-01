# Development-only legacy data preservation gate

This audit is an **offline verification step**, not a backup creator or deployer. It compares all pre-existing SQLite tables/columns/row values in a separately staged legacy backup against a **previously provisioned, isolated** household database and compares every upload file by relative name and SHA-256. Adding new tables/columns is allowed. Editing/removing original fields, records, or upload bytes is not.

## Required manual prerequisites

- Use a trusted, independently captured SQLite backup from an **offline, checkpointed** source, never from a running SQLite writer. Protect the original and record its hash externally.
- Stage the backup under a unique folder **outside** both application checkouts, containing exactly `data/calendar.db`, `uploads/`, and `.family-calendar-legacy-offline-review.json`. The marker must be `{"kind":"legacy-calendar-offline-review","version":1}`. The marker declares the operator's intended offline review; it is **not proof** of writer quiescence or source authenticity.
- Provision an **independent** household storage root using the existing `provisionEmptyHousehold` API. Perform the separately reviewed offline migration on that household's **disposable** `data/calendar.db`, with all writers stopped. Keep its household metadata marker and uploads directory.
- Ensure there are no SQLite WAL/SHM/journal sidecars in either staged database directory. Unknown files are refused. Only read-only SQLite handles are opened by the audit.

## API

```js
import { reconcileOfflineLegacyHousehold } from './Server/private-legacy-household-reconciliation.mjs'

const report = reconcileOfflineLegacyHousehold({
  serverDirectory: 'ABSOLUTE_PATH_TO_ISOLATED_CHECKOUT/Server',
  legacyRoot: 'ABSOLUTE_PATH_TO_TRUSTED_OFFLINE_LEGACY_STAGE',
  householdStorageRoot: 'ABSOLUTE_PATH_TO_ISOLATED_HOUSEHOLD_STORAGE_ROOT',
  householdId: 'offline-family',
})
// { ok:true, originalTablesChecked, originalRecordsPreserved,
//   uploadFilesPreserved, productionDeploymentAuthorized:false }
```

Run the synthetic regression tests with `node --test scripts/test-private-legacy-household-reconciliation.mjs`. GitHub CI runs them for the feature PR automatically.

## Not proven by this gate

- Whether the original backup was captured while SQLite writers were fenced.
- Full consistency among central identity, independent households, event sharing, or source outboxes.
- Whether imported credentials, browser session cookies, or People-account associations work in a browser.
- Whether the Windows supervisor, HTTPS routing, backups, scheduled auto-deploy and rollback can safely operate on the new multi-family runtime.
- Permission to merge `main`, deploy TEST/LIVE, change `test-release`, or bypass the private preview release denylist.

Use the existing private multi-household restore-preflight and approved startup tests separately. A human must review the combined evidence and explicitly approve any actual TEST cutover.
