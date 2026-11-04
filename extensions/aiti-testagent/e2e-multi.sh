#!/usr/bin/env bash
# aiti-testagent e2e（多进程场景）：两个 Spring Boot 应用同时挂载 → ta_discover 发现两个 → 分别操作
# 用法: ./e2e-multi.sh   退出码: 0=全过 1=有失败

set -u
# 桥配置隔离：bridge.json（aiti-testagent 扩展桥管理写入）会让 MCP 自动走桥模式——e2e 是独立直连环境，指向不存在的文件强制直连
export TESTAGENT_BRIDGE_FILE=/tmp/e2e-1948753-no-bridge.json
APP_JAR="${APP_JAR:-/home/pi/workspace/aiti-ai/TestAgent/tests/spring-test/target/spring-test-1.0.jar}"
MCP_SERVER="${MCP_SERVER:-/home/pi/workspace/aiti-ai/pi-web-ext/aiti-testagent/mcp-testagent.cjs}"
P1_HTTP=18598; P1_APP=18104
P2_HTTP=18599; P2_APP=18105
CONF1=/tmp/e2e-multi-c1; CONF2=/tmp/e2e-multi-c2
PASS=0; FAIL=0

say() { echo; echo "═══ $1 ═══"; }
check() {
  local desc="$1" cmd="$2" expect="$3"
  local out; out=$(eval "$cmd" 2>&1)
  if echo "$out" | grep -q "$expect"; then PASS=$((PASS+1)); echo "  ✅ $desc";
  else FAIL=$((FAIL+1)); echo "  ❌ $desc"; echo "      实际: $(echo "$out" | head -c 140)"; fi
}
cleanup() {
  for p in $(ps -eo pid,args | grep "spring-test-1.0.jar --server.port=$P1_APP\|spring-test-1.0.jar --server.port=$P2_APP" | grep -v grep | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
  rm -rf "$CONF1" "$CONF2" ~/.cache/testagent/sessions
}
trap cleanup EXIT

[ -f "$APP_JAR" ] || { echo "缺少 $APP_JAR"; exit 1; }
cp /home/pi/workspace/aiti-ai/TestAgent/extensions/testagent-spring/target/testagent-spring-1.0.jar /home/pi/workspace/aiti-ai/TestAgent/TestAgent/target/ 2>/dev/null

cleanup
for i in 1 2; do
  CONF="CONF$i"; HTTP="P${i}_HTTP"; APP="P${i}_APP"
  mkdir -p "${!CONF}"
  cat > /tmp/e2e-multi-run$i.sh <<EOF
#!/bin/bash
cd /tmp
export TESTAGENT_ENABLE=1 TESTAGENT_HTTP_PORT=${!HTTP} TESTAGENT_CONF=${!CONF}
exec /home/pi/workspace/aiti-ai/pi-web-ext/aiti-testagent/testagent-java java -jar $APP_JAR --server.port=${!APP} >> /tmp/e2e-multi$i.log 2>&1
EOF
  chmod +x /tmp/e2e-multi-run$i.sh; rm -f /tmp/e2e-multi$i.log
  setsid /tmp/e2e-multi-run$i.sh < /dev/null &
done
for i in $(seq 1 50); do
  curl -s --max-time 1 http://127.0.0.1:$P1_HTTP/testagent/api/ping >/dev/null 2>&1 && curl -s --max-time 1 http://127.0.0.1:$P2_HTTP/testagent/api/ping >/dev/null 2>&1 && break
  sleep 1
done
for i in $(seq 1 8); do
  curl -s --max-time 1 http://127.0.0.1:$P1_APP/existing >/dev/null 2>&1 && curl -s --max-time 1 http://127.0.0.1:$P2_APP/existing >/dev/null 2>&1 && break
  sleep 1
done

say "多进程并存（发现机制 + 分别操作）"
check "应用1 就绪" "curl -s http://127.0.0.1:$P1_APP/existing" 'existing-controller'
check "应用2 就绪" "curl -s http://127.0.0.1:$P2_APP/existing" 'existing-controller'
check "agent1 ping" "curl -s http://127.0.0.1:$P1_HTTP/testagent/api/ping" '"pong":true'
check "agent2 ping" "curl -s http://127.0.0.1:$P2_HTTP/testagent/api/ping" '"pong":true'
check "sessions 两个" "ls ~/.cache/testagent/sessions/ | grep -c json" '2'
printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ta_discover","arguments":{}}}' > /tmp/e2e-multi-discover.json
DISC=$(node $MCP_SERVER < /tmp/e2e-multi-discover.json 2>&1)
check "ta_discover 含两端口" "node $MCP_SERVER < /tmp/e2e-multi-discover.json | grep -oE '1859[89]' | sort -u | wc -l" "2"
# 分别操作：ta_eval 各命中不同进程
printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ta_eval","arguments":{"expr":"System.getProperty(\\"testagent.httpPort\\")","port":%d}}}' "$P1_HTTP" > /tmp/e2e-multi-eval1.json
printf '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ta_eval","arguments":{"expr":"System.getProperty(\\"testagent.httpPort\\")","port":%d}}}' "$P2_HTTP" > /tmp/e2e-multi-eval2.json
check "操作进程1" "node $MCP_SERVER < /tmp/e2e-multi-eval1.json" "$P1_HTTP"
check "操作进程2" "node $MCP_SERVER < /tmp/e2e-multi-eval2.json" "$P2_HTTP"

say "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && echo "✅ 全部通过" || echo "❌ 有失败"
exit $FAIL
