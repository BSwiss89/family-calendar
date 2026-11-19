# Shared Calendar Reconciliation — Verified Initial Inventory (2026-11-19)

## Source-of-truth installed commits
- LIVE: `6377963372c30e8c4c4e33af6bf617d87961e989`
- TEST: `7e83f4ac03da40bc01731f998d95e0a63e434cd0`
- These histories diverge. The GitHub compare endpoint reports 287 changed paths and may mark files as added or modified even where the *installed endpoint content* matches. Its `changes: 0` values are not proof of identical content.

## Independently fetched from both installed commits — identical content
| File | Result | Action |
| --- | --- | --- |
| `Server/daily-family-notes.mjs` | Same complete text in LIVE and TEST | No reconciliation |
| `Server/photo-event-date-range.mjs` | Same complete text in LIVE and TEST | No reconciliation |
| `src/CalendarPersonFilterAvatar.tsx` | Same complete text in LIVE and TEST | No reconciliation |

These results come from full GitHub file reads at the exact installed commits, not from change counts. They are an initial sample, **not** a comprehensive audit.

## Priority inspection buckets (not yet classified as safe to promote)
1. Calendar presentation and event editing: `src/App.tsx`, `src/App.css`; review targeted hunks and behavior, not wholesale replacement.
2. Shared utilities and standalone UI: compare complete blobs at both installed commits; record equal/different/missing explicitly.
3. Recipe and voice features: test-only features must be reviewed separately; do not assume that their presence on TEST authorizes LIVE release.
4. Backend `Server/index.mjs`, `Server/family-auth.mjs`, household sharing, authentication and private gateway: **high risk; excluded from early alignment changes**.
5. `.github/workflows/`, deployment scripts, stateful data, secrets, backups and runtime configurations: **out of scope for application-code reconciliation**.

## Safe procedure
- Fetch each candidate file at **both exact installed SHAs**, compare full content, and identify tests and imports.
- Prefer no change for identical files; for different files propose small targeted changes with explicit intended behavior and regression tests.
- Keep work on isolated GitHub branches and draft PRs; TEST deployment only through existing guarded workflow.
- LIVE changes require a separate explicit owner approval and existing guarded preflight. Never infer approval from green CI, parity reports or a merged PR.
- PRs #255–#259 are alignment groundwork; check their merge status independently. Do not assume their checks mean they are deployed.
- Read-only parity checks report differences; neither exact file matching nor a green report is security approval.

## Next action
Expand the dual-commit blob comparison to remaining calendar-only helpers, then choose the first *genuinely different, low-risk* module for a narrowly scoped draft PR. Do not modify `App.tsx` or backend routing solely to make SHA comparisons match.
