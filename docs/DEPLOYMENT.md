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
