# Family Calendar: frontend deployment

Two laptop folders:
- LIVE: `C:/Users/bobby/Projects/family-calendar` — scheduled Node server, port 3001
- TEST: `C:/Users/bobby/Projects/family-calendar-test` — GitHub testing copy

Only reviewed frontend/configuration changes are eligible for this first deployment command.
Changes to `Server/`, `package.json`, `package-lock.json`, or other unapproved paths are rejected.

## After merging a pull request

Run in PowerShell on the laptop through VS Code Remote-SSH:

```powershell
Set-Location "$env:USERPROFILE/Projects/family-calendar-test"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "./scripts/update-test.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "./scripts/deploy-frontend.ps1"
```

The first command downloads GitHub main and rebuilds the testing copy.
The second command is a **preview only**. Review its file list.

Deploy an approved and verified frontend build:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "./scripts/deploy-frontend.ps1" -Apply
```

The command re-tests the candidate version; confirms clean Git worktrees, expected remote, and healthy live server; verifies GitHub main is the tested commit; updates live source; swaps the compiled frontend; and checks the served page and API health endpoint. It does not restart Node.

The previous frontend and its commit ID are saved under `C:/Users/bobby/Projects/family-calendar-release-backups`.
If deployment validation fails, restoration of the previous frontend and Git version is attempted. If rollback is incomplete, do not attempt another deployment until the cause has been resolved.

## Limits

- This is a manual command, not automatic deployment.
- Backend and dependency updates require a different, restart-aware release process.
- This does not test database schema migrations.
- A browser refresh may be required to see new frontend changes.
- The current SSH key passphrase must be entered when fetching from GitHub.
- Never run deployment as SYSTEM or edit live source concurrently with it.
- GitHub is not a substitute for the independent backups of live SQLite data and personal uploads.

## Isolated backend testing (before backend deployment)

After merging a backend-related pull request, update the test folder. The test folder must contain an independent SQLite database snapshot in `Server/data/calendar.db`. This file stays on the laptop and is ignored by Git.

```powershell
Set-Location "$env:USERPROFILE\Projects\family-calendar-test"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\update-test.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\test-backend.ps1"
```

The temporary test server runs on `127.0.0.1:13001` and uses the testing folder's own database and uploads folder. It checks both its health endpoint and the live server's health; it stops its own test process afterward. Error logs remain in the ignored test `logs` directory.

This smoke test does not exercise every API, integration, or migration scenario. It does not deploy backend code. `deploy-frontend.ps1` will continue to reject backend changes. A separate restart-aware backend release/rollback mechanism must be implemented and tested before deploying backend changes to the live server.

## Backend release preflight (no restart)

Before constructing or running a backend release, use the read-only preflight on the laptop:

```powershell
Set-Location "$env:USERPROFILE\Projects\family-calendar-test"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\check-backend-release.ps1"
```

It verifies the current SYSTEM-owned server task, the live Node process and cmd parent, health endpoint, both Git working trees, database locations, and backup task results. It does not display calendar data, modify the server, update Git, or execute a restart.

Passing this check alone does not prove backup restorability or guarantee safe database migration rollback. Those remain separate requirements before backend deployment.

## Validate an independent SQLite backup and restore

After merging the recovery-test script into GitHub main and updating the **test** repository, run in the laptop's VS Code Remote-SSH PowerShell terminal:

```powershell
Set-Location "$env:USERPROFILE\Projects\family-calendar-test"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "node .\scripts\verify-sqlite-recovery.mjs"
```

The script makes a consistent backup via the built-in Node SQLite backup API while the live server keeps running. It copies the snapshot into a separate disposable restore file, compares hashes, opens both as read-only SQLite databases, runs `PRAGMA integrity_check`, and verifies key application tables and row counts. It deletes only the disposable restore file, **not** the retained recovery snapshot.

Snapshots are saved locally under `C:\Users\bobby\Projects\family-calendar-release-backups\sqlite\`, outside the GitHub repository. They contain private household data and should never be uploaded to GitHub. Existing backup task retention is separate; do not assume these snapshots are automatically cleaned up.

Passing the restore test proves recovery of that snapshot into a separate file. It does not itself test live restoration, stop/start behavior, or downgrade-safe database migrations.
