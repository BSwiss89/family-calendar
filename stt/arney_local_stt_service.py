"""Private loopback-only speech-to-text service for Arney TEST.

The calendar backend sends a short authenticated raw audio body. The service
decodes it in memory, enforces duration limits, transcribes locally, and never
logs or retains audio or transcript content.
"""
from __future__ import annotations

import hmac
import io
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio


HOST = "127.0.0.1"
PORT = int(os.environ.get("FAMILY_CALENDAR_LOCAL_STT_PORT", "13981"))
TOKEN = os.environ.get("FAMILY_CALENDAR_LOCAL_STT_TOKEN", "")
MODEL_NAME = os.environ.get("FAMILY_CALENDAR_LOCAL_STT_MODEL", "small.en")
MAX_BYTES = 2 * 1024 * 1024
MAX_SECONDS = 20
SAMPLE_RATE = 16_000
CONTENT_TYPES = {
    "audio/mp4", "audio/webm", "audio/ogg", "audio/wav", "audio/x-wav"
}

if not (1024 <= PORT <= 65535) or PORT in {3001, 8443, 11434, 13001, 13002, 13003}:
    raise RuntimeError("Unsafe local STT port")
if len(TOKEN) < 32:
    raise RuntimeError("FAMILY_CALENDAR_LOCAL_STT_TOKEN must contain at least 32 characters")

# CPU INT8 keeps Ollama's GPU memory available. The model remains warm after
# startup, avoiding a load penalty for every blue-plus recording.
MODEL = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")


class Handler(BaseHTTPRequestHandler):
    server_version = "ArneyLocalSTT/1"
    sys_version = ""

    def log_message(self, _format: str, *_args: object) -> None:
        # Do not log paths, headers, audio, or transcript content.
        return

    def send_json(self, status: int, value: dict[str, object]) -> None:
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        expected = "Bearer " + TOKEN
        return hmac.compare_digest(header, expected)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health" or not self.authorized():
            self.send_json(404, {"error": "Not found"})
            return
        self.send_json(200, {"status": "ok", "modelReady": True})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/transcribe" or not self.authorized():
            self.send_json(404, {"error": "Not found"})
            return
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type not in CONTENT_TYPES:
            self.send_json(415, {"error": "Unsupported audio format"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            client_duration = int(self.headers.get("X-Arney-Duration-Ms", "0"))
        except ValueError:
            self.send_json(400, {"error": "Invalid recording metadata"})
            return
        if length < 32 or length > MAX_BYTES or not (200 <= client_duration <= MAX_SECONDS * 1000):
            self.send_json(413, {"error": "Recording limits exceeded"})
            return

        audio_bytes = self.rfile.read(length)
        if len(audio_bytes) != length:
            self.send_json(400, {"error": "Incomplete recording"})
            return

        started = time.perf_counter()
        try:
            audio = decode_audio(io.BytesIO(audio_bytes), sampling_rate=SAMPLE_RATE)
            if len(audio) < SAMPLE_RATE // 5 or len(audio) > SAMPLE_RATE * MAX_SECONDS:
                self.send_json(413, {"error": "Recording duration exceeded"})
                return
            segments, _info = MODEL.transcribe(
                audio,
                language="en",
                beam_size=1,
                condition_on_previous_text=False,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300},
            )
            transcript = " ".join(segment.text.strip() for segment in segments).strip()
            if not transcript:
                self.send_json(422, {"error": "No speech recognized"})
                return
            self.send_json(200, {
                "transcript": transcript[:2000],
                "elapsedMs": round((time.perf_counter() - started) * 1000),
            })
        except Exception:
            self.send_json(503, {"error": "Transcription failed"})
        finally:
            # Drop the only audio references as soon as the request completes.
            audio_bytes = b""


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    server.serve_forever(poll_interval=0.25)

