# tts-service · local TTS shell for aiti-ai-speek

A small FastAPI process that exposes the OpenAI `/v1/audio/speech` subset on `127.0.0.1:8768`
(auto 8769-8778) and delegates synthesis to a swappable provider. It is started, upgraded and
stopped by the extension; there is no manual install or download step.

```bash
bash start-tts.sh start          # bootstrap (venv -> deps -> model) + serve
bash start-tts.sh status|stop|restart
bash start-tts.sh start --provider hojo-80m        # voice cloning variant
bash bootstrap.sh --provider hojo-40m --force-deps  # re-run preparation only
```

## Layout

| Path | Purpose |
|---|---|
| `tts_server.py` | HTTP shell: `/v1/audio/speech`, `/health`, `/voices`, `/admin/load`, `/admin/stats`; lazy model load; idle-exit watchdog (in-flight requests are never truncated) |
| `providers/` | `base.py` (TTSEngine contract + registry), `hojo.py` (40M built-in voices / 80M cloning), `stub.py` (pipeline debugging), `qwen3.py` (torch; CUDA ideal) |
| `vendor/hojo40`, `vendor/hojo80` | Official Hojo inference code, vendored verbatim (Apache-2.0, LICENSE included) |
| `bootstrap.sh` / `bootstrap_models.py` | Idempotent preparation: uv Python 3.12 venv, fingerprinted deps, `snapshot_download` with automatic source resolution (explicit → `HF_ENDPOINT` → huggingface.co probe → hf-mirror) |
| `start-tts.sh` / `start-tts.ps1` | start/status/stop/restart; exact port-based kills; writes `prepare.json` (panel progress) + `runtime.json` (actual port) |
| `prep.py` | Atomic `prepare.json` writer shared by bootstrap and the server |

## Runtime directories (outside this folder)

`AITI_TTS_HOME` (set by the extension to `<cache>/tts-service`):

```
venv-hojo/ venv-qwen3/     per-family virtualenvs
models/<org>--<repo>/      downloaded weights
logs/tts.log               service + bootstrap log (tee)
prepare.json runtime.json ready.json
```

Voice assets (non-regenerable) live in the extension state area: `state/voices.json` +
`state/voices/<id>.wav`.

## Environment

| Variable | Meaning |
|---|---|
| `AITI_TTS_HOME` | data root (default `~/.pi/web/data/aiti-ai-speek/cache/tts-service`) |
| `AITI_TTS_PROVIDER` | default provider id |
| `AITI_TTS_PORT` | preferred port (fallback 8769-8778) |
| `AITI_TTS_IDLE_TIMEOUT` | idle seconds before exit (0 = stay resident) |
| `AITI_TTS_VOICES_JSON` | voices.json path (clone voices) |
| `AITI_TTS_HF_ENDPOINT` | explicit model download endpoint |
| `AITI_TTS_PIP_INDEX` | optional pip index mirror |
| `AITI_TTS_TN=0` | skip WeTextProcessing installation |
| `AITI_TTS_THREADS` | ONNX runtime thread count (0 = auto) |

## Requirements

Python 3.10-3.12 (Hojo rejects 3.13). `uv` is used when present so a 3.12 interpreter can be
created without touching the system one. `ffmpeg` is optional: it enables `response_format=mp3`
and non-WAV reference audio uploads; without it, ask for `wav`/`pcm` and upload WAV files.
