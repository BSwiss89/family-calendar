# Exact LIVE/TEST source-content inventory

Purpose: make future calendar code reconciliations measurable without confusing diverged Git history with actual file differences.

Run from a Git checkout containing **both exact, reviewed commit objects** (fetch them into Git first; this command itself never fetches):

    node scripts/report-source-content-alignment.mjs LIVE_40_CHARACTER_SHA TEST_40_CHARACTER_SHA

For a full path-by-path, machine-readable inventory:

    node scripts/report-source-content-alignment.mjs LIVE_40_CHARACTER_SHA TEST_40_CHARACTER_SHA --json

This compares Git **blob IDs** for every file in \`src/\` and \`Server/\`. Files are classified as:
- \`identical\`: exactly the same bytes at both commits.
- \`different\`: present at both commits but content differs.
- \`live_only\`: present in LIVE alone.
- \`test_only\`: present in TEST alone.

No files, databases, runtime tasks, release approvals, branches or deployed sites are modified. Only exact 40-character commit SHAs are accepted. Missing commits or invalid Git output fail closed. It does not compare file history, runtime behavior, settings, credentials, user data, or the deployment scripts. It deliberately excludes \`scripts/\`, \`.github/\` and documentation. Every divergent source path still requires human classification as shared, experimental, or environment-specific before promotion.

**Never** use this report as authorization to merge TEST into LIVE. TEST-only multi-household/Arney experiments, environment-specific notification endpoints, auth/cookies, storage, and supervisor/runtime paths require independent scope and safety review. Even matching bytes do not prove all deployed behavior matches.

Unit tests:

    node --test scripts/test-source-content-alignment.mjs
