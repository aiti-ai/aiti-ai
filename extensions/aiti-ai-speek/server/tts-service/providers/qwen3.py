"""Qwen3-TTS engine (torch; CUDA ideal, CPU works slowly).

M3 provider — kept behind the same contract so the extension never changes. Requires the
`qwen-tts` package and torch inside the qwen3 venv; bootstrap installs only the light deps
and prints the torch command (installing torch automatically would overwrite device-specific
wheels — same lesson as the ASR side).

Voice cloning: `Qwen3TTSModel.generate_voice_clone(text=..., language=..., ref_audio=...,
ref_text=...)`. CustomVoice checkpoints additionally expose `generate_custom_voice`.
"""
from __future__ import annotations

import os
import threading
from typing import Any

import numpy as np

from .base import BadRequest, NotReady, TTSEngine, UnknownVoice, Voice

_REPOS = {
    "qwen3-0.6b": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    "qwen3-1.7b": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
}
_LANG = {"zh": "Chinese", "en": "English"}


class Qwen3Engine(TTSEngine):
    supports_clone = True
    sample_rate = 24000

    def __init__(self, *, provider_id: str = "qwen3-0.6b", repo: str | None = None, **kwargs) -> None:
        self.id = provider_id if provider_id in _REPOS else "qwen3-0.6b"
        super().__init__(**kwargs)
        self.repo = repo or _REPOS[self.id]
        self.model_label = self.repo
        self._model = None
        self._lock = threading.Lock()
        self._voices: list[Voice] = []
        self._sr = self.sample_rate

    def load(self) -> None:
        with self._lock:
            if self.loaded:
                return
            try:
                import torch  # noqa: F401  (torch presence is the real gate)
                from qwen_tts import Qwen3TTSModel
            except Exception as e:  # pragma: no cover - depends on the machine
                raise NotReady(
                    "qwen-tts/torch not installed in the qwen3 venv "
                    f"({e}). Install torch for your device, then `pip install -U qwen-tts`.")
            device = os.environ.get("AITI_TTS_DEVICE", "").strip()
            if not device:
                device = "cuda:0" if getattr(torch, "cuda", None) and torch.cuda.is_available() else "cpu"
            kwargs: dict[str, Any] = {"device_map": device}
            try:
                kwargs["dtype"] = torch.bfloat16 if device.startswith("cuda") else torch.float32
            except Exception:
                pass
            self._model = Qwen3TTSModel.from_pretrained(self.repo, **kwargs)
            self._voices = self._build_voices()
            self.loaded = True
            self.last_error = None

    def reload(self) -> None:
        if self.loaded:
            self._voices = self._build_voices()

    def _build_voices(self) -> list[Voice]:
        voices: list[Voice] = []
        # CustomVoice checkpoints expose fixed speakers; Base checkpoints only clone.
        speakers = getattr(self._model, "speakers", None) or getattr(self._model, "supported_speakers", None) or []
        for name in speakers or []:
            voices.append(Voice(id=str(name), label=f"{name} · 内置", sample="我是内置音色，很高兴为你朗读。",
                                builtin=True, provider=self.id))
        voices.extend(self.clone_voices(provider_ids=(self.id, self.repo.lower())))
        return voices

    def voices(self) -> list[Voice]:
        return list(self._voices) if self.loaded else []

    def synthesize(self, text: str, voice: str | None, *, language: str = "auto") -> np.ndarray:
        if not self.loaded:
            raise NotReady("model is still loading")
        text = self.normalize(text)
        if not text:
            raise BadRequest("empty input text")
        voice = (voice or "").strip()
        lang = _LANG.get(language, "")
        if not lang:
            lang = "Chinese" if any("\u4e00" <= ch <= "\u9fff" for ch in text) else "English"
        item = next((v for v in self._voices if v.id == voice), None)
        builtin = [v for v in self._voices if v.builtin]
        if not voice and builtin:
            voice = builtin[0].id
            item = builtin[0]
        with self._lock:
            if item is not None and item.builtin and hasattr(self._model, "generate_custom_voice"):
                wavs, sr = self._model.generate_custom_voice(text=text, language=lang, speaker=item.id)
            else:
                if item is None:
                    raise UnknownVoice(
                        f"voice '{voice}' is not configured for {self.id}; create one in the settings panel")
                ref_audio = str(item.meta.get("ref_audio") or "")
                if not ref_audio or not os.path.isfile(ref_audio):
                    raise UnknownVoice(f"reference audio missing for voice '{voice}'")
                ref_text = str(item.meta.get("ref_text") or "").strip()
                call: dict[str, Any] = {
                    "text": text,
                    "language": lang,
                    "ref_audio": ref_audio,
                    "ref_text": ref_text,
                }
                if item.meta.get("xvec_only"):
                    # Name differs between releases; only pass it when the API accepts it.
                    try:
                        wavs, sr = self._model.generate_voice_clone(**call, x_vector_only_mode=True)
                    except TypeError:
                        wavs, sr = self._model.generate_voice_clone(**call)
                else:
                    wavs, sr = self._model.generate_voice_clone(**call)
        self._sr = int(sr) if sr else self.sample_rate
        wav = np.asarray(wavs[0] if isinstance(wavs, (list, tuple)) else wavs, dtype=np.float32).reshape(-1)
        return wav
