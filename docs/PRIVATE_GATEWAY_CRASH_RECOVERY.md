# Private household gateway: crash-recovery review (test-only)

This runbook is for disposable, separately provisioned two-family fixtures.
The private gateway and this document **do not authorize use with LIVE or TEST**.

## What is already enforced

- A private gateway reserves an exclusive directory within its private fixture storage root.
- A second gateway against the same root refuses startup.
- Clean shutdown releases only the original ownership token.
- An abrupt termination leaves the lock quarantined. No PID-based timeout or
  automatic unlock is implemented.
- The read-only audit examines the owner marker, central/household SQLite
  integrity, central pending share sync, and basic storage boundaries.
- Passing an audit **is not proof** that every child backend or SQLite writer
  has stopped. The audit always reports `canAutomaticallyReclaim: false`.

## Operator recovery sequence (not implemented as an automatic action)

1. Keep the private gateway offline and **do not retry startup in a loop**.
2. Identify and stop the known gateway and both household backend process
   instances through the supervised launcher; inspect descendant processes,
   Windows scheduled tasks, and any other writer using the same SQLite files.
   Process name or an absent PID alone does not prove exclusive ownership.
3. Verify no automatic task can relaunch those writers during inspection.
   If the service cannot be fenced reliably, keep the abandoned lock intact.
4. Capture a coordinated, quiescent backup of the central identity database,
   both household databases, uploads, and relevant sharing journals using an
   approved procedure. Do not copy active WAL-mode files piecemeal.
5. Run the existing nonmutating offline integrity and restore-attestation
   checks against **copies in isolated staging**, not the running calendar.
6. Review pending share/outbox intentions, disabled/revoked sessions, mismatched
   household markers, and any SQLite sidecars before considering recovery.
7. An operator must approve a separately reviewed, OS-fenced recovery procedure.
   **This project intentionally provides no lock-deletion command** and never
   silently resumes a suspected live or uncheckpointed writer.
8. Only after a separately approved recovery implementation has been tested
   should a fresh gateway start and undergo synthetic two-household access tests.

## Synthetic CI proof

`node --test scripts/test-private-gateway-process-crash.mjs` spawns a separate
Node process against a freshly created temporary storage root, force-kills it,
confirms the lock persists, rejects another process, and verifies the audit does
not mutate or auto-reclaim the lock.

All OS process termination is limited to processes spawned by this test.
Temporary test files are deleted only after spawned processes exit. No
production service, site, task, or database is targeted.

## Supervised disposable shutdown check (test-only)

The existing two-family demo launcher now confirms that its **captured**
`family-a` and `family-b` Node child process handles have exited, that the
private gateway listener has been closed, and that all three specific loopback
ports refuse new TCP connections. An unexpectedly occupied port prevents it
from erasing the disposable fixture. The helper never kills processes,
removes writer locks or inspects real calendar services.

This is stronger than checking PID absence alone, but it **cannot** prove
unrelated writers, Windows scheduled-task restarts, descendants of a child,
SQLite WAL consistency, or the correctness of any production gateway process.
It returns `allSystemWritersFenced: false` and `recoveryApproved: false`
even when the supervised disposable processes are quiet. A separate reviewed
OS-level isolation and operator cutover mechanism is still required.

## Per-household private backend writer locks

Each explicitly test-only backend now acquires a second, **separate**
exclusive writer-lock directory in its own pre-provisioned household storage
home before any SQLite connection is opened. This prevents two ordinary
cooperative backend processes from serving the same Family A SQLite at once
while allowing Family B to run independently. There is no route or API
for clearing a backend lock automatically.

For a supervised clean shutdown, the demo/test launcher uses a **private
parent-child Node IPC shutdown command**. This is required on Windows where
`child.kill('SIGTERM')` may terminate a process without running a signal
handler. The backend first closes its HTTP listener, then its SQLite handle,
then releases only its own token-matched lock. If it crashes or is forcibly
terminated, the lock stays quarantined.

This protection is **not** an OS lock, host-wide process fence or protection
against a privileged process deleting lock files. A gateway or backend that
fails while writing must still undergo approved operator fencing and
coordinated offline backup/recovery before any abandoned marker is cleared.
