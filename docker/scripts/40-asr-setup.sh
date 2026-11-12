#!/usr/bin/env bash
# 40-asr-setup.sh — ASR venv + default-engine model pre-download (aiti-docker-image-plan §2.2.2)
# The bulk of the size (~2GB): baked into the image at build time so users never stall on their first turn; modelscope reachable directly from CN.
set -euo pipefail
VENV=/opt/aiti-asr/.venv
# ⚠ First-run calibration (2026-09-09): ubuntu 26.04 system python = 3.14, and the numpy1.26/torch ecosystem has no cp314
# wheels (source builds lack the ABI) — build the venv with a uv-managed standalone CPython 3.12 (self-contained, no apt dependency).
pip3 install --break-system-packages --quiet uv
# uv installs its managed Python under /root by default (after venv symlinking aiti cannot traverse it → Permission denied) —
# moved to /opt/aiti-asr/python with read permissions opened (first-run smoke verified)
export UV_PYTHON_INSTALL_DIR=/opt/aiti-asr/python
uv venv --python 3.12 "$VENV"

# Deps aligned with server/requirements.txt: the fastapi service surface + the funasr stack + pypinyin (hotword pinyin fuzzy matching).
# torch installs from the official CPU source first (pypi linux wheels bundle the whole CUDA stack, ~5GB — useless without a GPU).
# (2026-09-09 alignment: faster-whisper removed — the server no longer uses it; the whisper offline engine is an optional
#   family of the openai-whisper package, absent from requirements.txt and not pre-installed in the image.)
uv pip install --python "$VENV/bin/python" \
  --index-url "${TORCH_CPU_INDEX:-https://download.pytorch.org/whl/cpu}" \
  torch torchaudio
uv pip install --python "$VENV/bin/python" \
  --index-url "${PIP_MIRROR:-https://pypi.org/simple}" \
  fastapi "uvicorn[standard]" python-multipart websockets \
  funasr modelscope pypinyin

# Model pre-download: same sources as voice-asr-stream.py's built-in default engines (TODO backfill completed 2026-09-09) —
#   streaming paraformer-zh-streaming / 2-pass seaco paraformer / quick SenseVoiceSmall / VAD fsmn-vad,
#   all funasr AutoModel hub="ms" (modelscope direct from CN). Same call, same params = same alias resolution, zero re-download at runtime.
# Cache location MODELSCOPE_CACHE=/opt/aiti-asr/models: baked into the image layer and not shadowed by the optional /home/aiti/.cache volume;
# the same ENV name in Dockerfile.full makes runtime read the same directory (switching models via asr-config.json also lands incremental downloads here).
export MODELSCOPE_CACHE=/opt/aiti-asr/models
mkdir -p "$MODELSCOPE_CACHE"
"$VENV/bin/python" - <<'EOF'
from funasr import AutoModel

for model_id in (
    "paraformer-zh-streaming",                                    # STREAM_MODEL_ID default (WS realtime transcript)
    "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",  # OFFLINE_MODEL_ID default (2-pass refinement)
    "iic/SenseVoiceSmall",                                        # SENSE_MODEL_ID (quick recognition)
    "fsmn-vad",                                                   # VAD (dynamic streaming VAD)
):
    print(f"[40-asr] pre-download {model_id} ...", flush=True)
    AutoModel(model=model_id, device="cpu", disable_update=True, hub="ms")
print("[40-asr] funasr default models cached")
EOF
echo "[40-asr] venv + models -> $VENV / $MODELSCOPE_CACHE"
# readable by aiti (runtime loading) and writable (runtime incremental model downloads land here)
chown -R aiti:aiti "$MODELSCOPE_CACHE" 2>/dev/null || true
chmod -R a+rX /opt/aiti-asr 2>/dev/null || true
