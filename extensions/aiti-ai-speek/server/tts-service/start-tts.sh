#!/usr/bin/env bash
# =============================================================================
# aiti-ai-speek · local TTS service one-shot manager (Linux / macOS)
#
#   bash start-tts.sh              # start (idempotent; bootstraps venv/deps/model first)
#   bash start-tts.sh status       # state + last log lines
#   bash start-tts.sh stop         # stop (exact port-based PID, never a fuzzy pkill)
#   bash start-tts.sh restart      # restart (picks up a provider change)
#
# Flags: --provider hojo-40m|hojo-80m|qwen3-0.6b|qwen3-1.7b|stub
#        --port 8768  --hf-endpoint URL  --source hf|modelscope  --idle-timeout SEC
#
# Everything is prepared inside `start` (venv -> deps -> download -> load): the user never runs
# an install or download command. Progress lands in prepare.json for the settings panel, and the
# chosen port is written to runtime.json (so a busy 8768 can fall back to 8769..8778).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

HOME_DIR="${AITI_TTS_HOME:-$HOME/.pi/web/data/aiti-ai-speek/cache/tts-service}"
LOG_DIR="$HOME_DIR/logs"
LOG_FILE="$LOG_DIR/tts.log"
RUNTIME="$HOME_DIR/runtime.json"
PREPARE="$HOME_DIR/prepare.json"
VOICES_JSON="${AITI_TTS_VOICES_JSON:-}"
mkdir -p "$LOG_DIR"

PROVIDER="${AITI_TTS_PROVIDER:-hojo-40m}"
PORT="${AITI_TTS_PORT:-8768}"
IDLE_TIMEOUT="${AITI_TTS_IDLE_TIMEOUT:-1800}"
THREADS="${AITI_TTS_THREADS:-0}"
HF_ENDPOINT_ARG="${AITI_TTS_HF_ENDPOINT:-}"
SOURCE="${AITI_TTS_SOURCE:-hf}"
CMD="start"
ARGS=("$@")
if [[ ${#ARGS[@]} -gt 0 && "${ARGS[0]}" != -* ]]; then
  CMD="${ARGS[0]}"
  ARGS=("${ARGS[@]:1}")
fi
while [[ ${#ARGS[@]} -gt 0 ]]; do
  case "${ARGS[0]}" in
    --provider) PROVIDER="${ARGS[1]}"; ARGS=("${ARGS[@]:2}") ;;
    --port) PORT="${ARGS[1]}"; ARGS=("${ARGS[@]:2}") ;;
    --idle-timeout) IDLE_TIMEOUT="${ARGS[1]}"; ARGS=("${ARGS[@]:2}") ;;
    --threads) THREADS="${ARGS[1]}"; ARGS=("${ARGS[@]:2}") ;;
    --hf-endpoint) HF_ENDPOINT_ARG="${ARGS[1]}"; ARGS=("${ARGS[@]:2}") ;;
    --source) SOURCE="${ARGS[1]}"; ARGS=("${ARGS[@]:2}") ;;
    --no-tn) export AITI_TTS_TN=0; ARGS=("${ARGS[@]:1}") ;;
    *) echo "[tts] unknown arg: ${ARGS[0]}" >&2; exit 2 ;;
  esac
done

log() { echo "[tts] $*"; }

# ── port helpers ────────────────────────────────────────────────────────────
# Portable across hosts: ss (Linux) -> lsof (macOS) -> raw TCP connect via Python.
# Minimal images (e.g. the aiti docker base) ship neither ss nor netstat, so a pure-Python
# probe is the last resort and keeps auto-start working there.
has() { command -v "$1" >/dev/null 2>&1; }

py_bin() { if has python3; then echo python3; else echo python; fi; }

port_open_py() {
  local p="$1"
  "$(py_bin)" - "$p" <<'PYEOF' 2>/dev/null
import socket, sys
s = socket.socket()
s.settimeout(0.4)
try:
    s.connect(("127.0.0.1", int(sys.argv[1])))
    print("1")
except Exception:
    print("0")
finally:
    s.close()
PYEOF
}

is_up() {
  local p="$1"
  if has ss; then ss -tln 2>/dev/null | grep -qE "[:.]$p\s" && return 0 || return 1; fi
  if has lsof; then lsof -iTCP:"$p" -sTCP:LISTEN -t >/dev/null 2>&1 && return 0 || return 1; fi
  [[ "$(port_open_py "$p")" == "1" ]]
}

