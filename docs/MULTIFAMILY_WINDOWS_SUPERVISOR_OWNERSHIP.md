# Windows multi-household supervisor ownership — development only

This is not a Windows service, Task Scheduler installation, process launcher, HTTPS gateway, or production release.

## Implemented in this PR

The new Server/private-reviewed-windows-supervisor-ownership.mjs module accepts a trusted, frozen primary-plus-approved-friends plan from PR #100. It creates an exclusive, fsynced supervisor instance lock before any child can be attached. Its owner nonce is anonymous; credentials or backend tokens are not written.

Only real Node ChildProcess handles with connected IPC are accepted, one per approved household. On unexpected child exit, disconnect or error, a durable operator-review crash hold is written. Stale instance locks, even if the stored PID no longer exists, must never be automatically deleted.

A graceful shutdown must be explicitly begun, all captured child process exits must be observed, and the original instance lock must match byte-for-byte before the owner may release it. The module never kills a process, clears a crash hold, or automatically restarts. Its healthy transition only verifies child handles and IPC; HTTP health and gateway binding remain external checks.

Eight synthetic regression tests spawn actual Node children inside OS temporary directories on Windows CI. They check legitimate shutdown, two household isolation, unexpected exit, IPC loss, stale/foreign locks, duplicate/missing children, malformed plans and invalid state directories.

## Remaining manual gates before TEST

1. Implement the separately reviewed, pinned Windows runtime launcher and gateway integration. Verify executable identity, OS writer ownership, loopback-only sockets and actual HTTP health before routing.
2. Quiesce all SQLite writers; acquire and attest a coordinated backup of central identity, each household DB and uploads. Prove isolated restore.
3. Validate migration, browser session continuity, People/event assignments, Lists, invitations, shares, crash handling and unattended connectivity.
4. Review the existing test-release auto-deploy controller, Task Scheduler conflicts and current TEST HTTPS mapping before any change.
5. Receive a separate TEST-only authorization. The private preview release denylist is deliberately unchanged. LIVE and main require their own subsequent approval.

No production backup, deployment, task installation, startup or network routing occurs from this module or test suite.
