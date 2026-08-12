"""Local speech service for the spoken answers.

Both voice engines are Python, and both need their model resident in memory: Piper spends
about half a second loading a voice, the MLX build of Qwen3-TTS about four. Spawning either
per sentence would put that in front of every answer, so they live in this small loopback
service instead, the same shape the local Whisper service already has.

Audio leaves as raw little-endian float32 mono, chunk by chunk while it is being generated.
The interface plays each chunk as it arrives, which is what keeps the wait before JARVIS
starts speaking at roughly half a second instead of the full synthesis time.

The service binds to 127.0.0.1 only. Nothing it receives or produces leaves this Mac.
"""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import chain

import numpy as np

HOST = "127.0.0.1"
DEFAULT_PORT = 8179
MAX_TEXT_LENGTH = 4000
# Long enough that Qwen keeps a natural sentence melody, short enough to start playback early.
STREAMING_INTERVAL_SECONDS = 1.0
# Blocks smaller than this are not worth a network write of their own.
MINIMUM_BLOCK_SECONDS = 0.2

VOICES = {
    "thorsten": {
        "name": "Thorsten",
        "lang": "de-DE",
        "engine": "piper",
        "model": "de_DE-thorsten-high.onnx",
    },
    "serena": {
        "name": "Serena",
        "lang": "de-DE",
        "engine": "qwen",
        "speaker": "serena",
    },
    "vivian": {
        "name": "Vivian",
        "lang": "de-DE",
        "engine": "qwen",
        "speaker": "vivian",
    },
}

QWEN_REPOSITORY = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit"

# Loading is not thread safe and two answers must never interleave into one audio stream.
_lock = threading.Lock()
_loaded: dict[str, object] = {}


def voices_directory() -> str:
    return os.environ.get("VOICE_MODELS_DIR") or os.path.join(
        os.path.expanduser("~"), "Library/Application Support/com.sissighn.jarvis/voice/voices"
    )


def piper_voice(model: str):
    """Piper keeps one voice per file, so each is cached under its own file name."""
    if model not in _loaded:
        from piper import PiperVoice

        _loaded[model] = PiperVoice.load(os.path.join(voices_directory(), model))
    return _loaded[model]


def qwen_model():
    if "qwen" not in _loaded:
        from mlx_audio.tts.utils import load_model

        _loaded["qwen"] = load_model(os.environ.get("QWEN_TTS_REPOSITORY") or QWEN_REPOSITORY)
    return _loaded["qwen"]


def clamp_rate(value) -> float:
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return 1.0
    return max(0.5, min(1.8, rate))


def synthesize(voice: dict, text: str, rate: float):
    """Yields `(sample_rate, float32 samples)` as generation progresses."""
    if voice["engine"] == "piper":
        from piper import SynthesisConfig

        # Piper measures phoneme duration, so a faster voice is a shorter phoneme.
        config = SynthesisConfig(length_scale=max(0.55, min(2.0, 1 / rate)))
        for chunk in piper_voice(voice["model"]).synthesize(text, syn_config=config):
            yield chunk.sample_rate, np.asarray(chunk.audio_float_array, dtype=np.float32)
        return

    model = qwen_model()
    for result in model.generate(
        text=text,
        voice=voice["speaker"],
        lang_code="de",
        speed=rate,
        stream=True,
        streaming_interval=STREAMING_INTERVAL_SECONDS,
    ):
        samples = np.asarray(result.audio, dtype=np.float32).reshape(-1)
        yield getattr(result, "sample_rate", 24000), samples


