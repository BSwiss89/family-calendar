# Secure LIVE automatic frontend deployment — first release

Status: isolated PR-only development, NOT installed or enabled on LAPTOP1502.

## Two-site policy
- Existing secure LIVE server at `C:\Users\bobby\Projects\family-calendar-live-auth-candidate`, port 3001, secure HTTPS through the existing Tailscale supervisor.
- Existing secure TEST server at `C:\Users\bobby\Projects\family-calendar-test-security-stage`. **Do not modify or restart TEST.**
- GitHub `main` is not a deployment target. Legacy `Family Calendar Auto Deploy` and `Family Calendar Auto Preview` remain disabled.
- Existing `Family Calendar Secure TEST Auto Deploy` is separate and must not be modified.

## Approval gate
A user-approved release is an explicit JSON file at `ops/secure-live-approved.json` on dedicated GitHub branch `secure-live-release-approvals`. The exact `from_sha`, `to_sha`, changed file list, Build Family Calendar run ID and Deployment safety run ID must match. Any missing or failed check blocks release. A merge into a development branch does NOT automatically approve deployment.

The initial approval is the previously authorized frontend-only PR #110:
- FROM `0130a06bde94a1b616f38765c46a79b5764b0eef`
- TO `25e927b6f7fcee4e07bf8d87678419d2575cf523`
- Build run 41351911533, Deployment safety run 41351911560, both PASS.

## Workflow
1. Inspect the reviewed code and successful Windows CI; keep PR draft until explicit user merge authorization.
2. In an elevated laptop PowerShell, clone this candidate code into a new isolated staging folder, pin its exact reviewed head SHA, and run `scripts/install-secure-live-auto-deploy.ps1` (default read-only audit).
3. Run the installer with `-Install` only after review. It copies the controller/backup helper to a restricted ProgramData folder and registers `Family Calendar Secure LIVE Auto Deploy` as **disabled**. Windows prompts interactively for the account password; no passwords are logged or stored in source.
4. Run the installer with `-Enable` as a separate deliberate action. It performs another read-only preflight, verifies installed script hashes, and enables a fifteen-minute schedule.
5. The scheduled job reads the approved manifest and validates both successful GitHub Actions runs for the exact target SHA. For approved frontend-only files, it builds in disposable staging, backs up SQLite with integrity check, uploads and frontend, writes an in-progress journal, updates only the LIVE frontend source and compiled dist, then verifies service health and login.
6. On ordinary failures, the controller attempts to restore the previous frontend and Git commit, writes a hold and does not retry unattended. If power is lost mid-deployment, the durable journal blocks future runs until an operator investigates. Backups remain intact and must not be deleted until the user verifies the site.

## What is deliberately not automatic
- No server task stop/start, backend code, npm dependency changes to LIVE, database migrations, production account writes, new HTTPS endpoints, or household gateway changes.
- No unattended automatic recovery after a power interruption in the middle of deployment. The fail-closed journal requires human inspection to avoid compounding uncertain state.
- No edits to the existing TEST site or GitHub main.
- Future releases require a *new* explicit user approval and matching manifest update; a previous approval cannot authorize later commits.

## Operator investigation
State: `C:\ProgramData\FamilyCalendar\SecureLiveAutoDeploy`
Look at `secure-live-auto-deploy.log`, `REQUIRES-REVIEW.txt`, `DEPLOYMENT-IN-PROGRESS.json`, and the unique `backup-*` folders. **Do not delete hold/journal files before verifying source SHA, frontend, SQLite backup, upload preservation and service health.**
