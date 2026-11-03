# Family Calendar authentication integration — DRAFT ONLY

This isolated authentication foundation is ported from draft PR #44 onto current main without merging its old Arney changes. Existing LIVE, TEST and preview servers, databases, backups, scheduled tasks and Tailscale configurations remain unchanged.

- `FAMILY_CALENDAR_AUTH_MODE=required` protects the API, uploads, and pages. It remains disabled by default for private backward compatibility, and MUST be required before public Funnel access.
- Passwords use salted scrypt hashes; secure `HttpOnly`, `SameSite=Strict`, host-only cookies hold persistent trusted-device sessions. SQLite retains hashed tokens, and 180 days of inactivity ends a session.
- Login throttling, cross-site request protection, secure login/account pages, password reset and per-device revocation are included.
- Because both websites share one Tailscale hostname, **LIVE** port 3001 uses `__Host-fc_live_session`; **TEST** port 13002 uses `__Host-fc_test_session`. A browser's cookie jar is NOT separated by port.
- Run `node --test scripts/test-family-auth.mjs` to validate security behavior on disposable servers.

DO NOT MERGE, DEPLOY, OR TURN ON PUBLIC FUNNEL during draft review. First validate a full modern Calendar backend under `required` mode with an isolated synthetic database, verify 401/redirect/upload protections, test two independent private HTTPS sessions on real browser/iPhone, ensure no public or direct-backend bypass, and rehearse a backup/rollback cutover. The existing release guard intentionally blocks auth and private household files until separately approved.

PR #46 remains a private multi-family prototype and needs its own trusted gateway, account/household migration, cross-family security review and coordinated restore before any outside family can use the public websites. PR #53's Lists design is unaffected.
