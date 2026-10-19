# Family Calendar release milestones and private preview gate

This is the release safety plan for the running **single-family calendar** and
future multi-family features. The current live calendar must remain functional
while PR #46 is reviewed. Do not use the draft multi-family code in production.

## What currently deploys

- GitHub Actions **builds and tests**; it does not itself deploy the live app.
- The repository includes `scripts/auto-release.ps1`, intended for a Windows
  Scheduled Task. If that task is enabled, an approved merge to `main` can
  trigger `scripts/release.ps1 -Apply` automatically on the laptop.
- We have **not** independently checked whether that Scheduled Task is
  currently enabled on the laptop; inspect it before any high-risk merge.
- The release scripts use a separate test checkout, a guarded deployment,
  snapshots and rollback procedures. Their existence is not proof that
  a new multi-household migration or network configuration is safe.

## Release milestones

1. **Now — frozen multi-family preview:** Leave draft PR #46 unmerged.
   The new `scripts/check-private-preview-release-scope.mjs` refuses known
   unfinished household, authentication, sharing and private AI paths in the
   full commit-range diff before any guarded deployment. No bypass flag.
2. **Independent small updates:** Develop self-contained changes on short
   branches off the latest `main`; create separate draft PRs and run tests.
   Merge only after release review and confirmation of automatic deploy state.
3. **Multi-family readiness:** Before enabling families, review tenant
   isolation, remote gateway security, data migration and backwards
   compatibility, isolated two-family recovery, backup retention, sharing
   revocation, Arney action fencing, provider spending, and permission model.
4. **Controlled rollout:** Only after a separate deliberate approval commit
   changes this guard, a successful rehearsed migration and restore, a
   verified production backup, and a reviewed deployment plan should the
   larger multi-household feature be eligible for release.

## Scope and limits of this guard

The release gate is deterministic and blocks **known private-preview paths**.
Both manual frontend/backend deployers and the central release dispatcher
invoke it against the entire Git file list from deployed to tested commit,
including mixed release changes. It fails closed on unusual file names and
on a missing guard module; the CI fixture tests all three entrypoints.

This is a **path-based policy**, not a complete security audit and not
protection against intentionally modified deployment scripts. It does not
analyze arbitrary edits to existing common files such as `src/App.tsx`
or `Server/index.mjs`. A reviewed, independent migration and source
diff inspection are still mandatory. It must not be disabled merely to
make a PR pass or accelerate a deployment.
