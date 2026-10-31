# Independent-family Windows startup — next TEST readiness gate

**Status: draft development, NOT installed and NOT deployable.**
All examples refer to disposable, loopback-only private fixtures. PR #70 does
not have approval to modify main, LIVE, TEST, Task Scheduler, Tailscale Serve,
the existing calendar's SQLite, or any running Windows service.

## What the new crash hold proves

The private supervisor has a separate review-hold file from the backend/gateway
writer locks. After a reviewed process restart, the disposable gateway's parent
tracks each **captured** private Node backend `ChildProcess` handle. An unexpected
child exit, Node error, or loss of the IPC control channel causes an exclusive,
flushed **REQUIRES-REVIEW** marker. The marker records only a generated
household ID, a non-secret reason, and a timestamp. It never includes a
capability token, password, PID, account or SQLite path.

A normal, explicitly initiated shutdown marks child exits as expected.
If the parent starts again and finds any existing review marker, even corrupt
or truncated, it refuses to start. The module has **no unlock, reset,
force-restart, kill-unknown-process or task installer command**. A previous
writer lock still independently blocks startup. Its read-only inspection API
always reports `automaticRestartAllowed: false`.

The real three-family disposable process-restart integration test now observes
the new child handles after restarting, and CI additionally spawns actual Node
children to prove unexpected exit/disconnect quarantines startup across a
fresh parent invocation. The parent holds only a synthetic temporary state
directory. The test cleans up its own captured temporary processes.

These are deliberately **necessary but not sufficient** controls. They are
neither a production Windows service nor an OS-wide writer fence. A machine
power loss can occur before a hold record reaches disk; existing suspicious
writer locks must still block restart. A privileged or unrelated process could
write to tenant SQLite without cooperating in these locks.

## Windows boot and recovery requirements before enabling a real task

1. Capture the current Windows task inventory and release configuration.
   Identify existing LIVE and TEST auto-deploy tasks **read-only**, preserve
   their names, accounts, start policies, working directories, and settings.
   Do not register, enable, disable, replace or run any task from draft code.
2. Select a separate private supervisor identity and **reviewed** startup
   checkout, state, and tenant storage root (all distinct from current LIVE
   and TEST paths); verify access permissions, backup boundaries, no symlink
   escape and loopback listener exclusivity. Never run as SYSTEM by default.
3. Build a dedicated approved Windows startup command that validates its
   pinned release version, central registry/owner approvals, lock markers,
   and complete restore/backups **before opening any writer SQLite**.
   Current synthetic two-family defaults must be removed/reconciled for the
   real household import before this can serve TEST.
4. The startup task must use exactly one instance and explicit operator
   authorization. On unexpected crash, outage or disconnected supervision,
   **hold**, do not retry a crashed backend or clear writer locks by PID/age.
   Task Scheduler's restart-on-failure and startup catch-up behavior require
   a separately audited no-auto-retry policy.
5. Prove coordinated shutdown of gateway and each captured child; verify
   listeners are closed, locks released by their original owners, current
   backup and restore attestation, and independent calendars, Lists and event
   sharing. A failed or incomplete proof holds the deployment.
6. Stage a TEST-only candidate with reversible migrations, a restore
   rehearsal and independent account/session continuity verification.
   Explicitly review the existing draft-preview deployment denylist instead
   of bypassing it. Update the current HTTPS TEST origin **only after
   separate approval**. Keep LIVE and main untouched.

## Unresolved release blockers

- No installed Windows task/service or trusted boot entrypoint for the private
  multi-family gateway. This PR does **not** install one.
- No production-grade gateway process/port ownership attestation or automatic
  orphaned-lock recovery. Under uncertain conditions, require manual review.
- No completed real TEST data migration/restore cutover or account-cookie
  compatibility sign-off. Passing GitHub synthetic CI is not deployment
  approval.
- Existing Windows sleep, lid-close, hotspot connectivity and task ownership
  must be checked on the actual laptop before remote friends depend on it.
- Multi-family remains draft-only behind the release-denylist; no access
  through the two existing HTTPS sites has been enabled.
