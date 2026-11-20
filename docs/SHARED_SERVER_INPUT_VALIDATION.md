# Shared server input validation refactor

The five pure date, event-title, person-name, profile-color, and optional-text validation functions in `Server/index.mjs` were verified to be **identical at the exact LIVE and TEST installed commits** before extracting them on TEST. This change preserves their existing behavior byte-for-byte, moving declarations to `Server/calendar-input-validation.mjs` and importing them in TEST's existing server.

This isolated refactor introduces no new HTTP routes, schema changes, authentication rules, database operations, feature switches, background processes, or deployments. CI runs direct behavior tests and checks that the TEST API imports the common functions without duplicate definitions.

**Future LIVE alignment:** LIVE still has these exact function bodies inline. Adopting this same helper for LIVE requires a separate reviewed and explicitly authorized LIVE release with production validation; this TEST PR does not change LIVE. Do not combine this with the private-household gateway or other TEST-only features.
