#!/usr/bin/env bash
# =============================================================================
# aiti-ai-speek · local TTS service bootstrap (idempotent, zero manual steps)
#
# Called by start-tts.sh before the service starts; can also be run alone for troubleshooting:
#   bash bootstrap.sh --provider hojo-40m
#
# Phases written to $AITI_TTS_HOME/prepare.json for the settings panel:
#   venv (0-15) -> deps (15-40) -> download (40-88) -> load (handled by tts_server.py)
#
# Environment:
#   AITI_TTS_HOME          data root (default ~/.pi/web/data/aiti-ai-speek/cache/tts-service)
#   AITI_TTS_PROVIDER      default provider (hojo-40m)
#   AITI_TTS_PIP_INDEX     optional pip index-url (mirror)
#   AITI_TTS_TN=0          skip WeTextProcessing text normalization install
#   HF_ENDPOINT / HTTPS_PROXY / HTTP_PROXY  honoured for model download
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDER="${AITI_TTS_PROVIDER:-hojo-40m}"
HF_ENDPOINT_ARG=""
SOURCE="hf"
FORCE_DEPS=0
NO_TN="${AITI_TTS_TN:-1}"
[[ "$NO_TN" == "0" ]] && NO_TN=0 || NO_TN=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider) PROVIDER="$2"; shift 2 ;;
    --hf-endpoint) HF_ENDPOINT_ARG="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --force-deps) FORCE_DEPS=1; shift ;;
    --no-tn) NO_TN=1; shift ;;
    *) echo "[bootstrap] unknown arg: $1" >&2; exit 2 ;;
  esac
done

HOME_DIR="${AITI_TTS_HOME:-$HOME/.pi/web/data/aiti-ai-speek/cache/tts-service}"
PREPARE="$HOME_DIR/prepare.json"
LOG_DIR="$HOME_DIR/logs"
mkdir -p "$HOME_DIR" "$LOG_DIR"

prepare() { # phase percent message
  local phase="$1" percent="$2" message="$3"
  printf '{"phase":"%s","percent":%s,"message":"%s","at":%s}\n' \
    "$phase" "$percent" "$message" "$(date +%s)" > "$PREPARE.tmp"
  mv -f "$PREPARE.tmp" "$PREPARE"
}

log() { echo "[bootstrap] $*"; }

# ── provider family (venv selector) ──────────────────────────────────────────
case "$PROVIDER" in
  hojo-40m|hojo-80m|stub) FAMILY="hojo" ;;
  qwen3-0.6b|qwen3-1.7b)  FAMILY="qwen3" ;;
  *) echo "[bootstrap] unknown provider '$PROVIDER' (hojo-40m|hojo-80m|qwen3-0.6b|qwen3-1.7b|stub)" >&2; exit 2 ;;
esac

REQ="$SCRIPT_DIR/requirements-$FAMILY.txt"
[[ "$FAMILY" == "hojo" ]] && REQ="$SCRIPT_DIR/requirements-hojo.txt"
# 80M needs the extra audio stack (librosa/scipy) on top of the 40M deps.
[[ "$PROVIDER" == "hojo-80m" ]] && REQ="$SCRIPT_DIR/requirements-hojo80.txt"
[[ "$FAMILY" == "qwen3" ]] && REQ="$SCRIPT_DIR/requirements-qwen3.txt"

# ── 1) venv (Python 3.10-3.12; Hojo rejects 3.13) ───────────────────────────
VENV="$HOME_DIR/venv-$FAMILY"
PY="$VENV/bin/python"

pick_python() {
  if command -v uv >/dev/null 2>&1; then
    if uv python find 3.12 >/dev/null 2>&1; then echo "uv:3.12"; return 0; fi
    log "installing CPython 3.12 via uv (one time)…"
    if uv python install 3.12 >/dev/null 2>&1 && uv python find 3.12 >/dev/null 2>&1; then
      echo "uv:3.12"; return 0
    fi
  fi
  for v in python3.12 python3.11 python3.10; do
    if command -v "$v" >/dev/null 2>&1; then echo "$(command -v "$v")"; return 0; fi
  done
  return 1
}

