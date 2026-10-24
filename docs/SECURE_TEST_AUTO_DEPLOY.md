# TEST auto deployment (secure two-site configuration)

Status: opt-in. The installer must be run on the laptop by its administrator user before any Windows task exists.

## Authorization and scope
- Only `refs/heads/test-release` is deployable automatically. The current branch head must have a successful, completed **Build Family Calendar** GitHub Actions **push** run for that exact SHA and branch.
- Draft PRs, arbitrary latest PRs, `main`, and LIVE do not trigger TEST auto deployment.
- The approved promotion workflow is to merge a reviewed feature PR into `test-release`. GitHub performs the build; the laptop's scheduled task checks every 15 minutes.
- The old **Family Calendar Auto Preview** and **Family Calendar Auto Deploy** jobs must remain disabled. Do not reenable them.
- This adds NO public HTTP listener and does not alter Funnel, HTTPS mappings, server passwords, cookies, or LIVE startup.
- Current TEST application: `C:\Users\bobby\Projects\family-calendar-test-security-stage`; public TEST remains Tailscale Funnel port 443 -> 127.0.0.1:13003 -> TEST 100.124.58.19:13002. LIVE remains port 8443 -> 127.0.0.1:3001. Do not reverse.

## Installed runner
- `C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy\auto-test-deploy.ps1`
- Scheduled task: `Family Calendar Secure TEST Auto Deploy`; runs elevated under laptop user (requires Windows account password during installation, not Windows Hello PIN); every 15 minutes, non-overlapping.
- Startup task: `Family Calendar Secure TEST` remains the sole secure TEST server launcher.
- Log: `C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy\auto-test-deploy.log`
- Review hold: `C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy\REQUIRES-REVIEW.txt`
- Interrupted update: `C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy\IN-PROGRESS.txt`
- Backups: `C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy\backups`

## Safeguards
- Validate secure TEST task/process/listener, LIVE listener, disabled old preview tasks, and the unchanged DATA / UPLOADS junction targets.
- Require a clean checkout and fast-forward progression from the existing installed TEST commit.
- Refuse automatic deployment when `package.json` or `package-lock.json` changes; dependency runtime cutovers require independent review.
- Clone/build in separate folder, run auth/category/store/icon tests and TypeScript build before downtime.
- Stop only TEST, back up its SQLite data files (including WAL companions), uploads, and old frontend while TEST is stopped, check backup SQLite integrity, then update checkout and frontend.
- Restart TEST and verify health, authentication enabled, anonymous /api/events forbidden (401), and LIVE SHA unchanged.
- If update fails: attempt a code+frontend rollback and secure TEST restart; set a review hold to block automatic retries. SQLite schema changes may require manual restore from captured backup and must not be silently reverted.
- If the laptop powers off during a cutover, preserve the in-progress marker and require manual investigation. Never delete markers until the interrupted deployment is reconciled.
- The installed PowerShell updater is a reviewed copy and deliberately does not overwrite itself automatically from GitHub. Changes to the updater/installer need explicit re-installation review.

## Initial verification / operation
1. Launch an elevated PowerShell as the laptop admin and run `scripts/install-secure-test-auto-deploy.ps1 -Install` from a checkout of `test-release`.
2. Verify the scheduled task exists and its `LastTaskResult`, then inspect the log. Do not assume the installation immediately proves deployment.
3. Check the public TEST site from an iPhone after the current TEST rollout; the existing installed app may need to be closed/reopened to clear older PWA assets.
4. Use GitHub PRs with base `test-release` for subsequent TEST previews and promotions. LIVE remains manually approved.
5. If a hold is present, inspect logs and the backup and reconcile code+data+task state before allowing another attempt. Do not clear a marker on guesswork.

## Limitations
- This updater assumes the existing Windows laptop, checked-out app paths, Node 24 runtime, task launcher, port mappings and junctions that were verified October 24, 2026. It should fail safely rather than relocate anything if those facts change.
- It does not guarantee backward compatibility with every future database migration or bundled native dependency; those upgrades need an explicit reviewed procedure.
- Production multi-household migration remains **blocked** pending its separate gateway, permissions, isolation and restore audit.
