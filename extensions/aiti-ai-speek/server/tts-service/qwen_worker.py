#!/usr/bin/env python3
"""Qwen3-TTS worker: runs in the qwen3 venv and speaks a JSONL protocol.

The main service venv is Hojo/ONNX; Qwen needs torch + qwen-tts. Keeping it in a
separate process lets both providers stay resident without forcing one venv to
carry both dependency families.
"""
from __future__ import annotations
import argparse, base64, json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import providers  # noqa: E402


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", default="qwen3-0.6b")
    ap.add_argument("--model-dir", default="")
    ap.add_argument("--voices-json", default="")
    ap.add_argument("--num-threads", type=int, default=0)
    ap.add_argument("--no-tn", action="store_true")
    args = ap.parse_args()
    try:
        engine = providers.create(
            args.provider,
            model_dir=args.model_dir,
            voices=(json.load(open(args.voices_json)) if args.voices_json and os.path.isfile(args.voices_json) else []),
            num_threads=args.num_threads,
            tn=not args.no_tn,
        )
        engine.load()
        emit({"ok": True, "ready": True, "sampleRate": int(getattr(engine, "sample_rate", 24000)),
              "voices": [v.as_dict() for v in engine.voices()], "model": getattr(engine, "model_label", args.provider)})
    except Exception as e:
        emit({"ok": False, "error": f"{type(e).__name__}: {e}"})
        return
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except Exception:
            continue
        cmd = req.get("cmd")
        if cmd == "shutdown":
            return
        if cmd == "reload":
            try:
                import json as _json
                if args.voices_json and os.path.isfile(args.voices_json):
                    engine.voices_config = _json.load(open(args.voices_json))
                engine.reload()
                emit({"ok": True, "voices": [v.as_dict() for v in engine.voices()]})
            except Exception as e:
                emit({"ok": False, "error": str(e)})
            continue
        if cmd == "voices":
            try:
                emit({"ok": True, "voices": [v.as_dict() for v in engine.voices()]})
            except Exception as e:
                emit({"ok": False, "error": str(e)})
            continue
        if cmd == "synthesize":
            try:
                text = str(req.get("text") or "")
                voice = req.get("voice")
                wav = np.asarray(engine.synthesize(text, voice), dtype=np.float32).reshape(-1)
                emit({"ok": True, "sampleRate": int(getattr(engine, "sample_rate", 24000)),
                      "audio": base64.b64encode(wav.tobytes()).decode("ascii")})
            except Exception as e:
                emit({"ok": False, "error": f"{type(e).__name__}: {e}"})
            continue
        emit({"ok": False, "error": f"unknown command: {cmd}"})


if __name__ == "__main__":
    main()
