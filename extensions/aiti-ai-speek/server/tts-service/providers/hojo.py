"""Hojo-TTS-Light engine (ONNX Runtime, CPU friendly).

Wraps the vendor copy of the official `onnx_model.py` (imported verbatim, never rewritten):
  - 40M  (`HojoAI/Hojo-TTS-Light-40M-V2`): 17 built-in voices, no reference audio needed.
  - 80M  (`HojoAI/Hojo-TTS-Light`):        voice cloning from user reference audio + transcript.

Both variants are loaded lazily so the HTTP shell answers /health while the model warms up.
"""
from __future__ import annotations

import importlib.util
import os
import re
import sys
import threading
from pathlib import Path
from typing import Any

import numpy as np

from .base import BadRequest, NotReady, TTSEngine, UnknownVoice, Voice

_VENDOR = Path(__file__).resolve().parent.parent / "vendor"

_ZH_LABEL = {"f": "女声", "m": "男声"}
_EN_LABEL = {"f": "Female", "m": "Male"}


def _load_module(name: str, path: Path):
    """Import a vendored single-file module under a unique name (40M/80M share file names)."""
    mod = sys.modules.get(name)
    if mod is not None:
        return mod
    spec = importlib.util.spec_from_file_location(name, str(path))
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load module from {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


class HojoEngine(TTSEngine):
    supports_clone = False
    sample_rate = 24000

    def __init__(self, *, variant: int = 40, **kwargs) -> None:
        self.variant = 40 if int(variant) == 40 else 80
        self.id = f"hojo-{self.variant}m"
        super().__init__(**kwargs)
        self.model_label = f"Hojo-TTS-Light-{self.variant}M"
        self.supports_clone = self.variant == 80
        self._model = None
        self._voices: list[Voice] = []
        self._lock = threading.Lock()
        self._tn_mod = None
        self._tn_failed = False

    # -- model -------------------------------------------------------------
    def _vendor_dir(self) -> Path:
        return _VENDOR / f"hojo{self.variant}"

    def load(self) -> None:
        with self._lock:
            if self.loaded:
                return
            vendor = self._vendor_dir()
            onnx_mod = _load_module(f"hojo_onnx_{self.variant}m", vendor / "onnx_model.py")
            # Required graph set differs per variant (40M: single decoder; 80M: encoder+decoder+speaker).
            required = [onnx_mod.LM_ONNX_NAME]
            if self.variant == 40:
                required += [onnx_mod.CODEC_ONNX_NAME, onnx_mod.VOICES_NPZ_NAME]
            else:
                required += [onnx_mod.DECODER_ONNX_NAME, onnx_mod.SPEAKER_ONNX_NAME, onnx_mod.VOICES_NPZ_NAME]
                if hasattr(onnx_mod, "CODEC_ENCODER_NAME"):
                    required.append(onnx_mod.CODEC_ENCODER_NAME)
            missing = [n for n in required if not os.path.isfile(os.path.join(self.model_dir, n))]
            if missing:
                raise NotReady(f"model files missing in {self.model_dir}: {', '.join(missing)}")
            kwargs: dict[str, Any] = {"provider": "cpu", "num_threads": self.num_threads}
            if self.variant == 80:
                self._model = onnx_mod.HojoTTSLightOnnx(self.model_dir, **kwargs)
            else:
                self._model = onnx_mod.HojoTTSLightOnnx(self.model_dir, None, **kwargs)
            self._voices = self._build_voices()
            self.loaded = True
            self.last_error = None

    def reload(self) -> None:
        # Voice list = built-ins (fixed) + voices.json clone entries (80M only) -> re-read cheaply.
        if self.loaded:
            self._voices = self._build_voices()

    def _build_voices(self) -> list[Voice]:
        voices: list[Voice] = []
        if self.variant == 40:
            for vid in list(getattr(self._model, "available_voices", []) or []):
                voices.append(self._builtin_voice(str(vid)))
            # Chinese first: the UI reads Chinese AI replies, the service order is alphabetical (en first).
            voices.sort(key=lambda v: (0 if v.language == "zh" else 1, v.id))
        voices.extend(self.clone_voices(provider_ids=(self.id, self.model_label.lower())))
        return voices

    def _builtin_voice(self, vid: str) -> Voice:
        # id shape: hojo_{lang}_{sex}_{nn}
        m = re.match(r"hojo_([a-z]{2})_([fm])_(\d+)$", vid)
        if not m:
            return Voice(id=vid, label=vid, sample="我是内置音色，很高兴为你朗读。", provider=self.id)
        lang, sex, num = m.group(1), m.group(2), m.group(3)
        if lang == "zh":
            label = f"中文 · {_ZH_LABEL[sex]} {int(num)}"
            sample = f"我是 Hojo 中文{'女' if sex == 'f' else '男'}声 {int(num)}，很高兴为你朗读。"
        else:
            label = f"English · {_EN_LABEL[sex]} {int(num)}"
            sample = f"Hello, I am built-in English {'female' if sex == 'f' else 'male'} voice {int(num)}."
        return Voice(id=vid, label=label, sample=sample, builtin=True,
                     provider=self.id, language="zh" if lang == "zh" else "en")

    # -- text normalization ------------------------------------------------
    def _normalize(self, text: str, language: str) -> str:
        text = self.normalize(text)
        if not text or not self.tn_enabled or self._tn_failed:
            return text
        try:
            if self._tn_mod is None:
                self._tn_mod = _load_module(f"hojo_tn_{self.variant}m",
                                            self._vendor_dir() / "text_normalize.py")
            # WeTextProcessing (pynini) may be absent/failed to build: degrade to raw text (R16).
            return str(self._tn_mod.normalize_text(text, language=language or "auto"))
        except Exception:
            self._tn_failed = True
            return text

    # -- contract ----------------------------------------------------------
    def voices(self) -> list[Voice]:
        if not self.loaded:
            return []
        return list(self._voices)

    def synthesize(self, text: str, voice: str | None, *, language: str = "auto") -> np.ndarray:
        if not self.loaded:
            raise NotReady("model is still loading")
        text = (text or "").strip()
        if not text:
            raise BadRequest("empty input text")
        voice = (voice or "").strip()
        # Default: first Chinese built-in for 40M; first clone entry for 80M.
        if not voice and self._voices:
            voice = self._voices[0].id
        tn_lang = "auto"
        if language in ("Chinese", "zh"):
            tn_lang = "zh"
        elif language in ("English", "en"):
            tn_lang = "en"
        spoken = self._normalize(text, tn_lang)
        with self._lock:
            if self.variant == 40:
                available = set(str(v) for v in (getattr(self._model, "available_voices", []) or []))
                if voice not in available:
                    raise UnknownVoice(
                        f"voice '{voice}' is not a built-in 40M voice; available: {sorted(available)[:6]}...")
                wav = self._model.generate(spoken, voice=voice)
            else:
                item = next((v for v in self._voices if v.id == voice and not v.builtin), None)
                if item is None:
                    raise UnknownVoice(
                        f"voice '{voice}' has no reference audio for 80M cloning; create one in the settings panel")
                ref_audio = str(item.meta.get("ref_audio") or "")
                if not ref_audio or not os.path.isfile(ref_audio):
                    raise UnknownVoice(f"reference audio missing for voice '{voice}': {ref_audio or '(empty)'}")
                ref_text = str(item.meta.get("ref_text") or "").strip()
                wav = self._model.generate(spoken, prompt_speech=ref_audio, prompt_text=ref_text)
        return np.asarray(wav, dtype=np.float32).reshape(-1)