def blocks(stream, sample_rate: int):
    """
    Groups the engine output into blocks of at least a fifth of a second.

    The first block leaves immediately, because it decides how long the interface waits before
    it starts speaking. After that, the engines emit far smaller pieces than a network write
    is worth, so they are collected until they carry enough audio to be worth a packet.
    """
    minimum = max(1, int(sample_rate * MINIMUM_BLOCK_SECONDS))
    pending: list[np.ndarray] = []
    held = 0
    for index, (_, samples) in enumerate(stream):
        if index == 0:
            yield samples.tobytes()
            continue
        pending.append(samples)
        held += len(samples)
        if held >= minimum:
            yield np.concatenate(pending).tobytes()
            pending, held = [], 0
    if pending:
        yield np.concatenate(pending).tobytes()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Nagle holds a small write back until the previous one is acknowledged. The engines emit
    # audio in many small pieces, and waiting for an acknowledgement per piece turned eight
    # seconds of speech into minutes of generation that was really just waiting on the socket.
    disable_nagle_algorithm = True

    def log_message(self, format, *args):
        """The default handler writes a line per request to stderr, which only fills the log."""

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.rstrip("/") in ("", "/voices"):
            self._json({
                "ok": True,
                "voices": [
                    {"id": key, "name": voice["name"], "lang": voice["lang"]}
                    for key, voice in VOICES.items()
                    if voice["engine"] != "piper"
                    or os.path.isfile(os.path.join(voices_directory(), voice["model"]))
                ],
            })
            return
        self._json({"ok": False, "error": "Unbekannter Pfad."}, 404)

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/speak":
            self._json({"ok": False, "error": "Unbekannter Pfad."}, 404)
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            request = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._json({"ok": False, "error": "Die Anfrage war nicht lesbar."}, 400)
            return

        text = str(request.get("text") or "").strip()[:MAX_TEXT_LENGTH]
        voice = VOICES.get(str(request.get("voice") or ""))
        if not text:
            self._json({"ok": False, "error": "Es gibt keinen Text zum Vorlesen."}, 400)
            return
        if voice is None:
            self._json({"ok": False, "error": "Diese Stimme gibt es nicht."}, 404)
            return

        rate = clamp_rate(request.get("rate"))
        with _lock:
            try:
                stream = synthesize(voice, text, rate)
                first_rate, first_samples = next(stream)
            except StopIteration:
                self._json({"ok": False, "error": "Die Stimme hat nichts erzeugt."}, 500)
                return
            except Exception as error:  # noqa: BLE001 - the caller needs the reason, not a trace
                print(f"synthesis failed: {error}", file=sys.stderr, flush=True)
                self._json({"ok": False, "error": f"Die Stimme ist fehlgeschlagen: {error}"}, 500)
                return

            # The length is unknown while generating, so the body is chunked.
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("X-Jarvis-Sample-Rate", str(first_rate))
            self.send_header("X-Jarvis-Voice", voice["name"])
            self.end_headers()

            try:
                # `chain`, not a list: unpacking the generator would synthesise the whole
                # answer before the first chunk goes out, which is the wait this avoids.
                for payload in blocks(chain([(first_rate, first_samples)], stream), first_rate):
                    # One write per block. Splitting the chunk header from its payload doubles
                    # the number of packets for no gain.
                    self.wfile.write(b"%X\r\n%s\r\n" % (len(payload), payload))
                self.wfile.write(b"0\r\n\r\n")
            except (BrokenPipeError, ConnectionResetError):
                # The user interrupted JARVIS mid-sentence; the rest of the audio is waste.
                pass


def main() -> None:
    port = int(os.environ.get("VOICE_PORT") or DEFAULT_PORT)
    server = ThreadingHTTPServer((HOST, port), Handler)
    print(f"Voice service listening on http://{HOST}:{port}", flush=True)
    if os.environ.get("VOICE_PRELOAD", "1") != "0":
        # Paying the model load now keeps it out of the first spoken answer.
        threading.Thread(target=preload, daemon=True).start()
    server.serve_forever()


def preload() -> None:
    for key, voice in VOICES.items():
        try:
            with _lock:
                if voice["engine"] == "piper":
                    if os.path.isfile(os.path.join(voices_directory(), voice["model"])):
                        piper_voice(voice["model"])
                else:
                    qwen_model()
        except Exception as error:  # noqa: BLE001 - a missing voice must not stop the service
            print(f"could not preload {key}: {error}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
