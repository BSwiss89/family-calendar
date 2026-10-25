# Household Integration vs. Working LIVE — Reconciliation Gate

This is a **read-only safety gate**, not a rollout plan or permission to merge the household branch into LIVE.

## Verified baselines

- Working LIVE release reported and visually confirmed: `742addbde25255ce3e79f1cce9fc9276c1efb567` on `feature/auth-current-calendar-two-sites`.
- Isolated two-household end-to-end tests: `a3c1d94fe5c58bf9b779961dd14a34ce5d1227d8` (PR #68).
- LIVE and TEST have different databases, and their two HTTPS endpoints must be retained.
- PRs #46 and #54–#68 are draft dependency branches. The full stack is **not** approved for release.

## Why the household build cannot replace TEST or LIVE yet

The current household branch was developed apart from the working LIVE Lists and authentication releases. The pinned LIVE checkout contains modules for list features/icons, store preferences and duplicate events that do **not** exist in the household branch. There are also differences in shared high-risk files such as `src/App.tsx`, `src/App.css`, `Server/index.mjs`, authentication, tests, and workflow/deployment safety.

A successful synthetic two-household test verifies isolation and basic invitation flow **on that branch**. It does not prove retention of the later LIVE Lists UI, account/session continuity, PWA, assets or production startup after reconciling the two branches.

## Safe reconciliation order

1. Run the read-only CI auditor (`node scripts/audit-household-live-parity.mjs --audit`) against the pinned LIVE checkout. It reports missing LIVE functionality and overlapping files and **passes intentionally** while there is outstanding drift.
2. Build a **new isolated integration candidate** based on the approved LIVE snapshot, retain the already-deployed Lists and authentication implementation, and add the draft household functionality using reviewed diffs. Do **not** replace entire overlapping files wholesale.
3. Apply preserved LIVE functionality regression tests to the candidate (lists, icons, duplicate event, store preferences), as well as the full two-household integration tests and existing security/deployment checks. Fix conflicts in the isolated candidate only.
4. Confirm the current account-migration rehearsal against a **disposable backup** and make an explicit cookie/session continuity plan before any real identity cutover.
5. Test locally without Tailscale Serve modification. Only after a new audited candidate is ready should an operator plan to update the existing TEST site while preserving its database and HTTPS URL.
6. Reverify on phone, back up the actual TEST database, and decide about LIVE separately. Never assume a green GitHub build means deployment safety.

## Audit controls

- Source: `scripts/audit-household-live-parity.mjs`.
- The auditor reads Git objects only, never modifies Git refs, filesystem application data, SQLite, Tailscale Serve or scheduled tasks.
- CI fetches the named LIVE branch into `FETCH_HEAD`, which must exactly match the pinned hash, before inspection.
- `--audit` reports mismatch without returning failure; this allows the draft CI build to remain meaningful while reporting real gaps.
- `--require-reconciled-files` is an opt-in strict check and **not sufficient for production approval**, because two different files can be functionally compatible while a same-hash file can depend on other missing services.
- Pin updates require a separate review; silently changing the baseline is prohibited.

Never paste production password hashes, invitation tokens, database contents or secret authentication cookies into GitHub logs.
