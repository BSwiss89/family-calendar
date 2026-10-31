# Fast-track: first family group on existing HTTPS TEST only

**Approved scope:** Prepare and, *only after real host gates pass*, cut over the EXISTING TEST website for **one family**. No change to main, LIVE, its DB, services, backups or HTTPS route. This document is a runbook, NOT a deployer.

## Architectural decision to get the first family online faster

Use the current TEST site's **single-family legacy calendar backend**, existing data, current HTTPS address and `FAMILY_CALENDAR_AUTH_MODE=required` with a pre-created owner account. Keep household-splitting, independent friend tenants, central identity migration, event sharing between homes and the draft private gateway OFF this pilot. A passing one-family pilot is NOT proof of isolation for additional families.

The current private gateway remains an ephemeral loopback-only test harness. **Do not connect the external TEST HTTPS route to it.** This reduces the initial work to one existing backend and one account boundary, with the current LIVE site preserved.

## One command to collect the missing actual Windows evidence

Use PowerShell on the calendar laptop, in a **new, isolated checkout** of the candidate branch. Never run these scripts from the installed `family-calendar` or `family-calendar-test` checkout.

```powershell
$stage = Join-Path $env:USERPROFILE 'Projects\family-calendar-pilot-review'
if (Test-Path -LiteralPath $stage) { throw 'Review checkout already exists; inspect rather than overwrite it.' }
git clone --single-branch --branch feature/one-family-test-pilot-readiness-gates 'https://github.com/BSwiss89/family-calendar.git' $stage
if ($LASTEXITCODE -ne 0) { throw 'Isolated clone failed.' }
$sha = (& git -C $stage rev-parse HEAD).Trim()
pwsh -NoProfile -File (Join-Path $stage 'scripts\inspect-private-one-family-test-pilot.ps1') -ExpectedCommitSha $sha
```

This clones into a NEW folder and then runs only read-only checks. The evaluator compares two existing, sanitized host/task and port-owner inspections and notes missing owner/password, backups, route and rollback proof. It DOES NOT read the running SQLite DB, open private task action command lines, change tasks, stop Node, or write to TEST. Share the JSON summary (no passwords, tokens or private paths).

Even if `hostInventoryPassed:true`, `allowedToChangeTest:false` is intentional. Snapshot metadata alone does not prove backup integrity, process ownership or deployment approval.

## Actual cutover gates — sequential, operator-reviewed

1. **Freeze candidate.** Review the exact PR #70 candidate commit; require passing Windows CI and preservation of existing LIVE features. No `main` merge. Verify TEST checkout and separate HTTPS route, current Task Scheduler accounts and launcher actions, active Node PID/process tree, and TEST automatic deployer/watchdog ownership. A **real** coordinator must ensure these cannot revive conflicting TEST writers during the handoff. No unreviewed scheduled task changes.
2. **Coherent source backup.** Identify the exact TEST SQLite and upload directories, all attachments, recipe images, device sessions and any journal/WAL files. Stop or quiesce **all** TEST database writers with explicit confirmation, coordinate the enabled Secure TEST Auto Deploy and Watchdog, use a legitimate SQLite backup/checkpoint procedure and preserve a complete independently attested database + upload snapshot. **Never copy an active `calendar.db` alone** or delete WAL/SHM as cleanup. Also preserve exact TEST task/config and deployed code/manifest/Node dependencies for rollback. LIVE stays running.
3. **Restore to isolation.** Copy the protected snapshot into a NEW offline restore folder and verify all expected files, hashes, SQLite integrity and foreign keys; exercise login, People, events, Lists, meal plan and images against that isolated candidate. Preserve independent original backup; do not replace it during rehearsal.
4. **Owner account before required mode.** Confirm an active TEST account already exists or explicitly create one using the existing secure offline `scripts/manage-family-account.mjs` tool on the approved **stopped TEST copy**. The tool supports `family-calendar-test\Server\data\calendar.db`, reads the password on stdin and does not include it in command-line arguments. Do not run it against LIVE or a running writer. Password must be at least 14 characters. Confirm the owner can log in, and no legacy session/cookie from LIVE authenticates on TEST.
5. **Controlled TEST switch.** After the backup, restore and owner-account gates pass, use an explicitly pinned code and package candidate and set `FAMILY_CALENDAR_AUTH_MODE=required` for **TEST only**. Coordinate its existing task, deployer, watchdog and reverse-proxy/Tailscale HTTPS configuration. Confirm exactly one backend owns TEST's writer database; the private draft gateway is not activated. Do not turn on public Funnel.
6. **Acceptance, using the real TEST HTTPS origin.** Test anonymous API and image access deny/redirect, wrong-password throttling, successful login and session cookies, logout/device revocation, mobile Safari, wall display, events (including recurring), People assignments, shopping Lists, meals, photos, and restarting only TEST while keeping LIVE healthy. Verify an unprivileged user cannot reach an unauthenticated direct backend bypass.
7. **Rollback or sign-off.** If any gate fails, block the cutover or restore the exact preserved TEST code, process/config, DB, uploads and HTTPS route under confirmed writer quiescence. Verify data fingerprints and health after rollback. Record every pass/failure with precise Central time. Keep the backup until the first-family pilot has passed acceptance and an explicit retention decision is made.

## Evidence required before acting on the already-granted conditional TEST approval

- Actual read-only laptop diagnostic output (this PR).
- Reviewed TEST process identity, existing restart policy, auto-deploy/watchdog coordination and HTTPS route.
- Complete coherent TEST database+uploads backup and independent fingerprint/attestation.
- Successful isolated restore and rollback rehearsal **of the same candidate**.
- Owner login verified before enabling required authentication.
- Reviewed TEST-only configuration change and confirmed all acceptance checks; LIVE invariant throughout.

Only then can the previously approved TEST-only action be performed; **this PR does not perform it**. Any merge into PR #70 still requires explicit approval. Deployment to main or LIVE remains disallowed and is not implied by TEST approval.
