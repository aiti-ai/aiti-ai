#!/usr/bin/env python3
"""Local TTS service shell (OpenAI-compatible subset) for the aiti-ai-speek extension.

Endpoints
  POST /v1/audio/speech   {model?, input, voice?, response_format?, speed?}  (pcm|wav|mp3)
  GET  /health            status / provider / model_loaded / sample_rate / RTF / RSS
  GET  /voices            built-in + cloned voices (same shape as the extension /voices)
  POST /admin/load        re-read voices.json (after creating/removing a clone voice)
  GET  /admin/stats       request counters, RTF, memory

The provider itself lives in providers/ (hojo | qwen3 | stub) and is selected with --provider.
Audio is always produced as float32 mono at the provider sample rate (24 kHz today); the shell
encodes it to the requested wire format so the extension can wrap raw PCM into a proper WAV
container (unknown-length streaming headers confuse Chromium's <audio> seek/duration).
"""
from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import wave
from types import SimpleNamespace
from typing import Any

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import providers  # noqa: E402
from prep import write_prepare  # noqa: E402
from providers.base import TTSError, Unsupported  # noqa: E402

APP_VERSION = "1.0.0"
MAX_INPUT_CHARS = 4000

state = SimpleNamespace(
    args=None,
    engine=None,
    provider="hojo-40m",
    provider_label="",
    status="starting",
    error=None,
    started_at=time.time(),
    loaded_at=0.0,
    requests=0,
    failures=0,
    last_rtf=None,
    last_synth_ms=None,
    last_error=None,
    total_audio_sec=0.0,
    total_synth_sec=0.0,
    voices_config=[],
    idle_timer=None,
    last_activity=time.time(),
    in_flight=0,
)

app = FastAPI(title="aiti local TTS", version=APP_VERSION)


class SpeechRequest(BaseModel):
    model: str | None = None
    input: str = ""
    voice: str | None = None
    response_format: str = "pcm"
    speed: float | None = 1.0


# ── helpers ────────────────────────────────────────────────────────────────
def log(msg: str) -> None:
    print(f"[tts] {msg}", flush=True)


def read_voices_json(path: str | None) -> list[dict[str, Any]]:
    if not path or not os.path.isfile(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            data = data.get("voices", [])
        return [v for v in data if isinstance(v, dict)] if isinstance(data, list) else []
    except Exception as e:
        log(f"voices.json unreadable ({path}): {e}")
        return []


def rss_mb() -> float | None:
    try:
        with open("/proc/self/statm", encoding="ascii") as f:
            pages = int(f.read().split()[1])
        return round(pages * os.sysconf("SC_PAGE_SIZE") / 1048576, 1)
    except Exception:
        return None


def to_pcm16(wav: np.ndarray) -> bytes:
    x = np.clip(np.asarray(wav, dtype=np.float32).reshape(-1), -1.0, 1.0)
    return (x * 32767.0).astype("<i2").tobytes()


def wav_bytes(wav: np.ndarray, sample_rate: int) -> bytes:
    pcm = to_pcm16(wav)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm)
    return buf.getvalue()


def mp3_bytes(wav: np.ndarray, sample_rate: int) -> bytes:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise Unsupported("mp3 output needs ffmpeg on PATH; ask for pcm or wav instead")
    pcm = to_pcm16(wav)
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", str(int(sample_rate)),
         "-ac", "1", "-i", "pipe:0", "-f", "mp3", "-b:a", "96k", "pipe:1"],
        input=pcm, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120,
    )
    if proc.returncode != 0:
        raise Unsupported("ffmpeg failed to encode mp3: " + proc.stderr.decode("utf-8", "ignore")[:200])
    return proc.stdout


# ── model lifecycle ────────────────────────────────────────────────────────
def load_engine() -> None:
    args = state.args
    prepare = getattr(args, "prepare_json", None)
    try:
        state.status = "loading"
        write_prepare(prepare, "load", 92, "loading model into memory",
                      provider=state.provider, pid=os.getpid(), port=args.port)
        state.engine.load()
        state.status = "ready"
        state.loaded_at = time.time()
        voices = len(state.engine.voices())
        log(f"model loaded: {state.provider_label} · voices={voices} · model={state.engine.model_label}")
        write_prepare(prepare, "ready", 100, f"ready · {state.provider}",
                      provider=state.provider, pid=os.getpid(), port=args.port,
                      model=state.engine.model_label, voices=voices)
    except Exception as e:
        state.status = "error"
        state.error = str(e)
        log(f"model load failed: {e}")
        write_prepare(prepare, "failed", 100, f"model load failed: {e}",
                      provider=state.provider, pid=os.getpid(), port=args.port)


