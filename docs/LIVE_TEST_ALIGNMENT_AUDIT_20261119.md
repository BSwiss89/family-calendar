# LIVE / TEST alignment inventory — 2026-11-19

Status: **read-only planning; no release approval**.

## Verified installed baselines
- LIVE: `6377963372c30e8c4c4e33af6bf617d87961e989` (owner-verified).
- TEST: `7e83f4ac03da40bc01731f998d95e0a63e434cd0` (11:04 CT deployment report PASS, auth PASS, backup present, polling PT1M).
- GitHub comparison: diverged, 287 changed paths; TEST comparison 846 commits ahead and 130 behind LIVE. These are history counts, not feature counts. Comparison may truncate file stats; do not infer zero-size changes from missing stats.
- Changed-path grouping: 72 src, 69 Server, 111 scripts, 24 docs, 6 public, 2 .github, 2 stt, 1 .gitignore.

## Existing controls — reuse, don't duplicate
- `scripts/check-private-preview-release-scope.mjs`: known private-preview path denylist; it is explicitly **not** a complete security review. Apply to full LIVE-to-candidate diff, not only the final commit.
- `scripts/audit-household-live-parity.mjs`: advisory file-presence comparison pinned to historical LIVE `742addb...`; **not** a current LIVE parity or deployment authorization. Update pins and semantics in a separate reviewed change before reusing.
- `src/optionalFeatureFlags.mjs`: fail-closed optional flag resolver, **not wired to runtime**; a flag does not replace backend authorization.
- `.github/workflows/build.yml`: existing CI; some parity steps are conditional on old PR/branch names.

## Review buckets
1. **Shared UI candidates**: `src/App.tsx`, `src/App.css`, `src/index.css`, profile picker, daily notes, release highlights, weather and recipe UI. Review each behavior; LIVE already has approved person-name labels and Lists functionality.
2. **TEST-only / unapproved**: private household gateway and signup, independent household onboarding, event sharing experiments, Instagram social-video extraction, push pilots. Do not promote by blanket merge.
3. **Sensitive backend**: `Server/index.mjs`, `Server/family-auth.mjs`, auth UI, notification capture, SQLite migrations and membership storage. Require route/auth/schema/backup regression review.
4. **Environment-specific**: separate HTTPS endpoints, cookies, auth, databases, uploads, Windows tasks, source/asset pins, local STT and Funnel routing. Keep separate.
5. **Release tooling**: `scripts/secure-test-auto-deploy.ps1`, source pins, one-minute polling, LIVE guarded controller and approval manifest. Share only validation logic, never LIVE automatic deployment.
6. **Tests and docs**: reusable non-destructive checks can be shared; deployment-specific tests remain environment-aware.

## Safe reconciliation order
1. Produce complete bidirectional file-and-behavior inventory, including files unique to LIVE (the GitHub comparison is directional).
2. Classify each feature as already LIVE, approved for promotion, TEST-only, or environment-specific.
3. Update stale audit pins in isolated PR; add tests that reject unapproved LIVE scope and fail closed on missing baseline.
4. Refactor low-risk shared helpers with tests; leave backend/auth/data migration until separately approved.
5. Verify on TEST, then request **specific explicit LIVE approval** for a pinned release and guarded preflight.

## Non-negotiable boundaries
Exactly one LIVE and one TEST; no third deployment. No blanket merge, database copying, credential exposure, auth weakening, automatic LIVE deploy, service restart, or deletion of historical staging folders. This inventory is not proof of behavioral parity.
