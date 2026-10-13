## Stage 8: Preserve commit-pinned npm dependency candidates before a live swap

After the laptop verified two independent real npm installations could be switched, deliberately broken and rolled back, we need to ensure the **candidate package tree belongs to the exact approved release**. `scripts/prepare-commit-dependencies.ps1` now prepares a **durable staging folder outside both live and test repositories**. It checks clean Git repositories, the TEST checkout on `main`, and verifies its 40-character commit against a bounded live GitHub main reference query. It refuses any requested commit that does not match. It then installs the exact TEST checkout's lockfile with `npm ci --omit=dev`, validates the installed dependency tree, Express/Multer, and Sharp, and checks package and lockfile SHA-256 hashes before atomically renaming the prepared directory into:

`C:\Users\bobby\Projects\family-calendar-release-backups\dependency-candidates\<full Git commit SHA>`

The directory contains `package.json`, `package-lock.json`, `node_modules`, and `candidate.json` metadata for the matched approved commit and input hashes. Existing candidates are never overwritten. The final candidate directory intentionally persists for later controlled release tests. It occupies additional local disk space; do not delete it while a release or rollback is being investigated.

After this PR merges and is automatically distributed to the laptop, run from the laptop PowerShell session:

```powershell
Set-Location "$env:USERPROFILE\Projects\family-calendar-test"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\prepare-commit-dependencies.ps1"
```

Look for `COMMIT-PINNED DEPENDENCY CANDIDATE PASSED`. This only stages packages and creates metadata under release-backups; it does **not** change live `node_modules`, the server task, live SQLite or current calendar UI. The existing deployment policy still **blocks package.json and package-lock.json changes**. Before enabling live dependency switches, the guarded backend deployer must verify the staged commit, code/manifest hashes, active package tree, process shutdown and atomic rollback and complete a controlled restart/recovery drill. npm install lifecycle scripts can execute arbitrary code: only merge trusted reviews and do not treat temporary folders as a security sandbox.

---

## Stage 7: Rehearse rollback using real npm-installed packages

The synthetic package swap tests, isolated npm installation, and production backend preflight have all succeeded on the laptop. The next step tests the **actual module directory operations** using two independent `npm ci --omit=dev` installations. `scripts/rehearse-real-dependency-rollback.ps1` creates its entire test fixture in a unique temporary folder, installs the current lockfile twice, and validates both trees with Express, Multer and Sharp.

The rehearsal moves the former installed `node_modules` to a preserved directory, switches in the candidate tree, and verifies packages work **from the new location**. It then deliberately renames Sharp **inside the disposable candidate folder**, verifies the broken runtime is detected, restores the entire previous `node_modules` directory using the same `Restore-FamilyCalendarDependencies` helper intended for production, and verifies it is healthy again. It preserves the rejected candidate separately until the disposable rehearsal directory is removed. It also runs as part of the Windows CI checks.

Run this from the laptop once the release reaches your test checkout:

```powershell
Set-Location "$env:USERPROFILE\Projects\family-calendar-test"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\rehearse-real-dependency-rollback.ps1"
```

Expected: `REAL NPM DEPENDENCY ROLLBACK REHEARSAL PASSED`. This proves the directory swap and rollback with real packages, **not** a safe live version upgrade: both test installations use the same approved lockfile, and no real server is stopped or restarted here. Deployment still blocks package/lockfile changes. Before allowing them we must integrate a commit-matched candidate package installation with guarded server stop/restart, comprehensive rollback and operator-visible failure holds, then complete a controlled recovery drill on the live laptop.

---

## Stage 6: Require dependency preflights in each guarded backend release

