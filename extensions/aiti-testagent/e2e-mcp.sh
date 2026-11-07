#!/usr/bin/env bash
# aiti-testagent e2e（MCP 协议层）：initialize/tools/list/tools/call（JSON-RPC over stdio）
# 用法: ./e2e-mcp.sh   退出码: 0=全过 1=有失败

set -u
# 桥配置隔离：bridge.json（aiti-testagent 扩展桥管理写入）会让 MCP 自动走桥模式——e2e 是独立直连环境，指向不存在的文件强制直连
export TESTAGENT_BRIDGE_FILE=/tmp/e2e-1948753-no-bridge.json
APP_JAR="${APP_JAR:-/home/pi/workspace/pi-work/TestAgent/tests/spring-test/target/spring-test-1.0.jar}"
MCP_SERVER="${MCP_SERVER:-/home/pi/workspace/pi-work/pi-web-ext/aiti-testagent/mcp-testagent.cjs}"
pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT_HTTP=$(pick_port)
PORT_APP=$(pick_port)
CONF=/tmp/e2e-mcp-conf
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
  rm -rf "$CONF" ~/.cache/testagent/sessions /tmp/e2e-mcp-*.json
}
trap cleanup EXIT

[ -f "$APP_JAR" ] || { echo "缺少 $APP_JAR"; exit 1; }
cp /home/pi/workspace/pi-work/TestAgent/extensions/testagent-spring/target/testagent-spring-1.0.jar /home/pi/workspace/pi-work/TestAgent/TestAgent/target/ 2>/dev/null

cleanup; mkdir -p "$CONF"
cat > /tmp/e2e-mcp-run.sh <<EOF
#!/bin/bash
cd /tmp
export TESTAGENT_ENABLE=1 TESTAGENT_HTTP_PORT=$PORT_HTTP TESTAGENT_CONF=$CONF
exec /home/pi/workspace/pi-work/pi-web-ext/aiti-testagent/testagent-java java -jar $APP_JAR --server.port=$PORT_APP >> /tmp/e2e-mcp.log 2>&1
EOF
chmod +x /tmp/e2e-mcp-run.sh; rm -f /tmp/e2e-mcp.log
setsid /tmp/e2e-mcp-run.sh < /dev/null &
for i in $(seq 1 50); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_HTTP/api/ping >/dev/null 2>&1 && break; done
# 应用就绪硬门（2026-11-06 破案）：spring-test 带 Quartz 启动可达 ~90s，原 8s 窗口纯竞态——
# 日志停在 Quartz 初始化、Tomcat 未绑端口，ta_ping/ta_discover 只打 agent（JVM 早期就绪）照样绿，
# ta_code/curl 跑在半启动应用上 → 空断言。120s 轮询 + 硬门，超时明确报错。
APP_READY=0
for i in $(seq 1 120); do
  sleep 1
  R=$(curl -s --max-time 2 http://127.0.0.1:$PORT_APP/existing 2>/dev/null)
  if [ -n "$R" ]; then APP_READY=1; break; fi
done
[ "$APP_READY" = "1" ] || { echo "✗ spring-test 应用 120s 未就绪（看 /tmp/e2e-mcp.log 尾部）"; exit 1; }

say "MCP 协议（initialize/tools/list/tools/call）"
# 用 printf 生成 JSON-RPC 消息（避 bash 嵌套转义）
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' > /tmp/e2e-mcp-1.json
printf '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' > /tmp/e2e-mcp-2.json
printf '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ta_ping","arguments":{"port":%d}}}' "$PORT_HTTP" > /tmp/e2e-mcp-3.json
printf '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ta_eval","arguments":{"expr":"1+1","port":%d}}}' "$PORT_HTTP" > /tmp/e2e-mcp-4.json
printf '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"ta_metrics","arguments":{"port":%d}}}' "$PORT_HTTP" > /tmp/e2e-mcp-5.json
printf '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"ta_discover","arguments":{}}}' > /tmp/e2e-mcp-6.json
printf '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"ta_code","arguments":{"port":%d,"source":"package com.demo;\\nimport org.springframework.web.bind.annotation.*;\\n@RestController\\npublic class McpCtl {\\n    @GetMapping(\\"/mcp\\")\\n    public String m() { return \\"mcp-ok\\"; }\\n}"}}}' "$PORT_HTTP" > /tmp/e2e-mcp-7.json

check "initialize" "node $MCP_SERVER < /tmp/e2e-mcp-1.json" 'protocolVersion'
check "tools/list 含 ta_code" "node $MCP_SERVER < /tmp/e2e-mcp-2.json" 'ta_code'
check "tools/list 含 ta_download" "node $MCP_SERVER < /tmp/e2e-mcp-2.json" 'ta_download'
check "ta_ping" "node $MCP_SERVER < /tmp/e2e-mcp-3.json" 'pong'
check "ta_metrics" "node $MCP_SERVER < /tmp/e2e-mcp-5.json" 'heapUsedMB'
check "ta_discover" "node $MCP_SERVER < /tmp/e2e-mcp-6.json" 'attached'
# ta_download（S8 AI 闭环）：meta 元数据 + 真下载字节一致
printf '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"ta_download","arguments":{"port":%d,"path":"%s","meta":true}}}' "$PORT_HTTP" "$APP_JAR" > /tmp/e2e-mcp-8.json
check "ta_download meta 元数据" "node $MCP_SERVER < /tmp/e2e-mcp-8.json" 'sizeBytes'
printf '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"ta_download","arguments":{"port":%d,"path":"%s"}}}' "$PORT_HTTP" "$APP_JAR" > /tmp/e2e-mcp-9.json
node $MCP_SERVER < /tmp/e2e-mcp-9.json > /tmp/e2e-mcp-9.out 2>/dev/null
python3 -c "
import json,os,sys
inner=json.loads(json.loads(open('/tmp/e2e-mcp-9.out').read())['result']['content'][0]['text'])
d=inner.get('data',{})
real=os.path.getsize('$APP_JAR')
sys.exit(0 if d.get('ok') and d.get('sizeBytes')==real and os.path.exists(d.get('savedTo','')) else 1)" \
  && { PASS=$((PASS+1)); echo "  ✅ ta_download 真下载字节一致"; } || { FAIL=$((FAIL+1)); echo "  ❌ ta_download 下载字节不一致（$(head -c 120 /tmp/e2e-mcp-9.out)）"; }
node $MCP_SERVER < /tmp/e2e-mcp-7.json > /dev/null 2>&1   # ta_code：执行（注册 controller，结果由 HTTP 断言验证）
sleep 1
check "MCP 新建 controller HTTP 生效" "curl -s http://127.0.0.1:$PORT_APP/mcp" 'mcp-ok'

say "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && echo "✅ 全部通过" || echo "❌ 有失败"
exit $FAIL
