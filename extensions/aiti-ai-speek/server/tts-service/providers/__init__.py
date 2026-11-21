"""Provider registry: provider id -> engine factory.

Adding a third TTS only means adding a module here; the HTTP shell and the browser
extension stay untouched.
"""
from __future__ import annotations

from typing import Any, Callable

from .base import BadRequest, NotReady, TTSEngine, TTSError, UnknownVoice, Unsupported, Voice  # noqa: F401
from .hojo import HojoEngine
from .stub import StubEngine

try:  # pragma: no cover - import cost only matters on the qwen3 venv
    from .qwen3 import Qwen3Engine
except Exception:  # numpy missing etc. — keep the shell importable
    Qwen3Engine = None  # type: ignore[assignment]


#: provider id -> (label, required python package family, factory)
PROVIDERS: dict[str, tuple[str, str, Callable[..., TTSEngine]]] = {
    "hojo-40m": ("Hojo-TTS-Light-40M (CPU, built-in voices)", "hojo", lambda **kw: HojoEngine(variant=40, **kw)),
    "hojo-80m": ("Hojo-TTS-Light-80M (CPU/GPU, voice cloning)", "hojo", lambda **kw: HojoEngine(variant=80, **kw)),
    "stub": ("Stub (pipeline debugging, no model)", "hojo", lambda **kw: StubEngine(**kw)),
}
if Qwen3Engine is not None:
    PROVIDERS["qwen3-0.6b"] = (
        "Qwen3-TTS-0.6B (torch, GPU recommended)", "qwen3",
        lambda **kw: Qwen3Engine(provider_id="qwen3-0.6b", **kw),
    )
    PROVIDERS["qwen3-1.7b"] = (
        "Qwen3-TTS-1.7B (torch, GPU recommended)", "qwen3",
        lambda **kw: Qwen3Engine(provider_id="qwen3-1.7b", **kw),
    )

DEFAULT_PROVIDER = "hojo-40m"


def provider_ids() -> list[str]:
    return list(PROVIDERS.keys())


def resolve(provider_id: str) -> str:
    pid = (provider_id or DEFAULT_PROVIDER).strip()
    if pid not in PROVIDERS:
        raise BadRequest(f"unknown provider '{pid}'; available: {', '.join(provider_ids())}")
    return pid


def create(provider_id: str, **kwargs: Any) -> TTSEngine:
    pid = resolve(provider_id)
    return PROVIDERS[pid][2](**kwargs)


def label_of(provider_id: str) -> str:
    try:
        return PROVIDERS[resolve(provider_id)][0]
    except Exception:
        return provider_id


def family_of(provider_id: str) -> str:
    """Python dependency family (venv selector): hojo (onnx) or qwen3 (torch)."""
    pid = resolve(provider_id)
    return PROVIDERS[pid][1]
