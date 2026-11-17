# Arney TEST social-video recipe analysis

## Goal
Paste one public Instagram or Facebook Reel URL. Arney first retrieves the creator's public caption independently of the media download, then ALWAYS attempts the video's full-length speech transcription and sampled on-screen reading using local Whisper/Qwen; it does this even if the caption seems complete. Local Ministral identifies additional video-only ingredients/steps and flags explicit disagreements for review. The editor remains an unsaved draft; a blocked download must not discard an accessible caption. No recording or pasted caption should be required for accessible public Reels.

## Safety and data handling
- Only normalized Instagram/Facebook URLs already accepted by the existing importer. No arbitrary URL fetch, Meta login, cookie use, private-account access, or creator crawling.
- The preview endpoint exists only on isolated authenticated TEST (port 13002 with the expected TEST folder), checks family sessions, limits four attempts per ten minutes per session, and permits only one analysis at a time.
- Public link extraction uses the optional yt-dlp executable installed separately on the TEST laptop, with limits of 10 minutes, a 72-MB temporary linked download and a 120-second download timeout; no cookies or playlists. Previously, the 110-second filter silently skipped long public Reels with exit code 0. A duration-less Instagram Reel was later skipped by the ten-minute filter too, since yt-dlp excludes missing metadata by default. The new optional comparison `duration <=? 600` allows unknown initial duration while enforcing the real ten-minute limit with FFprobe after download. Caption metadata is fetched separately using yt-dlp `--skip-download --write-info-json` so the recipe survives failed media download. No automatic cookies, creator crawling or private-post access.
- Optional MP4/MOV/WebM recordings remain capped at 36 MB; they are not required for an accessible public Reel. Linked and uploaded videos can be up to 10 minutes. FFmpeg extracts 18-second mono WAV clips across the duration to use the existing authenticated localhost STT bridge. Scaled video frames are sampled across the duration for local vision AI. Local Ministral compares the caption with video evidence, adds only non-redundant video-only ingredients/steps and flags discrepancies without overwriting caption values. Creator-stated servings and macros are preserved in the normal recipe editor; video is attempted even for complete captions.
- Video, audio, temporary frames, captions and transcripts are discarded from the OS temporary directory at request completion. Nothing is written to permanent calendar uploads or SQLite before explicit Save Recipe.
- Models must leave unsupported ingredients, amounts and steps missing; AI transcription/extraction is not guaranteed to be accurate. User must review the exact amounts and directions before saving.
- The TEST preview optionally retrieves the public Reel cover separately using yt-dlp without cookies and without altering media transcription; if no cover is accessible, it may generate a frame from the already downloaded video. Sharp resizes/re-encodes only the local image into a small WebP; original thumbnail URLs are never fetched by the browser or passed as arbitrary image URLs to the server. The preview image is temporary; it becomes a saved recipe photo only after the user's existing Save Recipe action. A user-selected photo takes priority. The feature does not change shopping lists or calendar events, change households, install software, or invoke paid AI.

## Video backup verification and thumbnail (TEST proposal)
- The recipe-import modal shows a compact **Video backup check**. It reports whether the video actually opened, how many audio chunks produced recognizable speech, the number of frames sampled, whether the local vision model responded, whether the local AI comparison completed, and how many additional video-only details were suggested. It does **not** show or permanently save speech transcripts or frame text in the calendar.
- Status distinguishes a valid video opening from a successful speech/vision extraction and from completion of recipe comparison. A recipe built entirely from a caption is labeled caption-only; neither a nonempty title nor a video download proves the video was understood. Sampling four frames and transcribing audio are best-effort, **not proof that every detail in the video was recovered**.
- An original public cover is preferred. If absent, an actual video frame is a best-effort fallback. Local WebP conversion caps the returned preview at 70 KB; no image is saved to permanent calendar uploads until the user explicitly saves the recipe. If thumbnail fetching fails, the rest of the recipe continues normally.
- Confirm TEST reports actual recognition/vision outcomes on the iPhone, with no transcript display. Test no-caption, video-blocked and empty-vision scenarios; ensure the original recipe importer remains available and LIVE is unchanged.

## Creator-pinned comment support (TEST branch only; awaiting CI and review)
- When importing a public Reel, the preview first checks any already retrieved public yt-dlp metadata for recipe comments. If none is available, it makes **one bounded, metadata-only, unauthenticated** `yt-dlp --skip-download --write-comments --write-info-json` attempt (18-second timeout). Instagram/Facebook extractors may not expose comments at all, and Meta's official Instagram API does not grant general read access to arbitrary creators' comments.
- Only comments with **verified uploader identity metadata** (`author_is_uploader` or matching creator account ID) are used automatically. If the public metadata explicitly says `pinned=true` or `is_pinned=true`, prefer the creator's pinned recipe comment; otherwise label it merely "creator comment" without claiming it is pinned. **Never use a stranger's pinned comment, high-liked comment, or unverified display name as trusted creator instructions.** This is best-effort, not guaranteed capture of all comments.
- An optional **Paste a creator's recipe comment** field in Advanced options lets the person copy the pinned recipe when Instagram/Facebook blocks access. This comment is used as unverified user-provided text and labeled as such; no platform authentication, cookies, paid services, browser extension, scraping of private profiles, or offsite comment crawling is required.
- Preserve the creator caption as the baseline and add distinct, evidenced comment ingredients and instructions. If the caption is incomplete, extracted comment recipe fields can fill the gaps. Local AI receives caption/comment/video as **untrusted cooking content**, not external instructions, and does not invent quantities. Only status of comment verification is displayed; raw comment text is not saved separately. Recipe remains an editable, unsaved preview until explicit Save Recipe.
- TEST acceptance: try an Instagram Reel whose creator put the recipe in a pinned comment, inspect the **Recipe comment check** status, ingredients and directions, and verify no false "pinned" claim on blocked or unverified comments. If comments are unavailable, paste the exact creator comment in Advanced options, re-analyze, and verify fields. Report video STT/vision outcomes independently. Keep LIVE untouched.

