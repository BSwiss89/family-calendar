# Arney — voice-first implementation plan

Status: Arney voice controls are implemented in draft PR #43 and must pass review and device testing before production deployment. This PR never modifies production data by itself.

## Getting started after approved deployment
1. Open **Arney settings** (gear). Explicitly enable **Allow browser speech recognition** only if comfortable with browser-provider cloud transcription. This does not send audio to an OpenAI API or start listening automatically.
2. On mobile, **tap** the blue + for the existing Quick Add sheet. **Hold** it for voice; a listening indicator appears, and **release** to finish speech recognition and submit a single command. Canceling the touch cancels the microphone session.
3. On desktop/tablet, also enable wake words in Settings and click **Start Arney wake words** to begin foreground listening. Say "Hey Arney, [request]", "Hey Calendar, [request]", or just the wake phrase and then speak the request during the next listening round. After Arney finishes processing the request and speaking its reply, the foreground listener resumes automatically. Click Stop to disable; it must stay off until explicitly restarted. The listener also stops when the page becomes hidden or permission is disabled.
4. After a spoken command, review the transcript and any mutation preview before confirming. Destructive existing cancellation/reschedule flows always ask for confirmation.
5. If the browser does not support recognition or access is disallowed, Arney offers typed input. Otherwise text fallback appears after three failed voice attempts; a recognized command may also be edited.

## Currently supported common requests
- "What's on my calendar today?" / "...tomorrow?" (including occurrences of repeating events).
- "What's on my Groceries list?" where **Groceries** is an existing list name.
- "Add bananas to my Groceries list" (existing exact list name).
- "Schedule dentist tomorrow at 2 PM" or "Add meeting on 2026-10-20 at 14:00" (simple explicit dates and time); unassigned person by default.
- Existing local-AI cancellation and rescheduling preview/confirm flows.
- Voice responses: **Always**, **Speak when needed**, **Silent**.

## Future dedicated wall-display mode (not part of PR #43)
- When configured by the household in Settings, enable persistent on-device wake-word monitoring on the wall display after startup and after replies, with no microphone Start/Stop button on the home screen.
- Listening must be disabled only through the wall display Settings, with a clear microphone status indicator. Prefer a dedicated local wake-word detector; the current browser-based foreground listener cannot guarantee true continuous or background operation.
- Keep iPhone push-to-talk unchanged.

## Constraints and browser limitations
- Browser speech recognition is **not a local wake-word detector** and may send spoken audio to the browser vendor's speech service. Permission is opt-in; cloud/provider behavior is outside app control.
- This implementation has no true background/hardware wake-word support. iOS/iPadOS/browser compatibility and microphone access on remote HTTP addresses vary; active foreground and a supported secure context are needed.
- Unclear dates/times, unknown list names, more complex calendar/list commands, and other unsupported intents do not create or change data. Expanding those natural-language interpretations requires subsequent AI/backend work.
- On supported simple non-destructive commands, Settings may disable per-change confirmation. Leave confirmation enabled for better safety.
- Exercise commands against the test calendar before enabling speech on the live calendar.


## User experience
- Mobile: press and hold the microphone control to capture speech; release to end capture and submit. Cancel on pointer cancellation; do not accidentally submit. Provide visible listening/processing/error states.
- Desktop and tablet: opt-in wake word detection for "hey arney", "arney", "computer", "calendar", and "hey calendar". Make the phrase list extensible. Allow wake-word detection only while microphone permission and the active client support it; clearly indicate when unavailable or disabled.
- Do not show a text input by default. After three consecutive genuine speech recognition/understanding failures, offer text as an optional fallback. Reset the counter after a successful understanding. Clarification questions do not count as failures.
- Settings: voice response mode (always, when needed, silent), wake-word toggle, and confirmation-before-changes toggle. Persist settings across restarts, with a safe default of wake words disabled until explicitly enabled and confirmation enabled.
- In all modes provide visual state and results, even if speech output is enabled.

## Safety and architecture
- Prefer local processing and no paid cloud calls by default.
- Never silently upload ambient audio to cloud providers. Explain and require explicit opt-in before enabling cloud speech or model fallback.
- Browser microphone and background wake-word support vary by device, especially iOS/iPadOS; do not promise always-on operation when suspended, backgrounded or screen locked.
- Use a local wake-word detector rather than sending continuous audio to the language model.
- Separate speech recognition, command interpretation, read-only calendar/list queries, mutation preview, confirmation, and persistence.
- Confirm before destructive actions regardless of a general confirmation toggle. Never execute uncertain or ambiguous changes. Prevent duplicate submission and retry-induced duplicate events.
- Do not put transcripts, raw audio, or private event data into diagnostic logs by default.
- Keep preview/test and live SQLite data separate. Do not use real family events in automated tests.

## Suggested delivery slices
1. Inspect existing React Settings, navigation, server AI endpoints, and calendar/list mutation APIs.
2. Implement persisted Arney preferences and a settings UI; verify on mobile and desktop.
3. Implement mobile hold-to-talk with permission handling and browser compatibility tests.
4. Implement desktop/tablet wake-word detection with capability checks and a clear disable control.
5. Implement speech recognition and optional spoken replies with the three response modes.
6. Connect read-only calendar/list intent handling.
7. Add preview-and-confirm write actions and failure fallback.
8. Add regression tests and a test-calendar preview before any production deployment.

## Acceptance checks
- Holding begins capture only with permission; releasing stops; cancelling does not submit.
- Wake words activate only on supported, enabled clients.
- No text box is shown before three consecutive actual recognition failures.
- Voice response mode survives reload.
- Mutations require the correct target and explicit approval as configured; destructive actions always require approval.
- No cloud cost or transfer occurs without opt-in.
- Test deployments cannot overwrite live calendar data.