# Best-effort pid lookup for a listening port (only needed for status/stop messages).
port_pids() {
  local p="$1"
  if has ss; then ss -tlnp 2>/dev/null | grep "[:.]$p\s" | grep -oP 'pid=\K[0-9]+' | sort -u || true; return; fi
  if has lsof; then lsof -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | sort -u || true; return; fi
  local rp
  rp="$(runtime_port 2>/dev/null || true)"
  if [[ -n "${rp:-}" && "$rp" == "$p" ]]; then
    local pid
    pid="$(runtime_pid 2>/dev/null || true)"
    [[ -n "${pid:-}" ]] && echo "$pid"
  fi
}

# Our own server processes (fallback when the port->pid tools are missing).
scan_tts_pids() {
  local d pid c
  for d in /proc/[0-9]*; do
    [[ -d "$d" ]] || continue
    pid="${d#/proc/}"
    [[ "$pid" == "$$" ]] && continue
    c="$(tr '\0' ' ' 2>/dev/null < "$d/cmdline")" || continue
    case "$c" in *"$SCRIPT_DIR/tts_server.py"*) echo "$pid" ;; esac
  done
}

runtime_pid() {
  [[ -f "$RUNTIME" ]] || return 1
  "$(py_bin)" - "$RUNTIME" <<'PYEOF' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    p = int(d.get("pid") or 0)
    if not p:
        sys.exit(1)
    print(p)
except Exception:
    sys.exit(1)
PYEOF
}

service_healthy() {
  local p="$1"
  "$(py_bin)" - "$p" <<'PY' 2>/dev/null
import json, sys, urllib.request
port = sys.argv[1]
try:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1.5) as r:
        d = json.loads(r.read().decode())
    sys.exit(0 if d.get("provider") else 1)
except Exception:
    sys.exit(1)
PY
}

# A port owned by *our* service (not some other process) may be reused.
find_our_port() {
  local p
  for p in "$@"; do
    if is_up "$p" && service_healthy "$p"; then echo "$p"; return 0; fi
  done
  return 1
}

free_port() {
  local p
  for p in $(seq "${1:-8768}" $(( ${1:-8768} + 10 ))); do
    if ! is_up "$p"; then echo "$p"; return 0; fi
  done
  return 1
}

runtime_port() {
  [[ -f "$RUNTIME" ]] || return 1
  "$(py_bin)" - "$RUNTIME" <<'PY' 2>/dev/null || return 1
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    p = int(d.get("port") or 0)
    if not p:
        sys.exit(1)
    print(p)
except Exception:
    sys.exit(1)
PY
}

status() {
  local actual
  actual="$(runtime_port || true)"
  local probe_ports=("$PORT")
  [[ -n "${actual:-}" && "$actual" != "$PORT" ]] && probe_ports+=("$actual")
  local up_port
  up_port="$(find_our_port "${probe_ports[@]}" || true)"
  if [[ -n "${up_port:-}" ]]; then
    local pids
    pids="$(port_pids "$up_port" | tr '\n' ' ')"
    log "$up_port 运行中 (pid: ${pids:-?}) · provider: $PROVIDER"
    log "直接访问: http://127.0.0.1:$up_port/health（经 pi-web: /api/extensions/aiti-ai-speek/tts-info）"
  else
    log "$PORT 未运行"
    if [[ -f "$LOG_FILE" ]]; then
      log "── 日志尾部（$LOG_FILE）──"
      tail -n 8 "$LOG_FILE" || true
    fi
    log "启动: bash $SCRIPT_DIR/start-tts.sh start --provider $PROVIDER"
  fi
}

prepare() {
  printf '{"phase":"%s","percent":%s,"message":"%s","at":%s}\n' "$1" "$2" "$3" "$(date +%s)" > "$PREPARE.tmp"
  mv -f "$PREPARE.tmp" "$PREPARE"
}

start() {
  local existing
  existing="$(find_our_port "$PORT" $(seq 8769 8778) || true)"
  if [[ -n "${existing:-}" ]]; then
    log "$existing 已在运行（幂等，跳过启动）"
    status
    exit 0
  fi

  # Port selection: requested port if free, otherwise the next free one in 8769..8778 (R22).
  local use_port="$PORT"
  if is_up "$use_port"; then
    use_port="$(free_port 8769 || true)"
    if [[ -z "${use_port:-}" ]]; then
      log "8768-8778 全部被占用，无法启动" >&2
      prepare failed 100 "no free port in 8768-8778"
      exit 5
    fi
    log "端口 $PORT 被其他进程占用，改用 $use_port"
  fi

  # Bootstrap (venv/deps/model) — writes prepare.json; cheap when everything is ready.
  # Tee to the service log as well: the panel's "view log" reads that file, so preparation
  # failures must be visible there (not only in the aiti-cmd PTY).
  set -o pipefail
  bash "$SCRIPT_DIR/bootstrap.sh" \
    --provider "$PROVIDER" \
    ${HF_ENDPOINT_ARG:+--hf-endpoint "$HF_ENDPOINT_ARG"} \
    --source "$SOURCE" \
    2>&1 | tee -a "$LOG_FILE" \
    || { log "bootstrap 失败（详见上方输出 / logs/tts.log）"; exit 4; }

  local venv="$HOME_DIR/venv-$( [[ "$PROVIDER" == qwen3-* ]] && echo qwen3 || echo hojo )"
  local py="$venv/bin/python"
  [[ -x "$py" ]] || { log "venv 缺失: $venv" >&2; exit 4; }

  local model_dir="" tn_flag=()
  if [[ -f "$HOME_DIR/ready.json" ]]; then
    model_dir="$("$py" - "$HOME_DIR/ready.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1])).get("modelDir") or "")
