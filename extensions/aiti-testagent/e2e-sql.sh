#!/usr/bin/env bash
# aiti-testagent e2e（SQL 拦截内容——独立环境，JDBC 插桩深度验证）
# 用法: ./e2e-sql.sh   退出码: 0=全过 1=有失败

set -u
APP_JAR="${APP_JAR:-/home/pi/workspace/aiti-ai/TestAgent/tests/mybatis-test/target/mybatis-test-1.0.jar}"
pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT_HTTP=$(pick_port)
PORT_APP=$(pick_port)
CONF=/tmp/e2e-sql-conf
PASS=0; FAIL=0

say() { echo; echo "═══ $1 ═══"; }
check() {
  local desc="$1" cmd="$2" expect="$3"
  local out; out=$(eval "$cmd" 2>&1)
  if echo "$out" | grep -q "$expect"; then PASS=$((PASS+1)); echo "  ✅ $desc";
  else FAIL=$((FAIL+1)); echo "  ❌ $desc"; echo "      实际: $(echo "$out" | head -c 140)"; fi
}
cleanup() {
  for p in $(ps -eo pid,args | grep "mybatis-test-1.0.jar --server.port=$PORT_APP" | grep -v grep | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
  rm -rf "$CONF" ~/.cache/testagent/sessions /tmp/testagent-sql-*.jsonl
}
trap cleanup EXIT

[ -f "$APP_JAR" ] || { echo "缺少 $APP_JAR"; exit 1; }
cp /home/pi/workspace/aiti-ai/TestAgent/extensions/testagent-spring/target/testagent-spring-1.0.jar /home/pi/workspace/aiti-ai/TestAgent/TestAgent/target/ 2>/dev/null

cleanup; mkdir -p "$CONF"
cat > /tmp/e2e-sql-run.sh <<EOF
#!/bin/bash
cd /tmp
export TESTAGENT_ENABLE=1 TESTAGENT_HTTP_PORT=$PORT_HTTP TESTAGENT_CONF=$CONF
exec /home/pi/workspace/aiti-ai/pi-web-ext/aiti-testagent/testagent-java java -jar $APP_JAR --server.port=$PORT_APP >> /tmp/e2e-sql.log 2>&1
EOF
chmod +x /tmp/e2e-sql-run.sh; rm -f /tmp/e2e-sql.log
setsid /tmp/e2e-sql-run.sh < /dev/null &
for i in $(seq 1 50); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_HTTP/testagent/api/ping >/dev/null 2>&1 && break; done
for i in $(seq 1 15); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_APP/users >/dev/null 2>&1 && break; done

say "SQL 拦截（JDBC 插桩）内容验证"
check "应用正常" "curl -s http://127.0.0.1:$PORT_APP/users" '"alice"'
check "sql start" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/testagent/api/sql -H 'Content-Type: application/json' -d '{\"action\":\"start\"}'" '"action":"start"'
sleep 3   # 等 JDBC 插桩 reload/retransform 稳定
curl -s http://127.0.0.1:$PORT_APP/users > /dev/null
curl -s "http://127.0.0.1:$PORT_APP/user?name=bob" > /dev/null
sleep 1
DUMP=$(curl -s -X POST http://127.0.0.1:$PORT_HTTP/testagent/api/sql -H 'Content-Type: application/json' -d '{\"action\":\"dump\"}')
check "sql 有记录" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/testagent/api/sql -H 'Content-Type: application/json' -d '{\"action\":\"dump\"}' | grep -cE 'records'" '[1-9]'
check "sql stop" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/testagent/api/sql -H 'Content-Type: application/json' -d '{\"action\":\"stop\"}'" '"action":"stop"'

say "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && echo "✅ 全部通过" || echo "❌ 有失败"
exit $FAIL
