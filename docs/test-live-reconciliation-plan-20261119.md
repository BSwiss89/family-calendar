# TEST / LIVE reconciliation — working plan (2026-11-19)

## Scope and safety
Planning branch only, based on last documented installed LIVE commit `3e694c4a8c626e89345bbc95cb085c540aebeb4b`. No deployment, source merge, migration, or operational change is authorized by this document. Installed laptop state must be independently verified before any deployment. TEST documented SHA: `3fe30d0d418006b0cc521c676439b14ce93e860c`.

## Baseline audit
GitHub compare LIVE...TEST: diverged; TEST 837 commits ahead and LIVE 128 ahead, 284 changed file entries (GitHub comparison, not feature counts). Main application, backend, auth, scripts and docs differ.

File-level spot check at exact SHAs:
- `src/main.tsx`: identical blob `5c5760db8c9c3410ee828e90bf2cc72ce9e98507`.
- `package.json`: identical blob `dd041808e7b0301dcc8dba47ff85286782ef622c`.
- `src/App.tsx`: different blobs; TEST imports household-member settings, shared event UI/feed; LIVE retains production-specific integrations.
- `Server/index.mjs`: different blobs; LIVE imports live notification/invitation/push/STT modules; TEST imports test equivalents, social-video analysis and private household gateway components.
- `Server/family-auth.mjs`: different blobs; TEST exports port-aware cookie-name resolver; LIVE has its existing production cookie selection. Treat as security-critical, no blind replacement.

## Work order
1. Confirm currently installed LIVE/TEST SHAs, task states, protected data paths and healthy authenticated HTTPS endpoints **read-only**. Compare these with GitHub baseline; if different, rebaseline.
2. Build a full file classification: (A) byte-identical/shared, (B) shared functionality needing reconciliation, (C) TEST-only unfinished features, (D) LIVE-only approved fixes, (E) site-specific deployment/config/secret/data handling. Never assume changed file = feature.
3. Inventory backend routes, schema migrations, login/session cookies, notifications, event CRUD, lists, Arney, social video, and household sharing; document dependencies and security boundaries.
4. Introduce feature flags only for safely isolatable optional features, default-off on LIVE. Do not rely on flags to protect schema/auth/data side effects.
5. Make narrowly scoped integration PRs with automated LIVE regression and TEST feature tests. Start with low-risk shared modules; postpone `App.tsx`, `Server/index.mjs`, auth and SQLite until detailed review.
6. Test integration in isolated worktree/CI and guarded TEST rollout; preserve TEST experiments. LIVE promotion remains manual, owner-approved, exact-SHA CI/backup/health/rollback controlled. LIVE auto-deploy stays disabled.

## Must preserve
Exactly two existing public HTTPS calendar environments (TEST and LIVE); separate DB/uploads/session identity; LIVE Lists/stores/categories, event operations, invitations, notifications, local STT, home widgets, Arney and profile selection. TEST may contain unfinished Instagram import, household sharing and Add Event person-name PR #241. Do not create a third deployed calendar.

## Next action
Perform read-only installed-SHA verification and comprehensive per-file categorization. Then propose the first small code PR. Do not merge or deploy this planning branch.
