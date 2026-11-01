# Windows supervisor — real child lifecycle rehearsal (disposable only)

**No deployment. This is not a scheduled task, a service, a real calendar gateway, or production SQLite writer control.**

The laptop inspection on October 30, 2026 showed the existing application launcher chains:

- LIVE: Task Scheduler shared service host → PowerShell → Node, loopback port 3001
- TEST: Task Scheduler shared service host → PowerShell → Node, Tailscale-only 13002
- Ollama: Task Scheduler shared service host → CMD → Ollama, loopback 11434
- Tailscale owns HTTPS 443/8443; Windows portproxy maps 127.0.0.1:13003 to the TEST Tailscale address
- Existing "Family Calendar Secure TEST Auto Deploy" is enabled (15-minute trigger); Watchdog has 5-minute cadence
- Three startup tasks use MultipleInstances=IgnoreNew, RestartCount=3, StartWhenAvailable=true, WakeToRun=false

These are **observed metadata, not proof of automatic child restart, port routing isolation, recovery correctness, OS-wide writer fencing, or backup integrity**. The currently enabled TEST Auto Deploy must not be changed or used for multi-family work without separate approval.

## Development in this PR

Two modules run a fully separate synthetic fixture:

- A fixed, hardcoded worker entrypoint that starts an actual Node HTTP listener on ephemeral **127.0.0.1** only and responds to an authenticated /health probe. It does not load or open the calendar API, SQLite, Tailscale, uploads, or any household user data.
- A disposable supervisor runner that calls the existing reviewed supervisor owner-lock primitive, captures the real OS ChildProcess handles before health confirmation, and checks exact approved household identity and an authenticated loopback health response before marking all workers healthy.
- The parent requests graceful shutdown of all its captured workers and only then releases its own owner lock. A death/IPC failure puts the reviewed supervisor into a durable hold, so the next startup is refused and no unattended lock recovery occurs.
- Fixture and state directories must be physical, nested beneath the operating system temporary directory. It cannot run pointed at the installed calendar.
- Synthetic fixture tests validate normal primary and invited household startups, live second-owner refusal, actual child crashes and durable holds, forged plan rejection, preexisting hold, non-temporary directory refusal, and duplicate shutdown refusal.

Run only in an isolated development checkout:

    node --test scripts/test-private-disposable-reviewed-windows-supervisor-runtime.mjs

The GitHub Actions Windows build runs this automatically. Its synthetic worker uses dynamic unprivileged loopback ports; **it never binds 3001, 13002, 13003, 443, 8443 or Ollama's 11434**.

## Remaining requirements before real Windows deployment

1. Approve an isolated Windows **TEST-only** host adapter design using a pinned source version, verified process execution identity and safe accounts—not this synthetic worker.
2. Ensure TEST Auto Deploy / Watchdog cannot race with a new supervisor and establish that live TEST remains unchanged until a separate cutover approval.
3. Reconcile trusted central identity and every household SQLite, uploads and active sessions; establish OS-wide writer fencing and WAL-safe backup/recovery.
4. Rehearse startup, crash holds, unattended reboot, network interruption, explicit task ownership and rollback against disposable hosts.
5. Separately approve and test a TEST-only HTTPS cutover. Main and LIVE need separate approvals.

A passing rehearsal proves only that the existing reviewed owner-lock state machine integrates with real disposable Node workers and HTTP health verification. It **does not** claim readiness for TEST or LIVE.