The previously tested isolated npm installation and synthetic directory rollback are now **mandatory pre-restart checks** for every guarded backend deployment. After the test-backend and SQLite migration preflights pass, `scripts/deploy-backend.ps1` executes:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\test-dependency-rollback.ps1
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\stage-dependencies.ps1
```

Both must succeed **before** the live `Family Calendar Server` task is stopped. If either fails, deployment aborts without replacing the live packages, code or SQLite. CI also asserts that both checks remain before the first live-server stop instruction and that the dependency-change block remains intact. The log prints `[PASS] Dependency switch/rollback fixtures and isolated npm staging` when both checks pass.

**Important limitation:** This is a preflight gate, not yet a real production package swap. `package.json`, `package-lock.json`, and database migration edits remain blocked from unattended live deployment. A safe actual dependency-changing release still requires staging the approved candidate tree, stopping Node, preserving the previous live dependency directory, switching the candidate in, validating the restarted app, and restoring old code/packages if needed. That path will be enabled only after a controlled live rollback drill.

---

## Stage 5: Dependency rollback safety fixtures

Before changing any packages in the live calendar, the Windows CI workflow now exercises the same directory moves we intend to use for production releases. `scripts/dependency-swap.ps1` defines **inactive, explicit-use** dependency switch and restoration functions. It **does not execute a package switch by itself**. The test `scripts/test-dependency-rollback.ps1` runs entirely on generated synthetic package directories under the Windows temporary folder:

- New packages move into the active directory while prior packages are preserved in a separate backup directory.
- A simulated failed health check restores the previous packages and preserves the rejected candidate.
- An injected failure between the two directory moves restores the original active packages.
- Backup collisions, nested directories, or missing stages are refused without changing the active packages.

Windows GitHub Actions runs this fixture suite automatically. It can also be run by hand after this PR deploys:

```powershell
Set-Location "$env:USERPROFILE\Projects\family-calendar-test"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\test-dependency-rollback.ps1"
```

**Auto-deploy still blocks dependency updates.** Before enabling them, the guarded backend release must stop and confirm the live Node process has exited; bind a staged package tree to the exact approved GitHub commit; preserve the old `node_modules`, code and frontend; activate new packages; health-check; and restore the old package directory and code on failure. The synthetic tests above do not demonstrate these live safeguards. Never remove the deployment hold flag without investigating a failed deployment.

---

## Stage 4: Isolated runtime dependency installation

A package or lockfile update can install new third-party code and native Windows modules, which must not be installed directly into a running calendar. The new read-only-to-live `scripts/stage-dependencies.ps1` command verifies GitHub `main` in the separate TEST checkout, creates a disposable ignored folder under `family-calendar-test/logs`, copies the approved `package.json` and `package-lock.json`, and runs:

```powershell
npm ci --omit=dev --no-audit --no-fund
npm ls --omit=dev --depth=0
```

It verifies direct dependency resolution, successful Express/Multer loading, native Sharp image encoding, and unchanged hashes of the approved manifests. The staged directory is removed even if a check fails; the live `node_modules`, live DB, calendar service, and the test working tree remain untouched. GitHub CI also checks runtime dependencies and Sharp on Windows.

After the automated task installs this change, run the following in the laptop's PowerShell (not from the phone):

```powershell
Set-Location "$env:USERPROFILE\Projects\family-calendar-test"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\stage-dependencies.ps1"
```

**IMPORTANT:** This does **not** yet install packages into the live app or lift the existing deployment block on `package.json` / `package-lock.json`. Installing packages executes dependency lifecycle scripts and is not a full sandbox; only approve trusted PRs. The next phase must stage versioned runtime dependencies for the exact GitHub commit, swap them only with the backend stopped, and restore the previous dependency tree and code if health checks fail. We will test that rollback path before enabling unattended dependency-changing merges.

---

### Synthetic migration safety regression test

Before we let a schema change deploy automatically, the preflight must prove it can distinguish **safe additive changes** from **destructive changes**. GitHub Actions now runs:

```powershell
node scripts/preflight-migrations.mjs --self-test
```

This uses *generated dummy records*, never the household DB. It exercises the production preservation validators: an added table and column must pass, running that migration twice must pass, changing an existing event must be rejected, and dropping a table must be rejected. The live-snapshot smoke test (`node scripts/preflight-migrations.mjs`) remains a separate laptop-only check. These tests do not yet authorize unattended schema changes or dependency installs.

## Stage 3: Enforce migration safeguards before backend deployment

For every **guarded backend deployment** (including ordinary API changes), `scripts/deploy-backend.ps1` now runs the synthetic SQLite regression fixtures and the complete disposable-snapshot migration preflight **before stopping the live service**. Either failure stops deployment before it touches the running calendar. The existing release script still rejects startup migration edits and dependency/lockfile changes: this PR **does not** automatically authorize migrations or dependency installations.

When inspecting a successful backend release log, expect `MIGRATION SAFETY FIXTURES PASSED`, `ADDITIVE SQLITE MIGRATION PREFLIGHT PASSED`, then the existing verified offline recovery snapshot and `BACKEND DEPLOYMENT PASSED`. This is a preparatory safety gate; rollback/staging of dependencies and explicit additive-schema rollout restrictions must be implemented and exercised before relaxing the existing block.

## Stage 1: Guarded database migration preflight

The existing automated release task has now been proven to restart the backend and recover a SQLite backup successfully. **Database schema changes and package dependency/lockfile changes remain blocked from automatic live deployment.** This stage adds a disposable migration-safety preflight; it does not relax those blocks.

After merging this PR and confirming the laptop has fetched the approved scripts, run from the elevated laptop PowerShell terminal:

```powershell
Set-Location "$env:USERPROFILE\Projects\family-calendar-test"
node .\scripts\preflight-migrations.mjs
```

The preflight uses Node's SQLite backup API to take a consistent short-lived snapshot of the running live database into an ignored local testing folder. It launches the candidate backend only against a **disposable DB on localhost:13003**, validates SQLite integrity and foreign keys, verifies existing tables/columns/data were preserved, starts it a second time to test repeatability, and then launches the previous live backend against a second copy of the migrated test DB to check code-rollback compatibility. It cleans up the temporary snapshot and reports pass/fail without touching live port 3001, live data, or scheduled tasks.

This is intentionally a **strict additive-schema gate**: data backfills, column renames/drops, table rebuilds, irreversible migrations, or existing-record changes require a special reviewed plan. Running arbitrary new backend code against a temporary database on the **same Windows laptop is not a full security sandbox**; review PRs before using it. Native dependencies must already pass `npm ci` and the separate test backend check.

**Next stage:** wire migration preflight into the guarded backend release and add dependency staging/rollback. Only after that is tested with a synthetic migration and a dependency update will we permit those releases unattended. Until then the existing safety block is intentional.

---
## GitHub SSH automation compatibility (October 2026)

The laptop's existing repository-local Git/SSH configuration works (verified by an SSH-agent-backed background `git ls-remote` job). Do not force a global `GIT_SSH_COMMAND` override in the preview/deployment watchers: that override was observed to hang even when normal `git pull` succeeded.

All scheduled GitHub reference checks now run in separate short-lived PowerShell jobs with a 25-second timeout, using the existing repository-local Git configuration and `GIT_TERMINAL_PROMPT=0`. A query timeout skips the check without modifying the live calendar. The preview runner and guarded deployment process use the existing configured SSH key.

After merging the SSH fix, pull `main` into the test repo and rerun both installers without `-Install` to verify readiness. Confirm the background tasks can authenticate after Windows restarts before depending on fully unattended deployments.

---
# Automatic browser previews for open GitHub pull requests

**Once installed:** the laptop checks GitHub approximately every **10 minutes** and starts the newest open, mergeable PR in the **separate preview checkout**. The browser link remains:

- **PREVIEW** — http://100.124.58.19:13002 (available only while a PR preview has started)
- **LIVE** — http://100.124.58.19:3001

Open the preview address in any desktop browser or iPhone Safari **while connected to Tailscale**. Its frontend, backend, test database, and uploads folder are separate from live. Changes to preview events, recipes, and lists should not change real household records. Existing live photos may be missing in preview. Both servers share laptop CPU/GPU (including Ollama), so AI activity could slow down live briefly.

## One-time setup after this PR is merged

Use the **elevated** laptop VS Code Remote-SSH PowerShell terminal one last time for initial setup. The encrypted GitHub SSH key must already be added to Windows ssh-agent so background jobs can fetch without prompts:

```powershell
Set-Location "$env:USERPROFILE\Projects\family-calendar-test"
git pull --ff-only origin main
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install-auto-preview.ps1"
```

The preview installer defaults to **readiness checks only**. If it passes, explicitly install its Windows Scheduled Task:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install-auto-preview.ps1" -Install
```

