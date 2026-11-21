#!/usr/bin/env python3
"""Idempotent model bootstrap for the local TTS service (called by bootstrap.sh).

Responsibilities
  * resolve the download source automatically (explicit --hf-endpoint > env HF_ENDPOINT >
    probe huggingface.co > probe hf-mirror.com > fail with proxy guidance)
  * download only the required files (per-file progress -> prepare.json), resumable
  * verify sizes, retry 3x with backoff

No manual download step is ever offered to the user: `start-tts.sh start` calls this and the
panel only shows phases.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import urllib.request
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from prep import write_prepare  # noqa: E402

# repo + the minimal file set each provider needs (keeps the download small and predictable)
BUNDLES: dict[str, dict[str, Any]] = {
    "hojo-40m": {
        "repo": "HojoAI/Hojo-TTS-Light-40M-V2",
        "family": "hojo",
        "patterns": [
            "Hojo-TTS-Light-40M-llm.onnx",
            "Hojo-TTS-Light-40M-fine_local.onnx",
            "Hojo-TTS-Light-40M-decoder.onnx",
            "Hojo-TTS-Light-40M-voice.npz",
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
        ],
    },
    "hojo-80m": {
        "repo": "HojoAI/Hojo-TTS-Light",
        "family": "hojo",
        "patterns": [
            "Hojo-TTS-Light-llm.onnx",
            "Hojo-TTS-Light-decoder.onnx",
            "Hojo-TTS-Light-encoder.onnx",
            "Hojo-TTS-Light-speaker.onnx",
            "Hojo-TTS-Light-voice.npz",
            "config.json",
            "tokenizer.json",
            "tokenizer_config.json",
        ],
    },
    "qwen3-0.6b": {"repo": "Qwen/Qwen3-TTS-12Hz-0.6B-Base", "family": "qwen3", "patterns": []},
    "qwen3-1.7b": {"repo": "Qwen/Qwen3-TTS-12Hz-1.7B-Base", "family": "qwen3", "patterns": []},
    "stub": {"repo": "", "family": "hojo", "patterns": []},
}

OFFICIAL = "https://huggingface.co"
MIRROR = "https://hf-mirror.com"


def log(msg: str) -> None:
    print(f"[bootstrap] {msg}", flush=True)


def probe(url: str, timeout: float = 3.0) -> bool:
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"user-agent": "aiti-tts-bootstrap"})
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return 200 <= int(getattr(res, "status", 200)) < 400
    except Exception:
        return False


def resolve_endpoint(explicit: str) -> tuple[str | None, str]:
    """Return (endpoint or None for library default, human readable source)."""
    if explicit:
        return explicit.rstrip("/"), "explicit"
    env = (os.environ.get("HF_ENDPOINT") or "").strip()
    if env:
        return env.rstrip("/"), "env HF_ENDPOINT"
    if probe(OFFICIAL):
        return OFFICIAL, "probe official"
    if probe(MIRROR):
        return MIRROR, "probe mirror"
    return None, "unresolved"


def api_sizes(endpoint: str, repo: str) -> dict[str, int]:
    """File name -> size from the model API (best effort; empty when unreachable)."""
    try:
        url = f"{endpoint}/api/models/{repo}?blobs=true"
        with urllib.request.urlopen(url, timeout=15) as res:
            data = json.loads(res.read().decode("utf-8"))
        out: dict[str, int] = {}
        for sib in data.get("siblings") or []:
            name = sib.get("rfilename") or ""
            size = sib.get("size") or (sib.get("lfs") or {}).get("size") or 0
            if name:
                out[name] = int(size or 0)
        return out
    except Exception:
        return {}


def apply_endpoint_env(endpoint: str, source: str) -> None:
    if endpoint:
        os.environ["HF_ENDPOINT"] = endpoint
    if "mirror" in (endpoint or "") or source == "mirror":
        # hf-mirror does not serve Xet properly (xethub.hf.co returns 401) -> force classic HTTP.
        os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")
    os.environ.setdefault("HF_HUB_ETAG_TIMEOUT", "30")


def modelscope_download(repo: str, target: str) -> None:
    exe = shutil.which("modelscope")
    if not exe:
        raise SystemExit("[bootstrap] --source modelscope requested but the modelscope CLI is not installed")
    log(f"modelscope download {repo} -> {target}")
    import subprocess
    proc = subprocess.run([exe, "download", "--model", repo, "--local_dir", target])
    if proc.returncode != 0:
        raise SystemExit(f"[bootstrap] modelscope download failed (exit {proc.returncode})")


def write_hf_env(home: str, endpoint: str, mirror: bool) -> None:
    """Persist the resolved download endpoint so the service can reuse it on first model load."""
    try:
        path = os.path.join(home, "hf-env.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"HF_ENDPOINT": endpoint, "HF_HUB_DISABLE_XET": "1" if mirror else ""}, f)
    except Exception:
        pass


def check_qwen3_runtime(prepare: str) -> None:
    """Qwen3 weights are fetched by qwen-tts itself; here we only verify the torch stack exists."""
    missing = []
    for mod in ("torch", "qwen_tts"):
        try:
            __import__(mod)
        except Exception:
            missing.append(mod)
    if missing:
        write_prepare(prepare, "failed", 100,
                      "qwen3 provider needs torch + qwen-tts (missing: " + ", ".join(missing) + ")")
        raise SystemExit(
            "[bootstrap] qwen3 provider needs torch and qwen-tts in " + os.environ.get("VIRTUAL_ENV", "(the qwen3 venv)") + "\n"
            "  Install the torch wheel for your device first, then:\n"
            "    <venv>/bin/pip install -U qwen-tts\n"
            "  (torch is intentionally NOT auto-installed: the right wheel depends on CUDA/ROCm/CPU)")


def download(provider: str, home: str, prepare: str, explicit_endpoint: str, source: str) -> str:
    bundle = BUNDLES.get(provider)
    if bundle is None:
        raise SystemExit(f"[bootstrap] unknown provider '{provider}'")
    repo = bundle["repo"]
    if not repo:
        log("stub provider: no model download needed")
        return ""
    if bundle["family"] == "qwen3":
        # Weights land in the HF cache on first load (qwen-tts snapshot); no manual pre-download.
        check_qwen3_runtime(prepare)
        write_prepare(prepare, "download", 88, "qwen3 runtime present; weights fetch on first load", repo=repo)
        return os.path.join(home, "models", repo.replace("/", "--"))
    target = os.path.join(home, "models", repo.replace("/", "--"))
    os.makedirs(target, exist_ok=True)

    patterns = bundle["patterns"]
    if source == "modelscope":
        write_prepare(prepare, "download", 42, f"modelscope download {repo}")
        modelscope_download(repo, target)
        write_prepare(prepare, "download", 88, f"{repo} ready")
        return target

    endpoint, how = resolve_endpoint(explicit_endpoint)
    if not endpoint:
        raise SystemExit(
            "[bootstrap] cannot reach huggingface.co nor hf-mirror.com.\n"
            "  Configure a proxy and rerun, e.g.\n"
            "    HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 bash start-tts.sh start\n"
            "  or pick a mirror explicitly:\n"
            "    bash start-tts.sh start --hf-endpoint https://hf-mirror.com")
    apply_endpoint_env(endpoint, how)
    write_hf_env(home, endpoint, "mirror" in endpoint or how == "mirror")
    log(f"source: {endpoint} ({how})")

    sizes = api_sizes(endpoint, repo) if patterns else {}
    total = sum(sizes.get(p, 0) for p in patterns) if patterns else 0
    if not patterns:
        # qwen3: whole repo (weights + speech tokenizer); progress stays indeterminate.
        patterns = ["*"]

    from huggingface_hub import hf_hub_download

    done_bytes = 0
    for index, name in enumerate(patterns):
        expected = sizes.get(name, 0)
        local = os.path.join(target, name)
        if expected and os.path.isfile(local) and os.path.getsize(local) == expected:
            done_bytes += expected
            continue
        base = 42 + (46 * done_bytes / total if total else 0)
        write_prepare(prepare, "download", base,
                      f"downloading {name} ({index + 1}/{len(patterns)})", repo=repo, file=name)
        last_err: Exception | None = None
        for attempt, delay in enumerate((0, 1, 4, 16)):
            if delay:
                time.sleep(delay)
            try:
                hf_hub_download(repo_id=repo, filename=name, local_dir=target,
                                etag_timeout=30)
                last_err = None
                break
            except Exception as e:  # network hiccup / partial file
                last_err = e
                log(f"download {name} attempt {attempt + 1} failed: {e}")
                write_prepare(prepare, "download", base,
                              f"retry {name} ({attempt + 1}/4): {str(e)[:120]}", repo=repo, file=name)
        if last_err is not None:
            raise SystemExit(f"[bootstrap] failed to download {name}: {last_err}")
        if expected:
            got = os.path.getsize(local) if os.path.isfile(local) else 0
            if got != expected:
                raise SystemExit(f"[bootstrap] size mismatch for {name}: {got} != {expected}")
            done_bytes += expected

    # Final verification: every required file present and non-trivial.
    for name in bundle["patterns"]:
        local = os.path.join(target, name)
        if not os.path.isfile(local):
            raise SystemExit(f"[bootstrap] missing file after download: {local}")
        size = os.path.getsize(local)
        if name.endswith(".onnx") and size < 1_000_000:
            raise SystemExit(f"[bootstrap] suspiciously small onnx file: {local} ({size}B)")
    write_prepare(prepare, "download", 88, f"{repo} verified", repo=repo)
    log(f"model ready: {target} ({sum(os.path.getsize(os.path.join(target, p)) for p in bundle['patterns']) / 1048576:.0f} MB)")
    return target


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", required=True)
    ap.add_argument("--home", required=True)
    ap.add_argument("--prepare-json", default="")
    ap.add_argument("--hf-endpoint", default="")
    ap.add_argument("--source", default="hf", choices=["hf", "modelscope"])
    ap.add_argument("--print-dir", action="store_true")
    args = ap.parse_args()
    target = download(args.provider, args.home, args.prepare_json, args.hf_endpoint, args.source)
    if args.print_dir:
        print(target)


if __name__ == "__main__":
    main()
