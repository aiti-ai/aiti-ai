#!/usr/bin/env bash
# smoke.sh —— aiti 镜像自动化冒烟套件（测试报告 docs/aiti-docker-test-report.md 的可重复执行版）
# 用法：
#   ./docker/scripts/smoke.sh core            # 冒烟 core（默认）
#   ./docker/scripts/smoke.sh full            # 冒烟 full（含 GUI/ASR/term，必含 core 检查）
#   ./docker/scripts/smoke.sh full --keep     # 通过后保留容器人工复查
#   ./docker/scripts/smoke.sh core --platform linux/arm64 --image aiti/aiti:core-arm64
# 机制：起一次性容器（不发布宿主端口，规避与本机 pi-web-dev/aiti-bridge 冲突），
#       全部探测经 docker exec 在容器内 curl/python 完成。退出码 = 失败项数（0=全绿）。
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
check(){ local desc="$1" want="$2" got="$3"; if [ "$got" = "$want" ]; then ok "$desc"; else bad "$desc（期望 $want 实得 $got）"; fi; }
http() { local t="${2:-6}"; docker exec "$NAME" curl -s -o /dev/null -w '%{http_code}' --max-time "$t" "$1" 2>/dev/null; }

say "════ aiti 镜像冒烟 · target=$TARGET image=$IMAGE ${PLATFORM:+platform=$PLATFORM} · $(date '+%F %T') ════"
docker rm -f "$NAME" >/dev/null 2>&1

# ── 容器启动（full 自动带上 gui/asr/term 以覆盖全部 phase）──
PHASES="piweb,bridge"
if [ "$TARGET" = "full" ]; then PHASES="piweb,bridge,gui,asr,term"; fi
# shellcheck disable=SC2086
docker run -d --name "$NAME" --init ${PLATFORM:+--platform "$PLATFORM"} -e "AITI_PHASES=$PHASES" "$IMAGE" >/dev/null || { say "✗ 容器启动失败"; exit 1; }
trap 'docker rm -f "$NAME" >/dev/null 2>&1' EXIT

# 等待 pi-web 就绪（qemu/arm64 模拟启动显著慢于原生——轮询而非定长 sleep）
READY_TIMEOUT="${AITI_SMOKE_READY_TIMEOUT:-90}"
for i in $(seq 1 $((READY_TIMEOUT / 3))); do
  [ "$(http http://127.0.0.1:30142/api/home)" = 200 ] && break
  sleep 3
done
sleep 18

say "── HTTP 面 ──"
check "pi-web /"              200 "$(http http://127.0.0.1:30142/ 30)"   # 首次渲染慢架构下放宽
check "pi-web /api/home"      200 "$(http http://127.0.0.1:30142/api/home)"
check "bridge launcher"       200 "$(http http://127.0.0.1:8777/aiti/aiti-launcher.js)"
check "PWA icon（.dockerignore 回归）" 200 "$(http http://127.0.0.1:30142/icons/icon-192.png)"

say "── 桥 API ──"
R=$(docker exec "$NAME" curl -s --max-time 6 -X POST http://127.0.0.1:8777/aiti/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bridge_status","arguments":{}}}' 2>/dev/null)
echo "$R" | grep -q '"isError":false' && ok "MCP tools/call bridge_status" || bad "MCP tools/call bridge_status"
R=$(docker exec "$NAME" curl -s --max-time 6 -X POST http://127.0.0.1:8777/aiti/bridge/agent/tools/call \
  -H 'Content-Type: application/json' -d '{"tool":"bridge_status"}' 2>/dev/null)
echo "$R" | grep -q '"ok":true' && ok "agent REST tools/call" || bad "agent REST tools/call"

say "── 扩展与工具 ──"
N=$(docker exec "$NAME" ls /opt/aiti/extensions 2>/dev/null | wc -l)
[ "$N" -ge 42 ] && ok "扩展数 $N ≥ 42（含 service-tunnels）" || bad "扩展数 $N < 42"
V=$(docker exec "$NAME" justget --version 2>/dev/null)
[ -n "$V" ] && ok "justget --version → $V" || bad "justget --version 无输出"
docker exec "$NAME" timeout 10 aiti-bridge --port 8799 2>&1 | grep -q "桥已启动" && ok "aiti-bridge wrapper 可直跑（启动 banner）" || bad "aiti-bridge wrapper"

say "── 身份与安全 ──"
U=$(docker exec "$NAME" ps -eo user:10 | grep -c '^aiti' || true)
[ "$U" -ge 2 ] && ok "服务进程以 aiti 运行" || bad "服务进程非 aiti"
docker exec "$NAME" sudo -n true 2>/dev/null && ok "sudo 免密" || bad "sudo 免密"

say "── HEALTHCHECK ──"
for i in $(seq 1 12); do S=$(docker inspect "$NAME" --format '{{.State.Health.Status}}' 2>/dev/null); [ "$S" = healthy ] && break; sleep 5; done
check "HEALTHCHECK 转 healthy" healthy "${S:-unknown}"

if [ "$TARGET" = "full" ]; then
  say "── full 专属：GUI / CDP / ASR / term / 隧道 ──"
  N=$(docker exec "$NAME" sh -c "ps -eo args | grep -cE '[X]vfb|[o]penbox|[x]11vnc|[w]ebsockify|[c]hrome'")
  [ "$N" -ge 5 ] && ok "GUI 进程组 $N 个" || bad "GUI 进程组仅 $N 个"
  check "noVNC :6080"            200 "$(http http://127.0.0.1:6080/vnc.html)"
  check "CDP :9222 /json/version" 200 "$(http http://127.0.0.1:9222/json/version)"
  check "ttyd :7681"             200 "$(http http://127.0.0.1:7681/)"
  H=$(docker exec "$NAME" curl -s --max-time 20 http://127.0.0.1:8767/health 2>/dev/null)
  echo "$H" | grep -q '"ok":true' && ok "ASR :8767 /health" || bad "ASR :8767 /health"
  for b in cloudflared ngrok frpc edge-tts; do
    docker exec "$NAME" sh -c "command -v $b >/dev/null" && ok "$b 就位" || bad "$b 缺失"
  done
  M=$(docker exec "$NAME" sh -c 'ls /opt/aiti-asr/models/models 2>/dev/null | wc -l')
  [ "$M" -ge 4 ] && ok "funasr 预下载模型 $M 件" || bad "funasr 预下载模型仅 $M 件"
fi

say "── 收尾 ──"
if [ "$KEEP" = "--keep" ]; then say "保留容器 $NAME 供人工复查"; trap - EXIT; else docker rm -f "$NAME" >/dev/null 2>&1; fi

say "════ 结果：$PASS 通过 / $FAIL 失败 ════"
[ "$FAIL" -gt 0 ] && { printf '失败项：\n'; printf '  - %s\n' "${FAILED[@]}"; }
exit "$FAIL"