It asks for the Windows **account password**, not Windows Hello PIN, so the task can run while you're logged out. This task is called **Family Calendar Auto Preview**. It is distinct from **Family Calendar Auto Deploy**, which must also be installed separately following the instructions below. Installing the preview task does not enable live automatic deployment.

The newest open PR with a GitHub temporary merge ref is selected (GitHub may not expose one for PRs with merge conflicts). The watcher fetches and builds its **unmerged PR code**, starts the isolated Node server on the laptop's Tailscale address on port 13002, and verifies the preview health endpoint. It updates the preview when the PR changes, and stops the preview when no mergeable PRs are open. Only one PR preview runs at a time. You may still start a preview manually with \`preview-pr.ps1 -PullRequest N\` if a PR cannot be selected automatically.

**Safety limits:** a separate SQLite path prevents accidental normal API edits to the live database, but executing PR backend code on the same Windows laptop is **not a security sandbox**. Preview only branches you and ChatGPT trust. Never add code that accesses live files via hard-coded paths; never expose port 13002 to the public Internet. The normal Windows firewall might require an inbound rule restricted to the Tailscale interface, which we'll verify before opening it. A failed preview is not automatically deployed. GitHub merge remains the explicit approval for the live deployment watcher.

To inspect automation:

```powershell
Get-ScheduledTask -TaskName "Family Calendar Auto Preview","Family Calendar Auto Deploy" |
    Select-Object TaskName, State
```