PY
)"
    if [[ "$("$py" - "$HOME_DIR/ready.json" <<'PY'
import json, sys
print("0" if json.load(open(sys.argv[1])).get("tn", True) else "1")
PY
)" == "1" ]]; then tn_flag=(--no-tn); fi
  fi

  # Reuse the resolved model-download endpoint for any first-load fetch done by the service itself
  # (qwen3 weights are pulled by qwen-tts on first synthesis, not by bootstrap).
  if [[ -f "$HOME_DIR/hf-env.json" ]]; then
    eval "$("$py" - "$HOME_DIR/hf-env.json" <<'PYEOF'
import json, shlex, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for k in ("HF_ENDPOINT", "HF_HUB_DISABLE_XET"):
    v = d.get(k) or ""
    if v:
        print(f"export {k}={shlex.quote(v)}")
PYEOF
)"
  fi
  printf '{"port":%s,"provider":"%s","pid":%s,"at":%s}\n' "$use_port" "$PROVIDER" "$$" "$(date +%s)" > "$RUNTIME"
  prepare load 90 "starting service on port $use_port"
  log "启动 uvicorn @127.0.0.1:$use_port · provider=$PROVIDER · 日志: $LOG_FILE"
  log "停止: bash $SCRIPT_DIR/start-tts.sh stop"
  exec > >(tee -a "$LOG_FILE") 2>&1
  exec "$py" "$SCRIPT_DIR/tts_server.py" \
    --provider "$PROVIDER" \
    --host 127.0.0.1 \
    --port "$use_port" \
    --model-dir "$model_dir" \
    --voices-json "${VOICES_JSON:-}" \
    --prepare-json "$PREPARE" \
    --idle-timeout "$IDLE_TIMEOUT" \
    --num-threads "$THREADS" \
    "${tn_flag[@]}"
}

stop() {
  local targets=()
  local p
  for p in "$PORT" $(seq 8768 8778); do
    if is_up "$p"; then
      if service_healthy "$p"; then targets+=("$p"); fi
    fi
  done
  local scanned
  scanned="$(scan_tts_pids | sort -u | tr '\n' ' ')"
  if [[ ${#targets[@]} -eq 0 && -z "${scanned// /}" ]]; then
    log "没有在监听的 TTS 服务，无需停止"
    rm -f "$RUNTIME"
    exit 0
  fi
  local killed=0
  for p in "${targets[@]}"; do
    local pids
    pids="$(port_pids "$p")"
    [[ -z "$pids" ]] && continue
    log "停止 $p → TERM: $(echo $pids | tr '\n' ' ')"
    for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
    killed=1
    local waited=0
    while is_up "$p" && [[ $waited -lt 10 ]]; do sleep 1; waited=$((waited + 1)); done
    if is_up "$p"; then
      log "$p 未在 10s 内退出，KILL"
      for pid in $pids; do kill -KILL "$pid" 2>/dev/null || true; done
    fi
  done
  # Fallback path (no ss/lsof): kill by cmdline, then by the pid recorded at startup.
  if [[ ${#targets[@]} -eq 0 && -n "${scanned// /}" ]]; then
    log "停止（按进程扫描）→ TERM: $scanned"
    for pid in $scanned; do kill -TERM "$pid" 2>/dev/null || true; done
    killed=1
  fi
  local rpid
  rpid="$(runtime_pid 2>/dev/null || true)"
  if [[ -n "${rpid:-}" ]] && kill -0 "$rpid" 2>/dev/null; then
    kill -TERM "$rpid" 2>/dev/null || true
    killed=1
  fi
  if [[ "$killed" == "0" ]]; then
    log "未能定位 TTS 进程（端口/进程扫描均无结果）"
  fi
  sleep 1
  for pid in $scanned $rpid; do [[ -n "${pid:-}" ]] && kill -KILL "$pid" 2>/dev/null || true; done
  rm -f "$RUNTIME"
  log "已停止"
}

case "$CMD" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  restart) stop; sleep 1; start ;;
  *)
    echo "用法: bash $0 [start|status|stop|restart] [--provider P] [--port N]" >&2
    exit 2
    ;;
esac
