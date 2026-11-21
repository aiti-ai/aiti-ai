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

# Diagnostics go to stderr: several helpers are captured via $(...) (e.g. pick_python prints the
# interpreter spec on stdout), so a stray stdout line would corrupt the result.
log() { echo "[bootstrap] $*" >&2; }
has() { command -v "$1" >/dev/null 2>&1; }

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

# uv-managed interpreters live under the service home so the environment is self-contained.
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$HOME_DIR/uv-python}"

# Zero-step environments (fresh docker images / minimal hosts) ship no Python <=3.12 and no uv:
# install uv itself (official installer, ~15MB) into <home>/bin, then let it fetch CPython 3.12.
install_uv() {
  [[ -x "$HOME_DIR/bin/uv" ]] && { export PATH="$HOME_DIR/bin:$PATH"; return 0; }
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    log "cannot install uv: neither curl nor wget is available"
    return 1
  fi
  prepare venv 7 "installing uv (Python toolchain bootstrap)"
  mkdir -p "$HOME_DIR/bin"
  if command -v curl >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR="$HOME_DIR/bin" sh >/dev/null 2>&1 || true
  else
    wget -qO- https://astral.sh/uv/install.sh | UV_INSTALL_DIR="$HOME_DIR/bin" sh >/dev/null 2>&1 || true
  fi
  if [[ -x "$HOME_DIR/bin/uv" ]]; then
    export PATH="$HOME_DIR/bin:$PATH"
    log "uv installed: $HOME_DIR/bin/uv ($("$HOME_DIR/bin/uv" --version 2>/dev/null | head -n1))"
    return 0
  fi
  log "uv installer failed (network?)"
  return 1
}

pick_python() {
  if ! command -v uv >/dev/null 2>&1; then install_uv || true; fi
  if command -v uv >/dev/null 2>&1; then
    if uv python find 3.12 >/dev/null 2>&1; then echo "uv:3.12"; return 0; fi
    log "installing CPython 3.12 via uv (one time, ~30MB)…"
    if uv python install 3.12 >/dev/null 2>&1 && uv python find 3.12 >/dev/null 2>&1; then
      echo "uv:3.12"; return 0
    fi
  fi
  # System interpreters are only acceptable when the venv module actually works (Ubuntu ships
  # python3.x without python3.x-venv by default -> `-m venv` fails on ensurepip).
  for v in python3.12 python3.11 python3.10; do
    if command -v "$v" >/dev/null 2>&1; then
      if "$v" -c "import venv, ensurepip" >/dev/null 2>&1; then echo "$(command -v "$v")"; return 0; fi
      log "$v found but its venv/ensurepip module is missing (apt install ${v}-venv) — trying other sources"
    fi
  done
  return 1
}

if [[ ! -x "$PY" ]]; then
  prepare venv 5 "creating Python 3.12 environment"
  # Run the uv bootstrap in the *parent* shell: it exports PATH, which a $(...) subshell would lose
  # (that made `uv venv` run as "command not found" on images without uv). Idempotent and quick.
  install_uv || true
  PYSPEC="$(pick_python)" || {
    echo "[bootstrap] no usable Python 3.10-3.12 and uv could not be installed automatically." >&2
    echo "  Options: install uv (https://docs.astral.sh/uv/) or Python 3.12 (+ python3.12-venv), then retry." >&2
    prepare failed 100 "python 3.12 not available (no uv, no python3.10-3.12 with venv)"
    exit 3
  }
  if [[ "$PYSPEC" == uv:* ]]; then
    UVVER="${PYSPEC#uv:}"
    ( cd "$HOME_DIR" && uv venv --seed --python "$UVVER" "$VENV" ) \
      || { prepare failed 100 "uv venv failed (see log)"; exit 3; }
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