Stop future automatic previews (the current Node preview may need to be stopped separately):

```powershell
Disable-ScheduledTask -TaskName "Family Calendar Auto Preview"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\preview-pr.ps1" -Stop
```

---

# Approved GitHub updates: preview and automatic laptop deployment

**Goal:** edit through ChatGPT / GitHub, preview frontend and backend on a separate URL, then merge the reviewed PR. The laptop checks private GitHub `main` every **15 minutes** and automatically runs the existing guarded frontend **or backend** deployment. A brief Node restart is allowed for backend updates. The gaming desktop can be unplugged.

**Current rollout:** scripts prepared in this PR, **not enabled on the laptop** until installed and verified. PR merge alone cannot install a Windows task or configure your SSH agent remotely. Database migrations, dependency changes, and unknown file types still require special/manual handling; the existing deployers reject them. An interrupted backend rollout can temporarily take the calendar offline; automatic attempts stop after a failure.

## Enable unattended deployments after merging this setup PR

1. On the laptop via elevated VS Code Remote-SSH PowerShell, pull the approved scripts into the **test** folder:

```powershell
Set-Location "$env:USERPROFILE\Projects\family-calendar-test"
git pull --ff-only origin main
```

2. Windows OpenSSH agent must be running and hold the **existing passphrase-protected key**; do not remove its passphrase or share it with GitHub:

```powershell
Set-Service ssh-agent -StartupType Automatic
Start-Service ssh-agent
& "$env:WINDIR\System32\OpenSSH\ssh-add.exe" "$env:USERPROFILE\.ssh\id_ed25519_github"
```

Enter the existing SSH key passphrase into the local Windows SSH prompt. The watcher uses `BatchMode=yes` and **will not** prompt while unattended. Verify after a reboot that the agent can still authenticate.

