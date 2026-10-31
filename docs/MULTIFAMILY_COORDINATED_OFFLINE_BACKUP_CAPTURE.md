# Coordinated multi-household backup — disposable acquisition rehearsal

**Development-only.** This code does not create a backup of LIVE or TEST, stop services, configure Task Scheduler, clear writer locks, or authorize a production release.

## What this checkpoint adds

The existing offline restore-preflight and restore-copy modules checked a backup that had already been captured. The new `Server/private-disposable-coordinated-snapshot.mjs` rehearses the preceding **capture phase**, using only disposable input trees under the operating system's temporary directory. It accepts a separately prepared offline, checkpointed source holding:

- `central/identity.db`
- `households/<household-id>/.family-calendar-household.json`
- `households/<household-id>/data/calendar.db`
- `households/<household-id>/uploads/**`

The source has **no restore marker**. The new snapshot is created in an exclusive temporary folder, receives the offline restore marker, and is published via a rename only after the complete set passes the existing offline restore attestation. Every source file is SHA-256 hashed before copying, after copying, and again before publication. Copies must match. No existing destination is overwritten.

The module refuses unexpected SQLite sidecars (including WAL or SHM), unknown files, a mixed event-share snapshot, unfinished outbox/journal operations, active restorable sessions, missing household data, invalid SQLite, or an existing snapshot destination. It returns an independent attestation **to store in a separately protected catalog**. The attestation is deliberately not inserted inside the set it authenticates.

Run the seven disposable tests using:

```powershell
node --test scripts/test-private-disposable-coordinated-snapshot.mjs
```

The tests exercise separate identity and household SQLite databases, private Lists, nested photo uploads, an accepted event share, a second isolated restore, source corruption, active session refusal, unexpected sidecars, and preservation of previous backups.

## Important safety limits

**A consistent offline set cannot be manufactured from an active writer merely by copying files.** This rehearsal does not establish OS-wide writer quiescence, verify a Windows process inventory, perform SQLite checkpointing or live SQLite backup APIs, establish secure storage at rest, or protect the external attestation. Both the source and destination are restricted to OS temporary fixture directories by design. Never remove that restriction to point this code at the running laptop.

Before actual multi-family TEST deployment, build and separately approve:

1. A pinned Windows supervisor for the real primary and invited families, including OS process identity, controlled gateway shutdown, and all writer locks/SQLite handles fenced.
2. A real, quiesced acquisition procedure that snapshots the central identity and **every** household, with persistent backup transaction journal, independent off-device attestation, and no half-complete backups marked usable.
3. An offline restore rehearsal for the exact cutover candidate and an explicit decision about invalidating historical login sessions.
4. Confirmed login, People assignments, Events, Lists, event sharing and mobile/wall-display acceptance.
5. A separate TEST-only release approval and later independent LIVE/main approval.

No auto-deploy, `test-release`, release-denylist, scheduled task, `main`, LIVE or TEST modification is part of this work.
