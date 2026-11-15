#!/usr/bin/env bash
# 40-asr-setup.sh — ASR venv only (aiti-docker-image-plan §2.2.2)
# Models are NOT baked into the image (2026-11-15: dropped to save ~1GB image size) — funasr downloads
# them automatically on first use (same AutoModel hub="ms" calls as voice-asr-stream.py); the cache
# dir /opt/aiti-asr/models (MODELSCOPE_CACHE, set in Dockerfile.full) is created here and kept writable
# by aiti so runtime downloads persist across container restarts via the data volume.
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

# Cache location MODELSCOPE_CACHE=/opt/aiti-asr/models: created here (empty) and not shadowed by the optional
# /home/aiti/.cache volume; the same ENV name in Dockerfile.full makes runtime download into the same directory
# (first-use auto-download + switching models via asr-config.json also lands incremental downloads here).
export MODELSCOPE_CACHE=/opt/aiti-asr/models
mkdir -p "$MODELSCOPE_CACHE"
echo "[40-asr] venv -> $VENV | model cache dir (runtime auto-download) -> $MODELSCOPE_CACHE"
# readable by aiti (runtime loading) and writable (runtime incremental model downloads land here)
chown -R aiti:aiti "$MODELSCOPE_CACHE" 2>/dev/null || true
chmod -R a+rX /opt/aiti-asr 2>/dev/null || true