3. Read-only readiness test (checks noninteractive GitHub authentication; **does not install** anything):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install-auto-release.ps1"
```

4. **Only after reviewing the output and validating a preview**, install the task:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install-auto-release.ps1" -Install
```

The installer asks locally for the laptop **Windows account password (not Windows Hello PIN)** so Task Scheduler can run under the existing elevated account even when no desktop session is open. It does not copy a password or private key into GitHub. Task name: **Family Calendar Auto Deploy**. The watcher is copied outside GitHub into `C:\Users\bobby\AppData\Local\FamilyCalendar\auto-release` for a stable trusted task target. It uses the same guarded `scripts/release.ps1 -Apply` process that has already been tested manually. It never runs as SYSTEM and never writes to live SQLite directly.

The task checks GitHub every 15 minutes, deploys only after an approved PR is **merged into main**, and exits if already up to date. It checks repository remotes and clean source folders, uses the existing SSH key to fetch in noninteractive mode, and runs the existing test build and safety checks. Bad connectivity causes a later retry without changing live. If testing/release fails, the task writes `REQUIRES-REVIEW.txt` and does **not** retry another release until the hold is reviewed and manually cleared; investigate rollback results first. The separate `DEPLOYMENT-IN-PROGRESS.txt` marker also blocks retries after an interrupted or force-stopped deployment; do not clear either marker until the server and files are verified. Logs: `C:\Users\bobby\AppData\Local\FamilyCalendar\auto-release\auto-release.log`.

Manual emergency stop:

```powershell
Disable-ScheduledTask -TaskName "Family Calendar Auto Deploy"
```

Keep backups, including the laptop's independent SQLite snapshots and retrying desktop backup transfers, separate from GitHub. GitHub is source control, not a backup destination for household records.

## Interactive PR browser preview (before merge)

After these scripts are merged, each **future PR** can be previewed from the laptop with both its frontend and backend. Use an interactive PowerShell terminal:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\preview-pr.ps1" -PullRequest 9
```

Replace `9` with the actual PR number. The preview appears at the laptop's **Tailscale IPv4 address, port 13002**. It's sourced from the unmerged PR, and runs out of a third checkout `C:\Users\bobby\Projects\family-calendar-preview` with a separate SQLite copy of the **test** DB and separate uploads. Live remains at port 3001. On later preview starts, test-only changes in the preview DB persist. Do not use random untrusted PRs: the Windows process is not a security sandbox even though the database path is isolated. The server and Ollama share laptop CPU/GPU resources. Existing live photos may not be available in preview.

Stop the preview:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\preview-pr.ps1" -Stop
```

If the URL works locally but cannot be opened through Tailscale, check the Windows Firewall rule for inbound TCP **13002** on the Tailscale interface only. Never open this port to public Internet/FirstNet hotspot. A PR preview currently requires launching the command on the laptop; automatically creating preview instances for every PR is not yet included in this stage.

---

# Family Calendar: GitHub release workflow

The normal workflow is: ChatGPT prepares a pull request, you review and merge it, GitHub Actions checks the build, and **you explicitly deploy** from your laptop. Nothing deploys automatically when a PR is merged.

## One-command deployment (recommended)

Run from your laptop's **interactive VS Code PowerShell terminal**, not as SYSTEM. After merging a pull request:

```powershell
Set-Location "$env:USERPROFILE\Projects\family-calendar-test"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\release.ps1"
```

The default command updates **only the separate test copy**, installs/builds it, compares it against the live Git commit, then previews the appropriate guarded frontend or backend deployer. It does **not** deploy to live.

