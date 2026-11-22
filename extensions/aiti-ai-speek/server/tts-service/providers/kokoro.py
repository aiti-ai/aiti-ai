"""Kokoro-82M local provider (optional).

Uses the `kokoro-onnx` Python package, kept out of the Hojo venv by default. The
service can load it when that package and the ONNX model/voices files exist:

  <model_dir>/kokoro-v1.0.onnx
  <model_dir>/voices-v1.0.bin

Install (in the Hojo venv or a dedicated worker venv):
  pip install kokoro-onnx
Model files are downloaded separately; this project deliberately does not
silently pull a 300MB+ artifact from a third-party endpoint at request time.
"""
from __future__ import annotations

import os
from typing import Any

import numpy as np

from .base import BadRequest, NotReady, TTSEngine, UnknownVoice, Voice


class KokoroEngine(TTSEngine):
    id = "kokoro"
    sample_rate = 24000
    supports_clone = False

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.model_label = "Kokoro-82M"
        self._model = None
        self._voices: list[Voice] = []
        self._lock = None

    def _find(self, *names: str) -> str | None:
        for name in names:
            p = os.path.join(self.model_dir, name)
            if os.path.isfile(p):
                return p
        return None

    def load(self) -> None:
        if self.loaded:
            return
        import threading
        try:
            from kokoro_onnx import Kokoro
        except Exception as e:
            raise NotReady(f"kokoro-onnx is not installed in this venv ({e})")
        model = self._find("kokoro-v1.0.onnx", "kokoro.onnx")
        voices = self._find("voices-v1.0.bin", "voices.bin")
        if not model or not voices:
            raise NotReady(f"Kokoro model files missing in {self.model_dir} (kokoro-v1.0.onnx + voices-v1.0.bin)")
        self._model = Kokoro(model, voices)
        self._lock = threading.Lock()
        self._voices = self._build_voices()
        self.loaded = True

    def _build_voices(self) -> list[Voice]:
        out: list[Voice] = []
        try:
            import numpy as np
            z = np.load(os.path.join(self.model_dir, "voices-v1.0.bin"))
            ids = list(z.keys()) if hasattr(z, "keys") else []
        except Exception:
            ids = []
        for vid in ids:
            out.append(Voice(id=str(vid), label=f"Kokoro · {vid}", provider=self.id,
                             sample="Hello, this is Kokoro.", language="en"))
        return out

    def voices(self) -> list[Voice]:
        return list(self._voices) if self.loaded else []

    def synthesize(self, text: str, voice: str | None, *, language: str = "auto") -> np.ndarray:
        if not self.loaded or self._model is None:
            raise NotReady("Kokoro is loading")
        text = (text or "").strip()
        if not text:
            raise BadRequest("empty input text")
        vid = (voice or "af_heart").strip()
        if self._voices and vid not in {v.id for v in self._voices}:
            raise UnknownVoice(f"Kokoro voice not found: {vid}")
        with self._lock:
            samples, _sr = self._model.create(text, voice=vid, speed=1.0, lang="en-us")
        return np.asarray(samples, dtype=np.float32).reshape(-1)
