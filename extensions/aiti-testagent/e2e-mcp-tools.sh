#!/usr/bin/env bash
# aiti-testagent e2e（MCP 启动工具）：ta_run 启动应用 + ta_discover 发现 + ta_ping 验证
# 用法: ./e2e-mcp-tools.sh   退出码: 0=全过 1=有失败

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
APP_JAR="${APP_JAR:-$ROOT/TestAgent/tests/spring-test/target/spring-test-1.0.jar}"
MCP_SERVER="${MCP_SERVER:-$HERE/mcp-testagent.cjs}"
pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT_HTTP=$(pick_port)
PORT_APP=$(pick_port)
PASS=0; FAIL=0

say() { echo; echo "═══ $1 ═══"; }
check() {
  local desc="$1" cmd="$2" expect="$3"
  local out; out=$(eval "$cmd" 2>&1)
  if echo "$out" | grep -q "$expect"; then PASS=$((PASS+1)); echo "  ✅ $desc";
  else FAIL=$((FAIL+1)); echo "  ❌ $desc"; echo "      实际: $(echo "$out" | head -c 140)"; fi
}
cleanup() {
  for p in $(ps -eo pid,args | grep "spring-test-1.0.jar --server.port=$PORT_APP" | grep -v grep | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
  rm -rf ~/.cache/testagent/sessions /tmp/testagent-app-*.log
}
trap cleanup EXIT

[ -f "$APP_JAR" ] || { echo "缺少 $APP_JAR"; exit 1; }
cp $ROOT/TestAgent/extensions/testagent-spring/target/testagent-spring-1.0.jar $ROOT/TestAgent/TestAgent/target/ 2>/dev/null

say "MCP 启动工具（ta_run 启动 / ta_discover 发现）"
# ta_run 启动应用（httpPort=18596）
printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ta_run","arguments":{"app":"%s","args":["--server.port=%d"],"httpPort":%d}}}' "$APP_JAR" "$PORT_APP" "$PORT_HTTP" > /tmp/e2e-mcpt-run.json
RUN=$(node $MCP_SERVER < /tmp/e2e-mcpt-run.json 2>&1)
# 等应用 + agent 就绪
for i in $(seq 1 60); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_HTTP/api/ping >/dev/null 2>&1 && break; done
# 应用就绪硬门（120s）：短窗口纯竞态（ta_run 冷启同 e2e-mcp.sh 破案口径）
APP_READY=0
for i in $(seq 1 120); do sleep 1; R=$(curl -s --max-time 2 http://127.0.0.1:$PORT_APP/existing 2>/dev/null); [ -n "$R" ] && { APP_READY=1; break; }; done
[ "$APP_READY" = "1" ] || { echo "✗ ta_run 应用 120s 未就绪"; exit 1; }
check "ta_run 启动的 agent 可用" "curl -s http://127.0.0.1:$PORT_HTTP/testagent/api/ping" '"pong":true'
check "ta_run 启动的应用 HTTP 生效" "curl -s http://127.0.0.1:$PORT_APP/existing" 'existing-controller'

say "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && echo "✅ 全部通过" || echo "❌ 有失败"
exit $FAIL