After reading the changed files and confirming the preview is safe, deploy explicitly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\release.ps1" -Apply
```

This repeats the test and runs the existing guarded deployer. Frontend-only changes use a no-restart release. Server changes and unknown file types are passed to the strict backend deployer for additional checks (and potentially rejected). Backend releases require an **elevated, interactive PowerShell session**, briefly restart the calendar, and create verified private backups. Dependency updates and known startup database migration changes remain blocked by the backend deployer.

**First use only:** after merging the PR that introduces `release.ps1`, download that script into the test checkout before invoking it:

```powershell
Set-Location "$env:USERPROFILE\Projects\family-calendar-test"
git pull --ff-only origin main
```

Never edit your live checkout, restore SQLite data, or force deployment to bypass guards. If deployment or recovery fails, stop and inspect the result before retrying. The private database, photos/uploads, environment settings, and Windows startup scripts are **never committed to GitHub**.

---

## Existing direct deployment scripts (advanced/diagnostic)

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

Snapshots are saved locally under `C:\Users\bobby\Projects\family-calendar-release-backups\sqlite`, outside the GitHub repository. They contain private household data and should never be uploaded to GitHub. Existing backup task retention is separate; do not assume these snapshots are automatically cleaned up.

Passing the restore test proves recovery of that snapshot into a separate file. It does not itself test live restoration, stop/start behavior, or downgrade-safe database migrations.

## Controlled server restart test

After verifying a fresh SQLite restore and checking backend preflight, verify the existing Windows scheduled task can stop and restart the live Node server without rebooting the laptop.

First run a **read-only preview** from the laptop's elevated VS Code Remote-SSH PowerShell terminal:

```powershell
Set-Location "$env:USERPROFILE\Projects\family-calendar-test"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\test-server-restart.ps1"
```

The preview requires a healthy server, correct SYSTEM-owned scheduled task and startup action, clean repositories, a recent local independent database snapshot, and no actively running Family Calendar backup tasks. It makes no changes.

Only when ready for a short calendar outage, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\test-server-restart.ps1" -Run
```

The command requests `Stop-ScheduledTask`, verifies port 3001 is released, requests `Start-ScheduledTask`, and checks a **new** Node PID plus live health. If startup fails, it attempts to start the original scheduled task again. It will not terminate arbitrary processes or start a second server while port 3001 remains occupied. This tests the original scheduler startup mechanism; it does not install new code or touch SQLite. Keep your VS Code SSH session available for troubleshooting.

If the command reports a failed or incomplete recovery, do not proceed with backend deployment; inspect the task state, listener, and startup logs first.

## Guarded manual backend deployment (preview first)

Only use this after PR review and merge, successful isolated testing, and a verified recovery snapshot. The first backend release should be performed while you can monitor the calendar through VS Code Remote-SSH.

Update the test checkout, then run the **non-modifying preview**:

```powershell
Set-Location "$env:USERPROFILE\Projects\family-calendar-test"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\update-test.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\deploy-backend.ps1"
```

Read the entire changed-file list. The deployer accepts reviewed changes to Server/index.mjs and supported frontend/CI/scripts/docs files, but blocks dependency changes and edits to the known database startup/migration block. This is a limited safety guard, not proof that arbitrary backend edits cannot modify data or schema. Any actual database migration requires a separate, reviewed migration plan.

Only after inspecting the preview and allowing a brief calendar outage, explicitly apply:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\deploy-backend.ps1" -Apply
```

The apply step updates and rebuilds the test clone, runs the isolated backend smoke test, checks that GitHub main still matches, stages a new frontend, stops the existing SYSTEM-owned scheduled task, verifies a **fresh SQLite backup and restore test while the live server is stopped**, preserves uploaded files, fast-forwards live Git, swaps the frontend, starts the existing scheduled task, and checks the new process and served homepage. The private backup is retained under the laptop's family-calendar-release-backups folder.

On failure, the script attempts to stop the candidate server, restore the previous Git code and frontend, then restart the original task. **It never automatically restores the database**, since data created after the snapshot could otherwise be lost. If any rollback or health check fails, do not retry until the problem is investigated. Git/code rollback does not always reverse schema changes.

This deployer is **manual**, not an unattended updater, and it doesn't provide a guarantee that a healthy endpoint means every feature is working. Check event creation, editing, photos, and AI features manually afterward. Do not edit live code while the release script is running.
