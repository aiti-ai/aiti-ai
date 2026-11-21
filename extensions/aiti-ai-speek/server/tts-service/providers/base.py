"""TTS engine abstraction (one implementation per provider).

A provider differs from the next one only inside the service process: the HTTP shell
(OpenAI-compatible /v1/audio/speech + /health + /voices + /admin/load) is identical, so the
browser extension never needs to know which engine produced the audio.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np


class TTSError(Exception):
    """Base class for provider errors mapped onto HTTP status codes by the shell."""

    status = 500


class BadRequest(TTSError):
    """Malformed input (e.g. empty text)."""

    status = 400


class UnknownVoice(TTSError):
    """Requested voice id is not provided by this engine."""

    status = 400


class NotReady(TTSError):
    """Model still loading (the extension may retry once loading completes)."""

    status = 503


class Unsupported(TTSError):
    """Requested output format is not available in this environment."""

    status = 415


@dataclass
class Voice:
    id: str
    label: str
    sample: str
    builtin: bool = True
    provider: str = ""
    language: str = ""
    #: Optional per-voice engine payload (reference audio path / prompt text for cloning).
    meta: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "sample": self.sample,
            "builtin": self.builtin,
            "provider": self.provider,
            "language": self.language,
        }


class TTSEngine:
    """Base class: subclasses implement load/voices/synthesize and may override reload."""

    #: Stable engine id exposed as /health.provider
    id: str = "base"
    #: Output sample rate (Hz); all current providers are 24 kHz mono.
    sample_rate: int = 24000
    #: Whether this engine accepts user reference audio (voice cloning).
    supports_clone: bool = False

    def __init__(self, *, model_dir: str, voices: list[dict[str, Any]] | None = None,
                 num_threads: int = 0, tn: bool = True) -> None:
        self.model_dir = model_dir
        self.voices_config = voices or []
        self.num_threads = num_threads
        self.tn_enabled = tn
        self.loaded = False
        self.model_label = self.id
        self.last_error: str | None = None

    # -- lifecycle ---------------------------------------------------------
    def load(self) -> None:  # pragma: no cover - implemented by subclasses
        raise NotImplementedError

    def reload(self) -> None:
        """Re-read voices.json (default: cheap re-scan used by POST /admin/load)."""

    # -- contract ----------------------------------------------------------
    def voices(self) -> list[Voice]:  # pragma: no cover - implemented by subclasses
        raise NotImplementedError

    def synthesize(self, text: str, voice: str | None, *,
                   language: str = "auto") -> np.ndarray:  # pragma: no cover
        raise NotImplementedError

    # -- helpers -----------------------------------------------------------
    @staticmethod
    def normalize(text: str) -> str:
        """Collapse whitespace; providers handle the rest."""
        return " ".join(text.split()) if text else ""

    def clone_voices(self, provider_ids: tuple[str, ...] = ()) -> list[Voice]:
        """Build Voice objects from voices.json entries owned by this provider."""
        out: list[Voice] = []
        for item in self.voices_config:
            if not isinstance(item, dict):
                continue
            vid = str(item.get("id") or "").strip()
            if not vid:
                continue
            owner = str(item.get("provider") or "").strip()
            if provider_ids and owner and owner not in provider_ids:
                continue
            lang = str(item.get("language") or "").strip()
            label = str(item.get("label") or vid).strip()
            out.append(Voice(
                id=vid,
                label=(f"{label} · 克隆" if label != vid else f"{vid} · 克隆"),
                sample=str(item.get("sample") or "我是克隆音色，很高兴为你朗读。"),
                builtin=False,
                provider=owner or self.id,
                language=lang,
                meta=item,
            ))
        return out
