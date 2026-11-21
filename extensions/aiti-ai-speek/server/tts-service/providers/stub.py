"""Stub engine: deterministic sine/silence output for pipeline debugging (no model needed).

Used by `start-tts.sh start --provider stub` when validating the extension chain (cache,
playback, voice switching) without downloading a model.
"""
from __future__ import annotations

import numpy as np

from .base import TTSEngine, UnknownVoice, Voice

_TONES = {
    "stub-a": (440.0, "A4 tone"),
    "stub-b": (660.0, "E5 tone"),
    "stub-silence": (0.0, "silence"),
}


class StubEngine(TTSEngine):
    id = "stub"
    sample_rate = 24000
    supports_clone = False

    def load(self) -> None:
        self.loaded = True
        self.model_label = "stub"

    def voices(self) -> list[Voice]:
        return [
            Voice(id=vid, label=f"{label} · stub", sample="我是测试音色。",
                  builtin=True, provider=self.id, language="")
            for vid, (_, label) in _TONES.items()
        ]

    def synthesize(self, text: str, voice: str | None, *, language: str = "auto") -> np.ndarray:
        vid = (voice or "stub-a").strip()
        if vid not in _TONES:
            raise UnknownVoice(f"unknown stub voice: {vid}")
        freq, _label = _TONES[vid]
        seconds = max(0.6, min(6.0, len(text or "") * 0.08))
        n = int(self.sample_rate * seconds)
        if freq <= 0:
            return np.zeros(n, dtype=np.float32)
        t = np.arange(n, dtype=np.float32) / self.sample_rate
        # Short fade-in/out so players do not click.
        env = np.ones(n, dtype=np.float32)
        ramp = min(240, n // 4)
        if ramp > 0:
            env[:ramp] = np.linspace(0.0, 1.0, ramp, dtype=np.float32)
            env[-ramp:] = np.linspace(1.0, 0.0, ramp, dtype=np.float32)
        return (0.2 * np.sin(2 * np.pi * freq * t) * env).astype(np.float32)
