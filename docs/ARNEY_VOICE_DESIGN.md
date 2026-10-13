# Arney — voice-first implementation plan

Status: design baseline; not yet implemented. This document does not enable microphone access or modify production data.

## User experience
- Mobile: press and hold the microphone control to capture speech; release to end capture and submit. Cancel on pointer cancellation; do not accidentally submit. Provide visible listening/processing/error states.
- Desktop and tablet: opt-in wake word detection for "hey arney", "arney", and "computer". Make the phrase list extensible. Allow wake-word detection only while microphone permission and the active client support it; clearly indicate when unavailable or disabled.
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
