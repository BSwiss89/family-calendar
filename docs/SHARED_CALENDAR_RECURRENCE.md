# Common calendar recurrence logic

Two pure functions in `Server/index.mjs` were independently confirmed **byte-for-byte identical in LIVE commit `6377963372c30e8c4c4e33af6bf617d87961e989` and TEST commit `8ce86e02e66b397dbe286e9b6cf8ba073adb2ddf`**: `getRepeatRule` and `doesEventStartOnDate`.

This TEST-only refactor extracts their existing bodies into `Server/calendar-recurrence.mjs` and imports them into `Server/index.mjs`, reducing the main backend by approximately 4,000 characters. `getRepeatRule` calls the already-extracted, unchanged `isValidDate` validator from `Server/calendar-input-validation.mjs`. No calendar semantics are intentionally changed, including the existing date-format rule and how monthly/yearly occurrences are matched.

A targeted regression suite checks disabled recurrence, limits, day/week/month/year intervals, exception dates, and count/date terminations, and confirms no function copies remain in the TEST backend.

No auth, database schemas, SQL, endpoints, push, membership, storage, or deployment scripts are modified. LIVE is not changed, and a future adoption of the same shared module by LIVE needs its own separate, explicitly approved and guarded release.
