#!/usr/bin/env bash
# smoke.sh — automated aiti image smoke suite (the repeatable form of docs/aiti-docker-test-report.md)
# Usage:
#   ./docker/scripts/smoke.sh core            # smoke core (default)
#   ./docker/scripts/smoke.sh full            # smoke full (GUI/ASR/term; includes all core checks)
#   ./docker/scripts/smoke.sh full --keep     # keep the container after passing for manual inspection
#   ./docker/scripts/smoke.sh core --platform linux/arm64 --image aiti/aiti:core-arm64
# Mechanism: starts a disposable container (no host ports published, avoiding clashes with a local pi-web-dev/aiti-bridge);
#       every probe runs curl/python inside the container via docker exec. Exit code = number of failures (0 = all green).
set -u
TARGET="core"; KEEP=""; PLATFORM=""; IMAGE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    core|full) TARGET="$1";;
    --keep) KEEP="--keep";;
    --platform) PLATFORM="$2"; shift;;
    --image) IMAGE="$2"; shift;;
    *) echo "unknown arg $1"; exit 1;;
  esac
  shift
done
IMAGE="${IMAGE:-aiti/aiti:${TARGET}}"
NAME="aiti-smoke-$$"
PASS=0; FAIL=0; FAILED=()

say()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); say "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); FAILED+=("$1"); say "  ✗ $1"; }
check(){ local desc="$1" want="$2" got="$3"; if [ "$got" = "$want" ]; then ok "$desc"; else bad "$desc (expected $want, got $got)"; fi; }
http() { local t="${2:-6}"; docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' --max-time "$t" "$1" 2>/dev/null; }

say "════ aiti image smoke · target=$TARGET image=$IMAGE ${PLATFORM:+platform=$PLATFORM} · $(date '+%F %T') ════"
docker rm -f "$NAME" >/dev/null 2>&1

# ── container start (full automatically adds gui/asr/term to cover every phase) ──
PHASES="piweb,bridge"
if [ "$TARGET" = "full" ]; then PHASES="piweb,bridge,gui,asr,term"; fi
# shellcheck disable=SC2086
docker run -d --name "$NAME" --init ${PLATFORM:+--platform "$PLATFORM"} -e "AITI_PHASES=$PHASES" "$IMAGE" >/dev/null || { say "✗ container failed to start"; exit 1; }
trap 'docker rm -f "$NAME" >/dev/null 2>&1' EXIT

# Wait for pi-web readiness (qemu/arm64 emulation starts much slower than native — poll rather than a fixed sleep)
READY_TIMEOUT="${AITI_SMOKE_READY_TIMEOUT:-90}"
for i in $(seq 1 $((READY_TIMEOUT / 3))); do
  [ "$(http http://127.0.0.1:30142/api/home)" = 200 ] && break
  sleep 3
done
sleep 18

say "── HTTP surface ──"
check "pi-web /"              200 "$(http http://127.0.0.1:30142/ 30)"   # relaxed for slow architectures on first render
check "pi-web /api/home"      200 "$(http http://127.0.0.1:30142/api/home)"
check "bridge launcher"       200 "$(http http://127.0.0.1:8777/aiti/aiti-launcher.js)"
check "PWA icon (.dockerignore regression)" 200 "$(http http://127.0.0.1:30142/icons/icon-192.png)"

say "── bridge API ──"
R=$(docker exec "$NAME" curl -s --max-time 6 -X POST http://127.0.0.1:8777/aiti/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bridge_status","arguments":{}}}' 2>/dev/null)
echo "$R" | grep -q '"isError":false' && ok "MCP tools/call bridge_status" || bad "MCP tools/call bridge_status"
R=$(docker exec "$NAME" curl -s --max-time 6 -X POST http://127.0.0.1:8777/aiti/bridge/agent/tools/call \
  -H 'Content-Type: application/json' -d '{"tool":"bridge_status"}' 2>/dev/null)
echo "$R" | grep -q '"ok":true' && ok "agent REST tools/call" || bad "agent REST tools/call"

say "── extensions & tools ──"
N=$(docker exec "$NAME" ls /opt/aiti/extensions 2>/dev/null | wc -l)
[ "$N" -ge 42 ] && ok "extension count $N ≥ 42 (incl. service-tunnels)" || bad "extension count $N < 42"
V=$(docker exec "$NAME" justget --version 2>/dev/null)
[ -n "$V" ] && ok "justget --version → $V" || bad "justget --version produced no output"
docker exec "$NAME" timeout 10 aiti-bridge --port 8799 2>&1 | grep -q "桥已启动" && ok "aiti-bridge wrapper runs directly (startup banner)" || bad "aiti-bridge wrapper"

say "── identity & security ──"
U=$(docker exec "$NAME" ps -eo user:10 | grep -c '^aiti' || true)
[ "$U" -ge 2 ] && ok "service processes run as aiti" || bad "service processes not running as aiti"
docker exec "$NAME" sudo -n true 2>/dev/null && ok "passwordless sudo" || bad "passwordless sudo"

say "── HEALTHCHECK ──"
for i in $(seq 1 12); do S=$(docker inspect "$NAME" --format '{{.State.Health.Status}}' 2>/dev/null); [ "$S" = healthy ] && break; sleep 5; done
check "HEALTHCHECK turns healthy" healthy "${S:-unknown}"

if [ "$TARGET" = "full" ]; then
  say "── full-only: GUI / CDP / ASR / term / tunnels ──"
  N=$(docker exec "$NAME" sh -c "ps -eo args | grep -cE '[X]vfb|[o]penbox|[x]11vnc|[w]ebsockify|[c]hrome'")
  [ "$N" -ge 5 ] && ok "GUI process groups: $N" || bad "GUI process groups only $N"
  check "noVNC :6080"            200 "$(http http://127.0.0.1:6080/vnc.html)"
  check "CDP :9222 /json/version" 200 "$(http http://127.0.0.1:9222/json/version)"
  check "ttyd :7681"             200 "$(http http://127.0.0.1:7681/)"
  H=$(docker exec "$NAME" curl -s --max-time 20 http://127.0.0.1:8767/health 2>/dev/null)
  echo "$H" | grep -q '"ok":true' && ok "ASR :8767 /health" || bad "ASR :8767 /health"
  for b in cloudflared ngrok frpc edge-tts; do
    docker exec "$NAME" sh -c "command -v $b >/dev/null" && ok "$b present" || bad "$b missing"
  done
  M=$(docker exec "$NAME" sh -c 'ls /opt/aiti-asr/models/models 2>/dev/null | wc -l')
  [ "$M" -ge 4 ] && ok "funasr pre-downloaded models: $M" || bad "funasr pre-downloaded models only $M"
fi

say "── wrap-up ──"
if [ "$KEEP" = "--keep" ]; then say "keeping container $NAME for manual inspection"; trap - EXIT; else docker rm -f "$NAME" >/dev/null 2>&1; fi

say "════ result: $PASS passed / $FAIL failed ════"
[ "$FAIL" -gt 0 ] && { printf 'Failures:\n'; printf '  - %s\n' "${FAILED[@]}"; }
exit "$FAIL"