if [[ ! -x "$PY" ]]; then
  prepare venv 5 "creating Python 3.12 environment"
  PYSPEC="$(pick_python)" || {
    echo "[bootstrap] no Python 3.10-3.12 found and uv is unavailable." >&2
    echo "  Install uv (https://docs.astral.sh/uv/) or Python 3.12, then rerun start-tts.sh." >&2
    prepare failed 100 "python 3.12 not available"
    exit 3
  }
  if [[ "$PYSPEC" == uv:* ]]; then
    UVVER="${PYSPEC#uv:}"
    ( cd "$HOME_DIR" && uv venv --seed --python "$UVVER" "$VENV" ) \
      || { prepare failed 100 "uv venv failed"; exit 3; }
  else
    "$PYSPEC" -m venv "$VENV" || { prepare failed 100 "python -m venv failed"; exit 3; }
  fi
  log "venv ready: $VENV"
fi
prepare venv 15 "python env ready"

# ── 2) dependencies (fingerprinted, skipped when unchanged) ─────────────────
if [[ ! -f "$REQ" ]]; then echo "[bootstrap] missing requirements: $REQ" >&2; exit 3; fi
DEPS_HASH="$(
  { cat "$REQ"; echo "family=$FAMILY"; echo "pip=${AITI_TTS_PIP_INDEX:-default}"; } \
    | { sha256sum 2>/dev/null || shasum -a 256; } | awk '{print $1}'
)"
STAMP="$VENV/.deps-sha256"
# venv may come from `uv venv` (no pip module) -> fall back to `uv pip install --python`.
pip_run() {
  if "$PY" -m pip --version >/dev/null 2>&1; then
    "$PY" -m pip "$@"
  elif command -v uv >/dev/null 2>&1; then
    uv pip install --python "$PY" "$@"
  else
    return 1
  fi
}
if [[ "$FORCE_DEPS" == "1" || ! -f "$STAMP" || "$(cat "$STAMP" 2>/dev/null)" != "$DEPS_HASH" ]]; then
  prepare deps 18 "installing python deps (first run may take a few minutes)"
  PIP_EXTRA=()
  [[ -n "${AITI_TTS_PIP_INDEX:-}" ]] && PIP_EXTRA=(--index-url "$AITI_TTS_PIP_INDEX")
  "$PY" -m pip install --upgrade pip -q >/dev/null 2>&1 || true
  ok=0
  for attempt in 1 2 3; do
    if pip_run install -q -r "$REQ" "${PIP_EXTRA[@]}"; then ok=1; break; fi
    log "pip install failed (attempt $attempt), retrying…"
    sleep $((attempt * 3))
  done
  [[ "$ok" == "1" ]] || { prepare failed 100 "pip install failed (see logs)"; exit 4; }
  printf '%s' "$DEPS_HASH" > "$STAMP"
  log "deps installed (hash ${DEPS_HASH:0:12})"
else
  log "deps unchanged (hash ${DEPS_HASH:0:12})"
fi
prepare deps 40 "python deps ready"

# ── 3) optional text normalization (Hojo only; failure degrades to --no-tn) ──
if [[ "$FAMILY" == "hojo" && "$NO_TN" == "1" ]]; then
  if ! "$PY" -c "import tn" >/dev/null 2>&1; then
    prepare deps 44 "installing text normalization (optional)"
    if "$PY" -c "import tn" >/dev/null 2>&1; then
      log "WeTextProcessing already installed"
    else
      prepare deps 44 "installing text normalization (optional)"
      if pip_run install -q 'WeTextProcessing>=1.0.4.1' "${PIP_EXTRA[@]}" 2>/dev/null; then
        log "WeTextProcessing installed"
      else
        log "WeTextProcessing install failed -> synthesis runs without text normalization"
        echo "no-tn" > "$HOME_DIR/tn-disabled"
      fi
    fi
  fi
fi

# ── 4) model download (source auto-resolved, resumable, verified) ───────────
prepare download 40 "preparing model files"
MODEL_DIR="$("$PY" "$SCRIPT_DIR/bootstrap_models.py" \
  --provider "$PROVIDER" \
  --home "$HOME_DIR" \
  --prepare-json "$PREPARE" \
  --hf-endpoint "$HF_ENDPOINT_ARG" \
  --source "$SOURCE" \
  --print-dir | tail -n 1)"

# ── 5) record the resolved environment for the extension ───────────────────
cat > "$HOME_DIR/ready.json" <<JSON
{"provider":"$PROVIDER","family":"$FAMILY","venv":"$VENV","modelDir":"$MODEL_DIR","depsHash":"$DEPS_HASH","tn":$([[ -f "$HOME_DIR/tn-disabled" ]] && echo false || echo true),"at":$(date +%s)}
JSON
prepare download 88 "model ready"
log "bootstrap complete: provider=$PROVIDER family=$FAMILY model=$MODEL_DIR"
