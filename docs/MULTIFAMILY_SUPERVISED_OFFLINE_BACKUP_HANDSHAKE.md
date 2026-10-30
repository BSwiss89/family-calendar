# Supervised offline backup handshake — development only

This is an isolated test-fixture integration, not an installed Windows service or production backup job. It never starts production processes, touches existing LIVE/TEST databases, changes HTTPS routes, or modifies Task Scheduler.

## Gap addressed

PR #101 added real OS-child ownership and durable supervisor instance locks. PR #102 added complete snapshot capture from an already-offline source. Neither independently verified the captured child processes had exited while a snapshot was made. This PR joins those behaviors for disposable OS-temp fixtures.

The handshake requires an exact frozen reviewed primary-and-friends plan, an actual captured ChildProcess for each household, the gateway declared closed, and every nominated backend exited. It enters a protected supervisor capture window while the durable instance lock remains present, probes distinct loopback ports for listener closure, and checks the exact household IDs in the offline source before copying anything.

It then invokes the existing central+households+uploads snapshot and offline restore preflight, verifies that all captured households match the supervised list, and probes the ports a second time. Only successful capture ends the capture window. Failure leaves the instance locked and supervisor in a state requiring manual review.

## Synthetic regression coverage

Six synthetic tests start actual disposable Node child processes and bind real loopback listeners. They test successful two-family capture, a still-running writer, an unexpected listener, an uncheckpointed SQLite WAL sidecar, an invalid/mismatched household identity, duplicate ports and invalid gateway state.

## Limits and remaining tasks

This check covers captured child handles and nominated TCP ports only. It does NOT establish OS-wide writer fencing, absence of an untracked SQLite writer, independently evidenced gateway shutdown, SQLite checkpointing, off-device backup, protected external attestation, or unattended Windows recovery. The input and output of the underlying capture are restricted to fresh OS-temp staging, and production backup remains forbidden.

A real TEST deployment still needs a pinned Windows launcher with verified gateway and every backend process identity, exclusive writer fencing, trustworthy SQLite checkpoint/backup acquisition, durable backup journal, off-device attestation, isolated restore and session recovery tests, and a separate explicit TEST-only approval.

No merge to main, LIVE/TEST deployment, release-denylist changes, task installation, or automatic lock removal is part of this PR.

Run: node --test scripts/test-private-disposable-supervised-backup-handshake.mjs
