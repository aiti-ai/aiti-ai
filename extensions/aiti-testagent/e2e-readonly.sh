#!/usr/bin/env bash
# aiti-testagent e2e（eval readonly 安全模式）：危险操作拦截 / code 拒绝 / 正常表达式可用
# 用法: ./e2e-readonly.sh   退出码: 0=全过 1=有失败

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
APP_JAR="${APP_JAR:-$ROOT/TestAgent/tests/spring-test/target/spring-test-1.0.jar}"
pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT_HTTP=$(pick_port)
PORT_APP=$(pick_port)
CONF=/tmp/e2e-ro-conf
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
  rm -rf "$CONF" ~/.cache/testagent/sessions
}
trap cleanup EXIT

[ -f "$APP_JAR" ] || { echo "缺少 $APP_JAR"; exit 1; }
cp $ROOT/TestAgent/extensions/testagent-spring/target/testagent-spring-1.0.jar $ROOT/TestAgent/TestAgent/target/ 2>/dev/null

cleanup; mkdir -p "$CONF"
cat > /tmp/e2e-ro-run.sh <<EOF
#!/bin/bash
cd /tmp
export TESTAGENT_ENABLE=1 TESTAGENT_HTTP_PORT=$PORT_HTTP TESTAGENT_BASEPATH= TESTAGENT_CONF=$CONF TESTAGENT_EXTRA="-Dtestagent.evalMode=readonly"
exec $HERE/testagent-java java -jar $APP_JAR --server.port=$PORT_APP >> /tmp/e2e-ro.log 2>&1
EOF
chmod +x /tmp/e2e-ro-run.sh; rm -f /tmp/e2e-ro.log
setsid /tmp/e2e-ro-run.sh < /dev/null &
for i in $(seq 1 50); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_HTTP/api/ping >/dev/null 2>&1 && break; done
for i in $(seq 1 8); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_APP/existing >/dev/null 2>&1 && break; done

say "eval readonly 安全模式"
check "正常表达式可用" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/api/eval -H 'Content-Type: application/json' -d '{\"expr\":\"1+1\"}'" '"result":"2"'
check "文件写入拦截" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/api/eval -H 'Content-Type: application/json' -d '{\"expr\":\"java.nio.file.Files.write(java.nio.file.Paths.get(\\\"/tmp/x\\\"),\\\"y\\\".getBytes())\"}'" 'readonly.*拒绝'
check "code 多语句拒绝" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/api/eval -H 'Content-Type: application/json' -d '{\"code\":\"return 1;\"}'" 'readonly.*拒绝.*code'
check "exec 拦截" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/api/eval -H 'Content-Type: application/json' -d '{\"expr\":\"Runtime.getRuntime().exec(\\\"ls\\\")\"}'" 'readonly.*拒绝'
check "文件未实际写入" "ls /tmp/ro-write-test 2>/dev/null | wc -l" '0'

say "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && echo "✅ 全部通过" || echo "❌ 有失败"
exit $FAIL
