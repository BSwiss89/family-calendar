# Secure LIVE automatic frontend deployment — first release

Status: the original controller is installed on LAPTOP1502 but was disabled during
the November 2 notification cutover. The launcher-pin correction below is a
review candidate; do not enable the installed original controller.

## November 2 launcher-pin correction

LIVE is running notification release `ea6dcd4805cf9f3dcf1dc5a9b25a91931148bd6d`.
The user confirmed real iPhone notification delivery after the 22:31:50
America/Chicago deployment. The recovered backend, authentication and database
remain the baseline; no repeat deployment is needed to close out this release.

The original frontend updater changed `dist/index.html` without changing its
secure startup pin. The old server stayed healthy, but its next restart failed.
Its old approval record targets PR #110; at the newer LIVE commit the original
controller rejects the mismatch and writes a review hold, rather than downgrading.

The corrected controller statically checks all four protected file pins before
work, rejects protected backend or lockfile changes in a frontend-only candidate,
and saves verified original and candidate launcher files before changing LIVE.
It updates the frontend pin with the bundle, verifies all pins afterward, and
restores the exact previous launcher during ordinary rollback. The existing
durable journal records both launcher paths for manual power-loss recovery.
It never executes the launcher while inspecting it or prints secret values.
Startup-health testing is not an unattended server restart: this controller
continues to support frontend-only releases only.

`ops/secure-live-deployed-baseline.json` is a proposed receipt, not the active
approval file. Its `deployed-baseline` kind requires LIVE to match the exact
recorded SHA, a successful exact-SHA build run and an empty file list, then
returns without deploying anything. It does not convert the backend notification
release into a frontend-only approval or authorize a future commit.

Operator sequence after review/merge approval:

1. Keep the existing LIVE auto-deployment task disabled. Preserve its installed
   controller, helper files, task XML and current approval JSON before updating.
2. Install the reviewed controller and new `secure-live-launcher-pins.ps1` helper
   into the existing restricted ProgramData directory, verifying exact hashes.
   The existing installer deliberately refuses to overwrite an installation;
   an operator must perform this backed-up in-place update. No task credentials
   or application source need changing.
3. Verify LIVE still has the recorded notification SHA, all four launcher pins,
   HTTP 200 health, anonymous HTTP 401, unchanged TEST health, and no unresolved
   hold or journal. Investigate existing state; never automatically delete it.
4. After operator authorization, replace only `ops/secure-live-approved.json` on
   `secure-live-release-approvals` with the reviewed deployed-baseline receipt.
   Preserve the previous JSON in the operator backup; Git also retains history.
5. Run the corrected controller once with `-Apply` while its task remains
   disabled. It must report `DEPLOYED BASELINE VERIFIED; NO DEPLOYMENT` and leave
   the application SHA, frontend, launcher and process unchanged.
6. Enable the existing task only after the no-deployment verification passes.
   Future frontend deployments still need a separate explicit approval and both
   exact-SHA Build and Deployment safety workflow successes.

The failed first cutover backup remains intact at
`C:\Users\bobby\CalendarBackups\NotificationLive\pr123-cutover-20261102-220113-ece7ac`.
The successful cutover backup (including the working rollback launcher) is at
`C:\Users\bobby\CalendarBackups\NotificationLive\pr123-retry-20261102-223143-b31aa7`.
Do not rerun the superseded Stage 12 deployment script.

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
