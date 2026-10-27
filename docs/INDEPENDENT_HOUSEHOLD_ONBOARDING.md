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
  A separately trusted in-process supervisor can now call the private
  gateway's `enrollHouseholdBackend({householdId,port,upstreamToken})` only
  AFTER it starts a unique pre-provisioned, loopback-only backend. The gateway
  confirms the central invited owner, unique port and token, provisioned disk,
  backend household identity, empty initial events and safe share state before
  atomically publishing the runtime route. No browser route activates a family.
  The new private activation record persists the operator's approval in CENTRAL
  SQLite, without persisting any upstream secret or port. In the disposable
  restart fixture, a trusted supervisor reads only approved household IDs,
  shuts down and restarts all real backends, rotates private upstream secrets
  and ports, verifies bindings and restores the same private calendar and Lists.
  Newly registered but never approved households remain offline after restart.
  This is not yet a production service manager, and OS process attestation,
  automated unattended Windows boot and real HTTPS TEST deployment remain open.
  No routes or processes are automatically opened by signups.
- The Household & Members Settings screen includes **New family invitations**
  only when a centrally authenticated person is on the gateway's trusted
  administrator allowlist. The new operator-only
  `GET /api/households/independent-administration` endpoint lists only the
  issuer's unexpired, unredeemed invitation IDs and their independently
  registered household names/states. It never returns stored token hashes,
  service secrets, upstream ports or password data. Operators can issue and
  revoke links from this screen; the raw one-time link appears only until
  the screen is closed. Ordinary household owners receive HTTP 403, with
  no operator panel, and legacy releases hide the panel on HTTP 404.
  Status **routed** means configured in the private gateway, not a promise
  of uninterrupted backend health. Starting/activating backend processes
  remains an explicitly trusted host-side operation, never a browser action.
- Development-only. No LIVE, TEST, main, account credentials, real household
  databases, services, scheduled tasks, backups or HTTPS/Tailscale routing
  are touched. All tests use disposable SQLite and filesystem paths.

Controlled server-side binding and a synthetic third-family owner -> login ->
pending -> verified backend -> private events and Lists integration test are now
in the development branch. Next: authorized operator activation/configuration
workflow and operating controls, unattended Windows backend supervision,
full cross-household sharing pilot and separately approved TEST validation. Never deploy this fixture
as a production multi-tenant gateway.
