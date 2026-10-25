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
