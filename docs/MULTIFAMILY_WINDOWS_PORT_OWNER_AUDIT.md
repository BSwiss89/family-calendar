# Windows protected-port owner audit — read-only TEST readiness

**Development only. No installed server, task, checkout, HTTPS routing, Windows firewall, or database is changed.**

This audit supplements the existing scheduled-task and Git-checkout inventory in `scripts/inspect-private-test-host.ps1`. It covers network ownership metadata that previously had to be checked manually before attempting a Windows multi-household supervisor.

## What is inspected

The new `scripts/inspect-private-windows-port-owners.ps1` reads Windows TCP listening sockets for 443, 8443, 3001, 11434, 13001, 13002 and 13003, using `Get-NetTCPConnection -State Listen`. It looks up each reported owning process by PID using `Get-Process`, and emits only sanitized fields:

- local port (no IP addresses)
- bind class: loopback, wildcard, external, or unknown (no addresses)
- owning PID, simple process name, and whether the name could be read
- whether socket enumeration completed

It **never** collects executable paths, command lines, task actions, environment variables, Windows accounts, credentials, tokens, certificate keys, SQLite contents, or Tailscale configuration. It does not attempt to close sockets, kill tasks, install services, change firewall settings, inspect TCP traffic or write files.

The separate Node evaluator `scripts/assess-private-windows-port-owners.mjs` validates this narrowly scoped inventory. It flags missing or unreliable ownership, private HTTP bound to wildcard/external interfaces, and different owners on one protected port. HTTPS listener visibility requires a separate TLS/routing review even when the port appears properly owned.

**A clean result is NOT authorization** to create a Task Scheduler definition, start the multi-family supervisor, remove locks, change TEST routing, merge to main or deploy LIVE.

## Future manual inspection (only after reviewing the branch)

From a **separate reviewed checkout**, on the actual laptop, an operator may run:

```powershell
pwsh -NoProfile -File .\scripts\inspect-private-windows-port-owners.ps1
```

For sanitized inventory JSON without the evaluator:

```powershell
pwsh -NoProfile -File .\scripts\inspect-private-windows-port-owners.ps1 -SnapshotOnly
```

No Windows service installation or credentials are required to inspect. If a process cannot be inspected, the audit reports it as unknown, not safe. Because this is a momentary snapshot, listener state can change immediately; it cannot establish exclusive SQLite writer ownership.

## CI coverage

```powershell
node --test scripts/test-private-windows-port-owners.mjs
```

The test suite uses only synthetic network inventories, not the GitHub runner's actual network connections. The existing build workflow also parses PowerShell scripts for syntax errors.

## Remaining host integration gates

1. Confirm real LIVE/TEST checkout and scheduler-task inventory from the existing **read-only** preflight.
2. Review this protected-port snapshot and correlate it manually with the known Windows task actions, pinned executables and HTTPS/Tailscale Serve routing.
3. Establish OS-wide, independent process and SQLite-writer fencing, with durable startup/crash holds, before declaring any quiescence.
4. Prove central-identity + household + uploads checkpointed backup and isolated restoration.
5. Test the actual Windows supervisor with independent household accounts, sessions, events, Lists, shares, rollback, power restoration and unattended connectivity.
6. Obtain **separate explicit approval** before any TEST-only cutover; LIVE and main remain separately gated.

No previously approved LIVE or TEST deployment is implied by this read-only development work.