## Required operator checks
1. Obtain separate owner approval for merging to test-release. Verify exact-head GitHub CI and browser regressions. Do not merge main or LIVE.
2. Verify TEST laptop has yt-dlp, ffmpeg, ffprobe, configured existing local STT service and Ollama models before expecting video transcription. Their installation is NOT part of this source PR.
3. Run the existing guarded TEST deployment and confirm target SHA, health, authentication, anonymous denial, tests and rollback backup.
4. On an iPhone, test `https://www.instagram.com/reel/DVJjoG6Av3o/` (Jalal: Creamy Peri Peri Chicken Pasta) with no attachment, no pasted caption and blank duration metadata. Confirm name/servings/macros/ingredients/instructions appear from the creator description and local video is *also* attempted; inspect the returned video status separately. Also test a Facebook Reel and a video with a genuine duration over ten minutes. A blocked video must still populate the draft from any accessible caption.
5. Confirm video and caption extraction never auto-saves a recipe. Verify other features and LIVE unchanged.

## Limitations
Meta oEmbed returns embeddable HTML, not a reliable public video download or spoken recipe transcript. Public link extraction is best effort and may stop working when platforms change. Private, restricted and protected content should not be bypassed.

## Full-timeline on-screen reading pilot (PR #224, TEST only)

- FFmpeg samples across the **entire video timeline**, instead of eight widely spaced frames: 2 FPS for videos up to 2 minutes, 1 FPS up to 5 minutes, 0.5 FPS up to 10 minutes, maximum 300 timeline frames. It does NOT inspect all source frames.
- Locally installed Tesseract reads on-screen text from preprocessed 1280px frames. Repeated text screens are deduplicated, changed oven temperatures/times retained as separate events, and a bounded 115-second OCR budget and 90 distinct-screen retention cap are reported honestly.
- Qwen3-VL checks up to 16 frames selected from text changes and timeline overview. If Tesseract is missing, Qwen still runs but the preview explicitly says OCR is unavailable.
- Creator caption, creator comment, Whisper transcript, OCR text and selected Qwen visual cooking actions feed the recipe organizer. Explicit OCR cooking temperatures and durations are retained directly in editable Instructions even if the organizer summarizes them generically.
- No paid services, Meta login, cookies, persistent video files, automatic Save, household permission changes, or changes to LIVE. Media/audio/OCR work happens only in the existing authenticated TEST preview temporary directory.

### One-time optional local OCR requirement

The TEST source PR never silently installs software on the laptop. Windows Tesseract is commonly available as the UB Mannheim build (winget package UB-Mannheim.TesseractOCR, verify with winget search Tesseract before installing). By default the worker looks at C:\Program Files\Tesseract-OCR\tesseract.exe, then PATH. English OCR language data is required. The user must explicitly approve and perform any installation; no cloud account is required.

Read-only one-line test:

    $p='C:\Program Files\Tesseract-OCR\tesseract.exe'; $c=Get-Command tesseract -ErrorAction SilentlyContinue; $v=if(Test-Path $p){$p}elseif($c){$c.Source}else{''}; if($v){Write-Host 'TESSERACT_PRESENT=True'; & $v --version 2>&1 | Select-Object -First 1; Write-Host "TESSERACT_ENGLISH=$([bool]((& $v --list-langs 2>$null) -match '^eng$'))"}else{Write-Host 'TESSERACT_PRESENT=False'}

### TEST acceptance

1. Exact-head GitHub Windows CI and browser tests PASS, then owner approval, post-merge push CI PASS, guarded Windows TEST deployment with auth and backup. LIVE unchanged.
2. Confirm Tesseract is available to the TEST server task account or report OCR unavailable and maintain a Qwen-only fallback.
3. Retest the same pasta Reel on iPhone: 200C/400F for 22-25 minutes; 195C/385F for 45-50 minutes. Check ingredient quantities and ordered cooking steps, accounting for OCR mistakes.
4. Verify timeline frames, OCR reads, distinct text screens, selected vision frames and STT sections independently. The exact details must appear in editable Instructions; no raw frame/transcript is displayed in status.
5. Test missing OCR, no speech, >2-minute video, >10-minute rejection, blocked public link, no duplicate ingredient allocations and no automatic saves.
