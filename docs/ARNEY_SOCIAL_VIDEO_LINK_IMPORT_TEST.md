# Arney TEST social-video recipe analysis

## Goal
Paste one public Instagram or Facebook Reel URL. Arney should attempt to retrieve accessible media, extract speech with existing local Whisper, inspect a few video frames using local Qwen vision, and organize a grounded editable draft using local Ministral. Copying the caption is no longer the default workflow. A blocked link offers a screen recording, not a fabricated recipe.

## Safety and data handling
- Only normalized Instagram/Facebook URLs already accepted by the existing importer. No arbitrary URL fetch, Meta login, cookie use, private-account access, or creator crawling.
- The preview endpoint exists only on isolated authenticated TEST (port 13002 with the expected TEST folder), checks family sessions, limits four attempts per ten minutes per session, and permits only one analysis at a time.
- Public link extraction uses the optional yt-dlp executable installed separately on the TEST laptop, with strict size/duration/time limits, no cookies, no playlist. When a public video exposes a creator description, Arney imports that text automatically without an extra caption paste. A link alone may not provide a usable video due to platform restrictions or an absent downloader.
- Fallback is an explicitly chosen MP4/MOV/WebM recording of at most 36 MB and 110 seconds. FFmpeg extracts 18-second mono WAV clips, which use the existing authenticated localhost STT bridge. A few scaled video frames go only to local vision AI. Local Ministral organizes the evidence into a review-only recipe.
- Video, audio, temporary frames, captions and transcripts are discarded from the OS temporary directory at request completion. Nothing is written to permanent calendar uploads or SQLite before explicit Save Recipe.
- Models must leave unsupported ingredients, amounts and steps missing; AI transcription/extraction is not guaranteed to be accurate. User must review the exact amounts and directions before saving.
- The feature does not copy social-media photos, alter the shopping list or calendar, change households, install software, or invoke paid AI.

## Required operator checks
1. Obtain separate owner approval for merging to test-release. Verify exact-head GitHub CI and browser regressions. Do not merge main or LIVE.
2. Verify TEST laptop has yt-dlp, ffmpeg, ffprobe, configured existing local STT service and Ollama models before expecting video transcription. Their installation is NOT part of this source PR.
3. Run the existing guarded TEST deployment and confirm target SHA, health, authentication, anonymous denial, tests and rollback backup.
4. On an iPhone, use a public Instagram Reel and Facebook Reel, check link-based analysis when accessible, and check that blocked links prompt for screen recording rather than inventing data.
5. Confirm video and caption extraction never auto-saves a recipe. Verify other features and LIVE unchanged.

## Limitations
Meta oEmbed returns embeddable HTML, not a reliable public video download or spoken recipe transcript. Public link extraction is best effort and may stop working when platforms change. Private, restricted and protected content should not be bypassed.
