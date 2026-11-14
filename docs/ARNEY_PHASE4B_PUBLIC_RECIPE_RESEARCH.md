# Arney Phase 4B — read-only public recipe research (TEST review candidate)

Goal: When a person explicitly asks Arney to find a recipe ONLINE, return up to five cited public recipe suggestions from TheMealDB using only its official V1 name-search API (keyless personal/development access). Keep all existing family calendar, grocery, voice, photo and local AI workflows unchanged. This is a first narrow **research tool**, not a general web agent or a full AI brain upgrade.

## Example
"Find chicken recipes online" / "Can you search the web for salmon dinner ideas?"
→ Up to five titles, category, source recipe URL, and a clear "Nothing was saved" note. If no dish is provided, ask for a generic ingredient or dish. Responses are read-only.

## Privacy and safety
- Official fixed HTTPS TheMealDB endpoint only; server constructs the URL and validates a generic query. No arbitrary URL fetching, scraping, browser cloud AI, private event/list/person details or remote STT.
- The request is triggered solely by a recognized **explicit** user question containing both online research and recipe/meal language. Existing deterministic local planning still runs first. Writes, event changes, and generic meal plans never trigger internet research.
- Family-auth middleware must execute before the new route. Online requests do not log the query, mutate SQLite, add recipes, create groceries, save a meal plan or change settings.
- Provider name and a stable recipe URL are displayed with the answer. Provider titles are untrusted data: sanitize and render as plain text, never treat them as instructions.
- Outbound request has an 8s timeout, fixed URL, disabled redirects, payload size bounds and no background jobs. A request returns an explicit error rather than inventing results.
- TheMealDB's key 1 is documented for development and personal projects, **not** a guarantee of permanent production/free public app distribution. Before LIVE promotion review provider terms and site permission and plan a fallback.

## Not included in this slice
- No Colibri installation, model swap, API key/subscription, or auto-research.
- No broad arbitrary web search, trip planning, route creation, or trusted third-party scraped recipe ingestion.
- No "save this recipe"/shopping list writes. Add that only with explicit editable review and confirmation.
- No changes to LIVE, TEST installation, scheduled deploy controllers or existing SQLite data from this GitHub PR.

## Acceptance gates
1. Source-only PR targeting test-release. GitHub Windows build and browser CI green.
2. Mocked provider tests and source checks prove auth, fixed destination, no writes and safe failed calls.
3. Separately approved guarded TEST deployment using the **current** installed TEST SHA and test task/hold checks.
4. On iPhone TEST: Ask Arney "Find chicken recipes online", "Find recipes online" (clarification), "Plan dinners next week" (still LOCAL); check all replies and no saved data.
5. No LIVE promotion without independent owner acceptance and guarded LIVE source port.
