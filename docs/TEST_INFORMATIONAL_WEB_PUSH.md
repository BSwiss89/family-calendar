# Informational Web Push — one-family TEST pilot (PR #122)

## What the user sees
- Bobby creates or changes an event that involves Haylee.
- When Haylee has enabled phone alerts on her own iPhone, an informational
  **Family Calendar** push appears (including on the lock screen when supported).
- The push says there is an event to review. **There are no Accept, Decline,
  RSVP, or Ask Again Later actions in the system notification.**
- Tapping the push opens the EXISTING calendar. Its existing Invitations area
  contains assignment changes and other event invitations.
- Profile switching remains easy. A Home-selected session never receives
  person-targeted pushes. The subscription follows the selected profile
  after the app reopens/rebinds, and any logged-out/revoked session is excluded.
- No separate app, calendar site, or notification inbox.

**Important functional gap:** in the present event editor, selecting a person
creates an `event_people` assignment immediately. This is not the same thing
as a pending invitation or an affirmative RSVP. The push pilot must not be
described as implementing a complete "accept to join" workflow. That needs
a reviewed pending-invitation state in a later change. The Join/Leave
preview remains available for changing participation.

## iPhone requirements
1. iOS/iPadOS 16.4 or newer and HTTPS; existing TEST Tailscale HTTPS origin.
2. Open TEST in Safari, use Share → Add to Home Screen, then open the
   installed Family Calendar from its icon.
3. Sign in and choose your personal profile.
4. In the existing Invitations screen, tap **Enable phone alerts** and
   allow the notification permission prompt. iOS only permits that from
   an explicit user gesture. No native Apple app or paid service is needed.
5. To turn off alerts, tap **Turn off phone alerts** inside Invitations.
   Use iPhone notification settings if permission needs to be revoked.

## Architecture
- `public/family-push-sw.js` displays a standard user-visible notification and
  opens `/` (the existing calendar); no fetch interception or caching.
- `src/FamilyPushNotifications.tsx` requests permission only on tap and
  registers the browser PushSubscription with the authenticated backend.
- `Server/test-informational-push.mjs` is fully disabled unless
  `FAMILY_CALENDAR_TEST_WEB_PUSH=enabled` AND the instance is port 13002,
  required auth and the isolated `family-calendar-test*` directory.
- Server VAPID configuration comes exclusively from
  `FAMILY_CALENDAR_TEST_VAPID_PRIVATE` (base64url 32-byte P-256 scalar) and
  `FAMILY_CALENDAR_TEST_VAPID_SUBJECT` (mailto contact or HTTPS URL).
  **Never put the private key in the frontend, GitHub, logs or a chat reply.**
- On first flagged boot, additive SQLite tables `test_push_subscriptions` and
  `test_push_deliveries` are created on the isolated TEST DB only.
- A trusted 15-second worker reconciles the existing event mutation outbox
  even when the browser is closed. It sends generic encrypted RFC8291 Web
  Push via HTTPS with RFC8292 VAPID, including to Apple push endpoints.
  No event titles, locations, names, emails, or notes leave the calendar
  in push payloads.
- Only subscriptions for valid, nonrevoked authenticated sessions with the
  corresponding person selected are eligible. Expired sessions are excluded.
  Accepting a push at a provider does not mean a device displayed it.
- Allowed push destinations are Apple, Mozilla and Google browser push
  services. Redirects are disabled to prevent endpoint-driven SSRF.
  Failed sends are retried at most three times; 404/410 endpoints are removed.
  Per-notice/endpoint receipts avoid normal duplicate sends.
- No paid providers, external price APIs, new npm packages, or data exports.

## Manual rollout checklist (requires separate approval)
- Keep main, LIVE, LIVE data, and TEST auto-deployer unchanged.
- Check pending PRs and CI on exact candidate SHA and confirm approval to
  merge `test-release`, then separately approve a TEST installation.
- Preserve current TEST files, launcher, task definition, uploads and a
  consistent SQLite backup; independently verify the restore.
- Determine TEST Windows scheduled-task environment. Generate VAPID keypair
  locally and save private key in operator-controlled restricted configuration
  (not source or task command-line arguments). Verify subject and TLS.
- Preserve original launcher, update only the approved TEST backend hash and
  environment with an independently audited secure mechanism; restore on
  failure. **Never expose secrets in PowerShell transcript output.**
- Validate real HTTPS authenticated TEST login, person vs Home profile,
  subscription permission, phone background delivery on a real iPhone,
  notification click, profile switch, logout revocation, and server restart.
- Verify TEST health, unchanged LIVE health, disabled auto-deployer, and
  rollback readiness. Run cross-family isolation tests before any future
  multi-household or LIVE rollout.

## Limitations
- Web Push is best-effort and subject to phone permission, OS policies,
  connectivity and the push service. Provider HTTP acceptance is not
  proof the alert was displayed.
- New subscribers receive future event notifications, not historical pushes.
  Unread notifications remain in the existing calendar inbox.
- An in-flight generic push may arrive just after a profile is switched.
- This is explicitly **not** a production multi-household/identity solution.
