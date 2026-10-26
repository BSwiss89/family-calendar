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
  A separately trusted in-process supervisor can now call the private\n  gateway's `enrollHouseholdBackend({householdId,port,upstreamToken})` only\n  AFTER it starts a unique pre-provisioned, loopback-only backend. The gateway\n  confirms the central invited owner, unique port and token, provisioned disk,\n  backend household identity, empty initial events and safe share state before\n  atomically publishing the runtime route. No browser route activates a family.\n  The returned route is in memory only; restarting requires explicitly approved\n  backend setup again. Service launch, persisted operator manifests and OS process\n  attestation are not yet provided. No routes or processes are automatically\n  opened for new signups.
- Development-only. No LIVE, TEST, main, account credentials, real household
  databases, services, scheduled tasks, backups or HTTPS/Tailscale routing
  are touched. All tests use disposable SQLite and filesystem paths.

Controlled server-side binding and a synthetic third-family owner -> login ->\npending -> verified backend -> private events and Lists integration test are now\nin the development branch. Next: authorized operator activation/configuration\nworkflow, persistent trusted backend startup supervision, full cross-household\nsharing pilot and separately approved TEST validation. Never deploy this fixture\nas a production multi-tenant gateway.