def arm_idle_timer() -> None:
    """Single rescheduled timer (event driven, no polling): exit after N idle seconds."""
    timeout = int(getattr(state.args, "idle_timeout", 0) or 0)
    if timeout <= 0:
        return
    if state.idle_timer is not None:
        state.idle_timer.cancel()
    state.idle_timer = threading.Timer(timeout, _idle_check)
    state.idle_timer.daemon = True
    state.idle_timer.start()


def _idle_check() -> None:
    timeout = int(getattr(state.args, "idle_timeout", 0) or 0)
    idle = time.time() - state.last_activity
    # Never truncate an in-flight synthesis (external consumers such as aiti-video-studio):
    # defer the exit while requests are running and re-check shortly after.
    if state.in_flight > 0:
        state.idle_timer = threading.Timer(5.0, _idle_check)
        state.idle_timer.daemon = True
        state.idle_timer.start()
        return
    if idle < timeout:
        state.idle_timer = threading.Timer(max(1.0, timeout - idle), _idle_check)
        state.idle_timer.daemon = True
        state.idle_timer.start()
        return
    log(f"idle {int(idle)}s >= {timeout}s, exiting (model released)")
    write_prepare(getattr(state.args, "prepare_json", None), "idle-stop", 0, "exited after idle timeout")
    os._exit(0)


@app.middleware("http")
async def _touch(request: Request, call_next):
    state.last_activity = time.time()
    return await call_next(request)


# ── endpoints ──────────────────────────────────────────────────────────────
@app.get("/health")
def health() -> JSONResponse:
    engine = state.engine
    sample_rate = int(getattr(engine, "sample_rate", 24000) or 24000)
    body = {
        "ok": state.status == "ready",
        "status": state.status,
        "provider": state.provider,
        "providerLabel": state.provider_label,
        "model": getattr(engine, "model_label", state.provider),
        "model_loaded": state.status == "ready",
        "sample_rate": sample_rate,
        "supportsClone": bool(getattr(engine, "supports_clone", False)),
        "voiceCount": len(engine.voices()) if state.status == "ready" else 0,
        "voicesFromJson": len(state.voices_config),
        "uptime": round(time.time() - state.started_at, 1),
        "loadedAt": round(state.loaded_at, 3),
        "requests": state.requests,
        "failures": state.failures,
        "rtfLast": state.last_rtf,
        "lastSynthMs": state.last_synth_ms,
        "lastError": state.last_error,
        "error": state.error,
        "pid": os.getpid(),
        "port": int(getattr(state.args, "port", 0) or 0),
        "idleTimeout": int(getattr(state.args, "idle_timeout", 0) or 0),
        "lastActivity": round(state.last_activity, 3),
        "inFlight": state.in_flight,
        "rssMb": rss_mb(),
        "version": APP_VERSION,
    }
    return JSONResponse(body, headers={"cache-control": "no-store"})


@app.get("/voices")
def voices() -> JSONResponse:
    engine = state.engine
    items = [v.as_dict() for v in engine.voices()] if state.status == "ready" else []
    return JSONResponse({
        "ok": True,
        "provider": state.provider,
        "providerLabel": state.provider_label,
        "supportsClone": bool(getattr(engine, "supports_clone", False)),
        "sampleRate": int(getattr(engine, "sample_rate", 24000) or 24000),
        "voices": items,
    }, headers={"cache-control": "no-store"})


@app.post("/v1/audio/speech")
async def speech(body: SpeechRequest, request: Request):
    engine = state.engine
    text = (body.input or "").strip()
    if not text:
        return JSONResponse({"error": {"message": "input is required", "type": "invalid_request_error"}}, status_code=400)
    if len(text) > MAX_INPUT_CHARS:
        return JSONResponse({"error": {"message": f"input too long ({len(text)} > {MAX_INPUT_CHARS})", "type": "invalid_request_error"}}, status_code=400)
    if state.status != "ready":
        return JSONResponse({
            "error": {"message": f"model not ready ({state.status})", "type": "service_unavailable"},
            "status": state.status,
        }, status_code=503)

    fmt = (body.response_format or "pcm").strip().lower()
    if fmt not in ("pcm", "wav", "mp3"):
        return JSONResponse({"error": {"message": f"unsupported response_format '{fmt}'", "type": "invalid_request_error"}}, status_code=415)

    t0 = time.time()
    state.requests += 1
    state.in_flight += 1
    try:
        wav = await run_in_threadpool(engine.synthesize, text, body.voice)
    except TTSError as e:
        state.failures += 1
        state.last_error = str(e)
        return JSONResponse({"error": {"message": str(e), "type": e.__class__.__name__}}, status_code=getattr(e, "status", 500))
    except Exception as e:  # pragma: no cover - provider bug
        state.failures += 1
        state.last_error = f"{e.__class__.__name__}: {e}"
        log(f"synthesis failed: {state.last_error}")
        return JSONResponse({"error": {"message": state.last_error, "type": "internal_error"}}, status_code=500)
    finally:
        state.in_flight = max(0, state.in_flight - 1)

    synth_sec = time.time() - t0
    sample_rate = int(getattr(engine, "sample_rate", 24000) or 24000)
    # Providers may resample (qwen3 returns its own rate in some releases); keep the reported one.
    audio_sec = max(1e-6, len(wav) / float(sample_rate))
    state.last_synth_ms = round(synth_sec * 1000, 1)
    state.last_rtf = round(synth_sec / audio_sec, 3)
    state.total_audio_sec += audio_sec
    state.total_synth_sec += synth_sec

    try:
        if fmt == "pcm":
            payload, media = to_pcm16(wav), "audio/pcm"
        elif fmt == "wav":
            payload, media = wav_bytes(wav, sample_rate), "audio/wav"
        else:
            payload, media = await run_in_threadpool(mp3_bytes, wav, sample_rate), "audio/mpeg"
    except TTSError as e:
        return JSONResponse({"error": {"message": str(e), "type": "unsupported"}}, status_code=getattr(e, "status", 415))

    log(f"synth {len(text)}c -> {len(payload)}B {fmt} · {state.last_synth_ms}ms · RTF {state.last_rtf}")
    return Response(payload, media_type=media, headers={
        "cache-control": "no-store",
        "x-tts-provider": state.provider,
        "x-tts-sample-rate": str(sample_rate),
        "x-tts-rtf": str(state.last_rtf),
        "x-tts-synth-ms": str(state.last_synth_ms),
    })


