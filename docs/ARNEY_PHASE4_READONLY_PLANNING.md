# Arney Phase 4A — Read-only household planning (TEST candidate)

Status: **source-only draft, not merged or deployed**. Owner approval is needed before TEST merge/deploy and a second approval is needed before LIVE. Built from `test-release` SHA `22a6b526a94dceb2104b4f0e4ac9d3ce42ec3578`.

## Why this slice

Arney's existing phone blue-plus hold, Whisper `base.en`, and Ollama `ministral-3:8b` already work. The existing app can draft single events, groceries, and individual meals, but typed freeform requests otherwise route to a limited intent classifier. Before adding more models, make household data useful for higher-level read-only questions using deterministic tools in the already-authenticated React session.

This slice **does not install another model, request paid AI, download recipes, modify the model or startup environment, or create an agent loop**. The existing Ministral routing remains the fallback for unrecognized commands. This is the initial safe building block for the planned more capable local orchestration.

## User-visible behavior

1. **Weekly family/my schedule:** "What's on our family calendar this week?" / "Show my calendar next week." Dates are Sunday–Saturday, aligned with the existing Calendar week view. Reuses App's existing occurrence logic so recurrence/multi-day exceptions are not reimplemented. "My" requires a selected personal profile; events are filtered by matching person ID.
2. **Potential overlaps:** "Check our calendar for conflicts this week." Find only *timed* event pairs sharing a date with valid HH:mm start/end intervals. Label as *possible*, not certain, conflicts. Distinguish same-person and different-person overlaps. No falsely comprehensive all-clear: missing end times, all-day events, cross-midnight events and accepted external shared events are not checked.
3. **Dinner ideas:** "Suggest five dinners from our recipes" / "Plan dinners for next week." Proposes at most five distinct existing recipe titles over available dates, favorites first. Preserves existing scheduled dinners from both `mealPlanItems` and legacy `mealPlans`; no new recipes, grocery items or meal entries are created. For unspecified date ranges, uses the next seven days beginning today; explicit `next week` uses the next Sunday–Saturday.
4. **Same UI:** Enter typed requests in existing Arney panel or hold blue + to talk. Responses appear inside Arney's existing reply panel with readable line breaks. No extra banners or Home layout modifications.

## Safety invariants

- Only already-loaded, authenticated client data; no new backend routes and no client-supplied database paths or household IDs.
- No `fetch`, files, new storage, SQLite mutations, hidden automatic writes or persistent conversation history in the planner.
- Existing confirmation-before-changes logic is untouched. Commands beginning with recognized mutation verbs are never consumed by read-only planning.
- Never claim full inter-household coverage: external accepted shared-event overlays are not in the local `events` array.
- No private event notes, locations, image paths, or raw transcripts are emitted by these tools.
- TEST-first. `main`, LIVE, `test-release` and the laptop scheduled tasks remain unchanged until explicit separately approved release steps.

## Verification

- `node --test scripts/test-arney-planning.mjs` — deterministic unit and integration-structure tests (weekly dates, person scope, recurrence callback, duplicates, overlap semantics, missing times, existing/legacy dinners, no online fallback, no writes).
- Existing `node --experimental-strip-types --test scripts/test-arney-commands.mjs` — unchanged event/list/meal draft routing.
- `npm run build` and automated mobile regression CI, followed by real iPhone TEST acceptance before considering LIVE.

## Future Phase 4B–4D (not implemented here)

- **4B:** secure server-side tool contracts for longer, read-only calendar and list context with bounded payloads and privacy validation; allow Ministral to propose a task plan, route only allowlisted tools, and validate/recheck the response against real data.
- **4C:** reviewable, multi-item meal planning and grocery drafts; model-generated suggestions require user confirmation before any save; use only free/permission-compliant recipe sources when online discovery is approved.
- **4D:** task benchmarks for complicated real requests, latency and timeouts, recovery when Ollama or Whisper is busy, and sensible short-vs-complex routing using the same `ministral-3:8b` and `base.en`.

No claims are made that 4B–4D are implemented by this draft.
