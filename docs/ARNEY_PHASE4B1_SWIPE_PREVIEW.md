# Arney Phase 4B.1 — swipeable recipe previews + compound query (TEST candidate)

## Goal
Family can say "Find chicken recipes, one pot, pasta, kid friendly"; swipe through five public recipes at a time in the **existing Ask Arney popup**, inspect image, ingredients and instructions, tap "Find 5 More" to reveal the next *distinct* five results from the current verified pool, then tap **Save to Recipes**.

**Save to Recipes opens the existing EDITABLE Add Recipe form; it does not save anything.** User must review the draft and explicitly submit Save Recipe. Title, source URL, ingredients, instructions and category are prefilled. The provider photo is preview-only for now; user can choose a local photo in the editor if they want an image in the saved recipe.

## Search and ranking
- The free TheMealDB API has name search (full recipes), single-ingredient filtering and lookup; it has no proper conventional pagination, paid multi-filter is not used.
- Search one main generic ingredient/dish title. If pasta is requested with another ingredient, optionally do one additional **name** search for pasta, combine, deduplicate IDs and locally intersect pasta and main ingredients against actual recipe fields.
- "one pot" is only considered evidenced when explicit cooking text says one-pot, one-pan or "in the same pot/pan". Other results may appear, but do not claim all match.
- "kid-friendly" has no provider flag. Prefer milder ingredients and clearly label this as NOT a guarantee. Always read ingredient details for allergies, spice, dietary needs and safe cooking.
- Server caps each search pool to 25 candidates and 500k text per upstream request; "Find 5 More" reveals the next five in that pool without repeating an identical API request. If pool exhausted, UI says so, without inventing recipes.
- No source trust beyond the fixed official HTTPS endpoint, no arbitrary URL fetch, scraping, paid AI, or new models. The raw question and household/calendar data are NEVER sent to TheMealDB. Generic query and three boolean preferences only.
- No uploads, person data, SQLite changes, meal plan changes, grocery changes, saved history or background lookup.

## Release safety
- Pure source branch starting from exact merged TEST commit \`9ace3d6f759f09317550b5074897f8d43897c94f\`. Do not deploy to TEST or LIVE without later approval and guarded updater receipt.
- Existing TEST 9ace3d6 and LIVE a33dfb20 must remain untouched while reviewing.
- Run existing entire CI including TS production build, browser regressions, and the new bounded lookup/parser/save-review regression tests.

## Required iPhone TEST checks once separately deployed
1. "Find chicken recipes" → swipe cards, see photo/ingredients/instructions and source, then **Find 5 More** yields no duplicates when available.
2. "Find chicken recipes, one pot, pasta, kid friendly" → relevant matches; one-pot and kid-friendly are qualified; no invented claims.
3. Tap Save to Recipes → editable prefilled form; cancel and verify no new recipe. Repeat then Save, verify recipe is added only after explicit user confirmation.
4. Existing "Plan dinners next week" stays local, "What is on my calendar today?" stays local.
5. Close/reopen on iPhone Safari and test card swipe vs vertical scroll; calendar/Home layout and photo workflows unchanged.