@app.post("/admin/load")
def admin_load() -> JSONResponse:
    state.voices_config = read_voices_json(getattr(state.args, "voices_json", None))
    engine = state.engine
    try:
        engine.voices_config = state.voices_config
        engine.reload()
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
    items = [v.as_dict() for v in engine.voices()] if state.status == "ready" else []
    log(f"voices reloaded: {len(items)} total ({len(state.voices_config)} from voices.json)")
    return JSONResponse({"ok": True, "voices": items, "voicesFromJson": len(state.voices_config)})


@app.get("/admin/stats")
def admin_stats() -> JSONResponse:
    avg = (state.total_synth_sec / state.total_audio_sec) if state.total_audio_sec > 0 else None
    return JSONResponse({
        "ok": True,
        "provider": state.provider,
        "requests": state.requests,
        "failures": state.failures,
        "rtfLast": state.last_rtf,
        "rtfAvg": round(avg, 3) if avg else None,
        "audioSec": round(state.total_audio_sec, 2),
        "synthSec": round(state.total_synth_sec, 2),
        "rssMb": rss_mb(),
        "uptime": round(time.time() - state.started_at, 1),
    }, headers={"cache-control": "no-store"})


def main() -> None:
    ap = argparse.ArgumentParser(description="Local TTS service (OpenAI-compatible subset)")
    ap.add_argument("--provider", default=os.environ.get("AITI_TTS_PROVIDER", providers.DEFAULT_PROVIDER))
    ap.add_argument("--host", default=os.environ.get("AITI_TTS_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("AITI_TTS_PORT", "8768")))
    ap.add_argument("--model-dir", default=os.environ.get("AITI_TTS_MODEL_DIR", ""))
    ap.add_argument("--voices-json", default=os.environ.get("AITI_TTS_VOICES_JSON", ""))
    ap.add_argument("--prepare-json", default=os.environ.get("AITI_TTS_PREPARE_JSON", ""))
    ap.add_argument("--idle-timeout", type=int, default=int(os.environ.get("AITI_TTS_IDLE_TIMEOUT", "0")))
    ap.add_argument("--num-threads", type=int, default=int(os.environ.get("AITI_TTS_THREADS", "0")))
    ap.add_argument("--no-tn", action="store_true", default=os.environ.get("AITI_TTS_TN", "1") == "0")
    ap.add_argument("--version", action="store_true")
    args = ap.parse_args()
    if args.version:
        print(APP_VERSION)
        return

    state.args = args
    pid = providers.resolve(args.provider)
    state.provider = pid
    state.provider_label = providers.label_of(pid)
    state.voices_config = read_voices_json(args.voices_json)

    try:
        engine = providers.create(
            pid,
            model_dir=args.model_dir,
            voices=state.voices_config,
            num_threads=args.num_threads,
            tn=not args.no_tn,
        )
    except Exception as e:
        log(f"provider init failed: {e}")
        raise SystemExit(2)
    state.engine = engine

    log(f"starting provider={pid} ({state.provider_label}) model_dir={args.model_dir or '(default)'} "
        f"port={args.port} tn={'off' if args.no_tn else 'on'} idle={args.idle_timeout}s")
    threading.Thread(target=load_engine, name="model-loader", daemon=True).start()
    arm_idle_timer()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
