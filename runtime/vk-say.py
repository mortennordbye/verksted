#!/usr/bin/env python3
"""Text to speech for the assistant, one warm process.

Reads one JSON request per line on stdin and answers one JSON line on stdout:

    {"text": "...", "voice": "af_heart", "out": "/tmp/x.wav"}
    {"ok": true, "seconds": 3.4}

The audio goes to the file named in the request rather than down the pipe: WAV
bytes and JSON lines on one stream is a framing problem nobody needs, and the
backend has a temp file to hand either way.

Why a process that stays up: loading the model costs about a second, and a
reply is read out a sentence at a time so the load would otherwise be paid on
every sentence. The first line printed is the ready line, which carries the
voices this model actually has — the backend takes its allowlist from there
rather than keeping its own copy to drift.
"""

import json
import os
import sys
import time
import wave

MODEL = os.environ.get("KOKORO_MODEL", "/usr/local/share/kokoro/kokoro.onnx")
VOICES = os.environ.get("KOKORO_VOICES", "/usr/local/share/kokoro/voices.bin")
# What the model produces; the WAV header has to say the same thing.
SAMPLE_RATE = 24000


def write_wav(path: str, samples, rate: int = SAMPLE_RATE) -> None:
    """16-bit PCM, via the standard library rather than a second audio package."""
    import numpy as np

    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767).astype("<i2")
    with wave.open(path, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(pcm.tobytes())


def main() -> int:
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(MODEL, VOICES)
    voices = sorted(kokoro.get_voices())
    print(json.dumps({"ready": True, "voices": voices, "rate": SAMPLE_RATE}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            started = time.time()
            audio, rate = kokoro.create(
                req["text"],
                voice=req.get("voice") or "af_heart",
                speed=float(req.get("speed", 1.0)),
                lang=req.get("lang", "en-us"),
            )
            write_wav(req["out"], audio, rate)
            answer = {
                "ok": True,
                "seconds": round(len(audio) / rate, 2),
                "took": round(time.time() - started, 2),
            }
        except Exception as err:  # noqa: BLE001 - the answer is the report
            # One bad request must not take the worker down: the next sentence
            # of the same reply is still worth speaking.
            answer = {"ok": False, "error": f"{type(err).__name__}: {err}"[:300]}
        print(json.dumps(answer), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