# ── pip index resolution (CN networks black-hole pypi.org: an 8s+ stall per request) ──
# Order: AITI_TTS_PIP_INDEX -> user's PIP_INDEX_URL/pip.conf (we stay out of the way) -> probe
# pypi.org (4s) -> first reachable mirror -> default pypi (with an explicit warning).
resolve_pip_index() {
  if [[ -n "${AITI_TTS_PIP_INDEX:-}" ]]; then echo "$AITI_TTS_PIP_INDEX"; return 0; fi
  # Respect an explicit user-level pip configuration instead of overriding it.
  if [[ -n "${PIP_INDEX_URL:-}" ]]; then echo ""; return 0; fi
  local cfg=""
  cfg="$("$PY" -m pip config get global.index-url 2>/dev/null || true)"
  if [[ -n "$cfg" ]]; then log "pip config index in use: $cfg"; echo ""; return 0; fi

  # Real end-to-end probe (download a tiny wheel, --no-cache-dir): pypi.org can answer headers
  # fast and still crawl on files.pythonhosted.org, and a stalled-but-eventually-200 endpoint
  # must not win. The fastest candidate (default PyPI or a CN mirror) wins.
  probe_ms() { # $1 = index url ("" = default PyPI); prints elapsed ms or nothing on failure
    local idx="$1" tmp s e
    tmp="$(mktemp -d 2>/dev/null || echo "$HOME_DIR/.probe.$$")"
    mkdir -p "$tmp" || return 1
    s="$(date +%s%3N 2>/dev/null || echo "")"
    [[ -z "$s" ]] && s=$(( $(date +%s) * 1000 ))
    local run=( "$PY" -m pip download --no-cache-dir --no-deps -q -d "$tmp" six --timeout 8 --retries 0 )
    [[ -n "$idx" ]] && run+=( --index-url "$idx" )
    if has timeout; then timeout 20 "${run[@]}" >/dev/null 2>&1 || { rm -rf "$tmp"; return 1; }
    else "${run[@]}" >/dev/null 2>&1 || { rm -rf "$tmp"; return 1; }; fi
    e="$(date +%s%3N 2>/dev/null || echo "")"
    [[ -z "$e" ]] && e=$(( $(date +%s) * 1000 ))
    rm -rf "$tmp"
    echo $(( e - s ))
  }

  local best="" best_ms=999999 ms cand
  for cand in "" "https://mirrors.aliyun.com/pypi/simple/" "https://pypi.tuna.tsinghua.edu.cn/simple/"; do
    ms="$(probe_ms "$cand" 2>/dev/null)" || continue
    [[ -n "$ms" ]] || continue
    log "pip index probe ${cand:-default}: ${ms}ms"
    if [[ "$ms" -lt "$best_ms" ]]; then best_ms="$ms"; best="$cand"; fi
  done
  echo "$best"
}

PIP_INDEX="$(resolve_pip_index)"
# uv's installer has no --timeout/--retries (its defaults are fine); pip gets explicit fast-fail.
USE_UV=0
has uv && USE_UV=1
PIP_ARGS=()
[[ -n "$PIP_INDEX" ]] && PIP_ARGS+=(--index-url "$PIP_INDEX")
[[ "$USE_UV" == "1" ]] || PIP_ARGS+=(--timeout 30 --retries 2)
if [[ -n "$PIP_INDEX" ]]; then
  log "pip index: $PIP_INDEX (auto-selected; override with AITI_TTS_PIP_INDEX)"
fi

# Prefer uv's parallel installer when available (5-10x faster than pip here); it also works for
# `uv venv` environments that intentionally have no pip.
pip_run() {
  local sub="$1"; shift
  if [[ "$USE_UV" == "1" ]]; then
    uv pip "$sub" --python "$PY" "$@"
  elif "$PY" -m pip --version >/dev/null 2>&1; then
    "$PY" -m pip "$sub" "$@"
  else
    return 1
  fi
}
if [[ "$FORCE_DEPS" == "1" || ! -f "$STAMP" || "$(cat "$STAMP" 2>/dev/null)" != "$DEPS_HASH" ]]; then
  prepare deps 18 "installing python deps (first run may take a few minutes${PIP_INDEX:+ · via $(echo "$PIP_INDEX" | sed -E 's#https?://([^/]+)/.*#\1#')})"
  if [[ "$USE_UV" != "1" ]]; then "$PY" -m pip install --upgrade pip -q >/dev/null 2>&1 || true; fi
  ok=0
  for attempt in 1 2 3; do
    if pip_run install -q -r "$REQ" "${PIP_ARGS[@]}"; then ok=1; break; fi
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
      if pip_run install -q 'WeTextProcessing>=1.0.4.1' "${PIP_ARGS[@]}" 2>/dev/null; then
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
# Report the *effective* TN state (installed and importable), not just "the install step ran".
TN_EFFECTIVE=false
if "$PY" -c "import tn" >/dev/null 2>&1; then TN_EFFECTIVE=true; fi
cat > "$HOME_DIR/ready.json" <<JSON
{"provider":"$PROVIDER","family":"$FAMILY","venv":"$VENV","modelDir":"$MODEL_DIR","depsHash":"$DEPS_HASH","pipIndex":"$PIP_INDEX","tn":$TN_EFFECTIVE,"at":$(date +%s)}
JSON
prepare download 88 "model ready"
log "bootstrap complete: provider=$PROVIDER family=$FAMILY model=$MODEL_DIR"
