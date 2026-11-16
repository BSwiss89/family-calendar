# Arney Phase 4B.3 — Instagram/Facebook Social Recipe Link Import (TEST)

**Scope:** Only the current logged-in household's existing **Add Recipe** editor. Keep the seven-action blue +, photos, previous Arney results, stored meals and LIVE untouched.

## Exact behavior

1. Blue + → Add Recipe → **Import from Instagram or Facebook** expands a compact section inside the normal recipe form (also available when adding a recipe from the Recipe screen).
2. Paste a **direct, public** Instagram post/Reel or Facebook share/Reel/post/video URL. Tracking parameters are removed. No passwords, private accounts, arbitrary web URLs or other hostnames are accepted.
3. Optionally paste the creator's caption, with explicit `Ingredients:` and `Instructions:` / `Directions:` sections. An on-demand, authenticated backend endpoint classifies the link and extracts only the user's supplied caption wording; ingredients/measurements/steps not present are **never invented**. Existing user edits are preserved, source URL is attached.
4. The backend may make one best-effort **fixed-host official** `https://graph.facebook.com/v27.0/{instagram_oembed|oembed_post|oembed_video}` call to detect a publicly embeddable post, under a short timeout and with redirect rejection. The returned embed HTML is **not parsed, saved or rendered as recipe data**. No caption, household details, video or photo is sent to/obtained from the endpoint. The public embed check is not a guarantee that text or media are available and is never necessary to continue with a user-supplied caption.
5. The existing recipe editor receives only source URL and any grounded name/ingredients/instructions; user must review/edit and explicitly tap **Save Recipe** to persist. There is no database migration, hidden write, automatic meal plan or grocery-list update; social photos are **not copied**. The existing TheMealDB photo importer remains limited to official TheMealDB media.
6. Link-only requests attach the source URL and leave ingredients and directions empty with a clear explanation. A recipe explained **only in video speech** requires the user to supply caption/recording manually; it is not transcribed by this version.

## Safety, regression and known limitations

- Fetch destination is constant Meta API host, never user-supplied host. The URL parser uses a finite Instagram/Facebook allowlist and post path patterns, rejects non-HTTPS, credentials, ports, hash fragments, encoded redirect-like routes and internal hostnames. Unknown shorteners such as `fb.watch` are intentionally unsupported in v1.
- On-demand only; no crawling creators' accounts, platform-login automation, scraping or bulk search, paid AI, subscription, TikTok/YouTube handling or private posts.
- No Meta API token. Tokenless public oEmbed availability was documented by Meta effective June 15, 2026, but **oEmbed is an embed interface, not a recipe extraction API**. An oEmbed error or inaccessible post does not turn a fake recipe into a real one.
- The input caption is an optional copy provided by the calendar user, kept in the draft and not transmitted to Meta. The internal JSON reply is short, no-store and protected by normal calendar authentication. No caption is logged.
- `node --test scripts/test-arney-social-recipe-import.mjs` tests canonicalization, malicious source rejection, tracking cleanup, one fixed outbound request, unverified fallback, no hallucination, and the integration into the existing explicit recipe save form.
- Requires GitHub CI **and real iPhone TEST acceptance** before further LIVE work. Do not merge TEST or change LIVE without explicit user direction.

## Later phases, not implemented

- First-party recipe-website link extraction using JSON-LD/schema.org, only after careful SSRF and redirect boundaries.
- Optional **user-provided** video/screenshot extraction through existing authenticated local Whisper/vision with explicit review, not covert downloading.
- Discovery across creators' public accounts only through permitted APIs/search sources with clearly stated coverage.
