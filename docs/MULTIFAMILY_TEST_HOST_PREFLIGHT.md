# Multi-family TEST deployment — host-readiness checkpoint (read-only)

**Development only.** This checkpoint does not install a Windows service, run
Task Scheduler tasks, update the existing HTTPS TEST endpoint, alter main or
LIVE, or open production household databases. Even a passing host inventory
is **not** authorization to deploy.

## Why this comes before a Windows startup task

The private supervisor in PRs #94–#97 has demonstrated safe invited-household
activation, approved restarts and crash holds with disposable localhost
fixtures. It is **not yet a production Windows service**. Installing a task
before checking the laptop's existing LIVE/TEST task configuration risks
duplicate writers, lost data or unintended site changes.

A first read-only inventory can be run locally by an operator from a
separately reviewed source checkout:

```powershell
pwsh -NoProfile -File .\scripts\inspect-private-test-host.ps1
```

The command reads the expected LIVE and TEST checkout locations beneath the
current Windows user's Projects folder and enumerates tasks whose names
contain `Family Calendar` or `FamilyCalendar`. It queries only local Git
revision and cleanliness, symlink status and safe scheduler metadata.
It does **not** fetch or reset Git branches, access SQLite, read task action
arguments or credentials, query or modify Tailscale Serve, install or run
tasks, stop processes, or write output files. Its output omits usernames,
full paths, tokens and task commands.

The script feeds a sanitized inventory to
`scripts/assess-private-test-host-readiness.mjs`. You can separately obtain
the sanitized JSON inventory using `-SnapshotOnly`. Neither mode changes
a running site. Scheduler enumeration denied or unavailable must be reported
as **unknown / blocked**, not a successful verification.

### Required outcomes

1. Confirm the LIVE and TEST checkout folders are distinct, contain
   recognizable Git checkouts, and do not have unexpected modifications.
   This is **not** proof that their SQLite files, sessions or URLs are
   independent. Any dirty checkout requires review instead of cleanup.
2. Record existing Family Calendar task names, enabled state and restart
   settings **without showing task commands or stored passwords**. If a
   private supervisor task already exists, refuse duplicate installation.
   A supervisor with unattended restart-on-failure needs manual review.
3. Compare the read-only result with the actual laptop's sleep, lid-close,
   power, FirstNet connectivity and task-run account behavior. The host audit
   cannot make these assertions automatically.
4. With separate authorization, implement and review a dedicated startup
   service/Task Scheduler definition with a fixed, reviewed program version,
   exclusive process ownership and no unsafe automatic orphan-lock recovery.
5. Stage coordinated backups and demonstrate a restore in isolated staging,
   rehearse legacy account/person migration and session continuity, and
   exercise independent owner and member login, events, Lists and shares.
6. Only after a separate explicit **TEST-only** authorization: review the
   existing draft-only release guard, update only the TEST site while retaining
   its HTTPS URL and preserved data. Confirm rollback behavior and all family
   boundaries. LIVE and `main` require another separate approval.

### What passing the audit does NOT prove

- OS-wide process identity or exclusive SQLite writer fencing.
- Approved migrated data, backup consistency, or account-cookie continuity.
- Safe HTTPS reverse-proxy/Tailscale routing.
- Installed or healthy Windows multi-family supervisor.
- Successful phone/wall-display operation or hotspot uptime.
- Operator authorization to change `main`, LIVE or TEST.

The evaluator hardcodes `authorizedToDeployTest: false`,
`authorizedToDeployLive: false` and `authorizedToMergeMain: false`
regardless of host results. New audit scripts remain behind the private
preview release denylist. CI uses **synthetic** inventories and a PowerShell
parser only, never the real laptop task inventory.

## Next action after approval of this development-only PR

Run the **read-only** inventory on the laptop, review the sanitized result
and current task conflicts, then prepare a separate reviewed Task Scheduler
startup/service candidate. Do not deploy or install from this document.
