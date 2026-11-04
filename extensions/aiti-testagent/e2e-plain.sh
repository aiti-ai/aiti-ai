#!/usr/bin/env bash
# aiti-testagent e2e（普通 Java 非 Spring）：零框架适配 / code 仅类加载 / eval 新类
# 用法: ./e2e-plain.sh   退出码: 0=全过 1=有失败

set -u
APP_DIR="${APP_DIR:-/home/pi/workspace/aiti-ai/TestAgent/tests/plain-app}"
pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT_HTTP=$(pick_port)
CONF=/tmp/e2e-pl-conf
PASS=0; FAIL=0

say() { echo; echo "═══ $1 ═══"; }
check() {
  local desc="$1" cmd="$2" expect="$3"
  local out; out=$(eval "$cmd" 2>&1)
  if echo "$out" | grep -q "$expect"; then PASS=$((PASS+1)); echo "  ✅ $desc";
  else FAIL=$((FAIL+1)); echo "  ❌ $desc"; echo "      实际: $(echo "$out" | head -c 140)"; fi
}
cleanup() {
  for p in $(ps -eo pid,args | grep "PlainApp" | grep -v grep | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
  rm -rf "$CONF" ~/.cache/testagent/sessions
}
trap cleanup EXIT

[ -f "$APP_DIR/PlainApp.java" ] || { echo "缺少 $APP_DIR/PlainApp.java"; exit 1; }
(cd "$APP_DIR" && javac PlainApp.java 2>/dev/null)

cleanup; mkdir -p "$CONF"
cat > /tmp/e2e-pl-run.sh <<EOF
#!/bin/bash
cd /tmp
export TESTAGENT_ENABLE=1 TESTAGENT_HTTP_PORT=$PORT_HTTP TESTAGENT_BASEPATH= TESTAGENT_CONF=$CONF
exec /home/pi/workspace/aiti-ai/pi-web-ext/aiti-testagent/testagent-java java -cp $APP_DIR PlainApp >> /tmp/e2e-pl.log 2>&1
EOF
chmod +x /tmp/e2e-pl-run.sh; rm -f /tmp/e2e-pl.log
setsid /tmp/e2e-pl-run.sh < /dev/null &
for i in $(seq 1 30); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_HTTP/api/ping >/dev/null 2>&1 && break; done

say "非 Spring 应用（零框架污染 + code 仅加载 + eval）"
check "ping" "curl -s http://127.0.0.1:$PORT_HTTP/api/ping" '"pong":true'
printf '{"source": "package com.demo;\\npublic class NewClass {\\n    public static String hi() { return \\"hi-from-hot\\"; }\\n}"}' > /tmp/e2e-pl-code.json
check "code 仅类加载（无注册字段）" "python3 $(cd "$(dirname "$0")" && pwd)/e2e-helper.py $PORT_HTTP code /tmp/e2e-pl-code.json" '"className"'
check "eval 新类调用" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/api/eval -H 'Content-Type: application/json' -d '{\"expr\":\"com.demo.NewClass.hi()\"}'" 'hi-from-hot'
check "零 Spring 适配加载" "grep -ac '动态加载 Spring 适配' /tmp/e2e-pl.log" '0'

say "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && echo "✅ 全部通过" || echo "❌ 有失败"
exit $FAIL
