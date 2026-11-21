"""prepare.json writer shared by bootstrap and the TTS server.

The extension UI reads this file (via GET /tts/info and the /tts/progress SSE stream) to
show preparation phases: venv -> deps -> download -> load -> ready.

Writes are atomic (tmp + os.replace) so a concurrent reader never sees a torn file.
"""
from __future__ import annotations

import json
import os
import time


def write_prepare(path: str | None, phase: str, percent: float | None = None,
                  message: str = "", **extra) -> dict:
    """Write one preparation snapshot. Never raises (progress is best-effort)."""
    payload = {
        "phase": phase,
        "percent": None if percent is None else round(float(percent), 1),
        "message": message,
        "at": time.time(),
        **extra,
    }
    if not path:
        return payload
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:
        pass
    return payload


def read_prepare(path: str | None) -> dict | None:
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None
