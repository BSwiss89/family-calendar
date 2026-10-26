# Independent-household owner onboarding — PRIVATE integration only

Unlike a **member invitation**, this flow creates a NEW independent household
with a server-generated storage identifier, separate SQLite database/uploads,
and its own first owner account.

- Invitation issuance/revocation requires an authenticated person on an explicit
  server-trusted numeric user ID allowlist supplied as
  `independentHouseholdAdministratorUserIds` to the private gateway.
  Empty by default. The browser can never choose an administrator role.
- A 256-bit single-use token is stored only as a SHA-256 digest in CENTRAL SQLite.
  Expiration is 72 hours. Three issues/hour and ten pending invites/admin;
  administrator suspension and token revocation prevent redemption.
  Raw secrets are returned only when issued, in an HTTPS URL fragment.
- Anonymous new-owner signup enforces HTTPS same-origin POST, 4 KB JSON, exact
  field allowlist, no-store/referrer protections, 5 attempts/token per 15 minutes,
  generic errors, 14–200-character scrypt password and no automatic session.
  The browser cannot choose an account kind, household ID, storage path or role.
- SQLite registry, owner account, membership and consumed invitation commit
  atomically. Storage provisioned exclusively before central commit cannot be
  rolled back atomically with SQLite; a crash or DB rejection may leave an
  UNREGISTERED orphan that remains inaccessible. Offline operator reconciliation
  is required; never silently reuse or delete existing household paths.
- **Provisioning is NOT activation.** The private gateway binds to a fixed,
  trusted map of prestarted household backend processes. This version lets
  invited owners register and then sign in; their event/Lists routes are not
  enabled until a separately reviewed backend enrollment and binding step.
  No routes or processes are automatically opened for new signups.
- Development-only. No LIVE, TEST, main, account credentials, real household
  databases, services, scheduled tasks, backups or HTTPS/Tailscale routing
  are touched. All tests use disposable SQLite and filesystem paths.

Next stage: controlled server-side backend enrollment/activation and a full
browser end-to-end test covering new owner login, lists/events, membership and
optional trusted sharing, followed by separately approved TEST validation.
