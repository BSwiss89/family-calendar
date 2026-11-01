# Windows pinned scheduler handoff — disposable development rehearsal

**No Windows tasks are installed, stopped, disabled, replaced or modified. No LIVE, TEST, main, SQLite, Tailscale or network routing changes.**

This feature advances beyond the real synthetic Node process test in PR #105 by running it through a disposable pinned-candidate **scheduler coexistence handoff**. The adapter is not a working production Windows service or an installation plan.

## Existing laptop behavior preserved

The October 30 audit identified these enabled tasks:

- `Family Calendar Server`, `Family Calendar Secure TEST`, `Family Calendar Ollama Server`: `RestartCount=3`, `MultipleInstances=IgnoreNew`.
- `Family Calendar Watchdog`: enabled; roughly five-minute cadence.
- `Family Calendar Secure TEST Auto Deploy`: enabled; roughly fifteen-minute cadence.
- `Family Calendar Auto Deploy`: disabled.

The new adapter refuses a synthetic launch when any required task disappears or diverges from this reviewed baseline, an existing supervisor task is present, or the LIVE auto-deployer unexpectedly becomes enabled. It compares sanitized metadata both before and after startup and before shutdown. **The existing enabled TEST Auto Deploy is not disabled; it remains an unresolved production cutover conflict.**

## What is actually exercised

1. Initialize a **new throwaway Git repository** inside the OS temp directory, commit a known fixture, and verify its complete SHA and clean working tree with the real Git executable. The candidate checkout, separate synthetic worker directory and supervisor state must be physical OS-temp directories; installed calendars are rejected.
2. Consume a **supplied synthetic task inventory**. The adapter never executes `Get-ScheduledTask`, task actions or credentials; this is not an authoritative scheduler attestation.
3. Launch the previously reviewed real Node child processes, authenticate their ephemeral loopback health responses and capture their OS child handles.
4. Compare the protected task snapshot again, then either approve a synthetic healthy state or deliberately put the disposable supervisor in an operator-review hold if task metadata drifted while children started.
5. Recheck the synthetic task metadata before graceful shutdown. Drift causes a fixture-only crash hold, not automatic deletion of owner locks or an unattended restart.

Tests cover a normal two-household lifecycle with the existing TEST auto-deployer marked enabled, mismatched or dirty commit, missing scheduler observation, duplicate or competing task, enabled LIVE auto-deployer, unexpected restart settings, and task drift during both startup and shutdown.

Run in an isolated development checkout:

```powershell
node --test scripts/test-private-disposable-pinned-windows-host-handoff.mjs
```

## Deployment blockers still open

- This verifies a **synthetic Git checkout**, not that the executable running on the actual laptop has a verified, pinned identity or correct parent process tree.
- The task snapshot is provided by a test fixture. No actual scheduler race prevention or TEST Auto Deploy/Watchdog handoff has been implemented.
- Existing Windows tasks may own active SQLite writers. An exclusive supervisor lock only fences cooperating children, not every other OS process.
- No coordinated real SQLite WAL-safe backup, full OS writer-handle audit, restoration proof or migration has occurred here.
- No future TEST pilot may be deployed until existing TEST Auto Deploy and Watchdog task conflicts are resolved through separate, explicit operator authorization and a verified rollback procedure.
- PR #70 must remain draft; merging this separate feature PR into PR #70 requires its own approval. Main, LIVE and TEST require distinct approvals later.

**Every adapter snapshot retains `authorizedToDeployTest:false`, `authorizedToDeployLive:false`, and `realHostTaskOwnershipProven:false`.**
