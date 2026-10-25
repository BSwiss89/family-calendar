# Household Integration vs. Working LIVE — Reconciliation Gate

This is a **read-only safety gate**, not a rollout plan or permission to merge the household branch into LIVE.

## Verified baselines

- Working LIVE release reported and visually confirmed: `742addbde25255ce3e79f1cce9fc9276c1efb567` on `feature/auth-current-calendar-two-sites`.
- Isolated two-household end-to-end tests: `a3c1d94fe5c58bf9b779961dd14a34ce5d1227d8` (PR #68).
- LIVE and TEST have different databases, and their two HTTPS endpoints must be retained.
- PRs #46 and #54–#68 are draft dependency branches. The full stack is **not** approved for release.

## Why the household build cannot replace TEST or LIVE yet

The original household dependency branches were developed apart from the working LIVE Lists and authentication release. The isolated PR #70 integration candidate has now restored the named LIVE Lists/icons, store-preference, and duplicate-event files, and the CI presence gate protects them from being dropped accidentally. High-risk integrated files including `src/App.tsx`, `src/App.css`, `Server/index.mjs`, authentication, tests, and workflow/deployment safety still require separate behavior and deployment review.

A successful synthetic two-household test verifies isolation and basic invitation flow **on that branch**. It does not prove retention of the later LIVE Lists UI, account/session continuity, PWA, assets or production startup after reconciling the two branches.

## Safe reconciliation order

1. Run the read-only CI auditor against the pinned LIVE checkout. The PR #70 and descendant CI gate uses `--require-preserved-features` and **fails** if named LIVE-only feature files or household foundation files disappear. The `--audit` reporting mode remains advisory, and modified overlapping files still require review.
2. Build a **new isolated integration candidate** based on the approved LIVE snapshot, retain the already-deployed Lists and authentication implementation, and add the draft household functionality using reviewed diffs. Do **not** replace entire overlapping files wholesale.
3. Apply preserved LIVE functionality regression tests to the candidate (lists, icons, duplicate event, store preferences), as well as the full two-household integration tests and existing security/deployment checks. Fix conflicts in the isolated candidate only.
4. Confirm the current account-migration rehearsal against a **disposable backup** and make an explicit cookie/session continuity plan before any real identity cutover.
5. Test locally without Tailscale Serve modification. Only after a new audited candidate is ready should an operator plan to update the existing TEST site while preserving its database and HTTPS URL.
6. Reverify on phone, back up the actual TEST database, and decide about LIVE separately. Never assume a green GitHub build means deployment safety.

## Audit controls

- Source: `scripts/audit-household-live-parity.mjs`.
- The auditor reads Git objects only, never modifies Git refs, filesystem application data, SQLite, Tailscale Serve or scheduled tasks.
- CI fetches the named LIVE branch into `FETCH_HEAD`, which must exactly match the pinned hash, before inspection.
- `--audit` reports all file differences without returning failure. `--require-preserved-features` is the CI gate: it rejects missing LIVE feature or household foundation files while still reporting modified overlapping files for manual review.
- `--require-reconciled-files` remains an opt-in exact-file-match check and is **not sufficient for production approval**, because legitimately integrated files differ, and a same-hash file can depend on other missing services.
- Pin updates require a separate review; silently changing the baseline is prohibited.

Never paste production password hashes, invitation tokens, database contents or secret authentication cookies into GitHub logs.
