#!/usr/bin/env bash
# aiti-testagent e2e（attach 场景）：无 agent 启动 → AttachTool attach → 新建 controller/替换全链路
# 用法: ./e2e-attach.sh   退出码: 0=全过 1=有失败

set -u
APP_JAR="${APP_JAR:-/home/pi/workspace/aiti-ai/TestAgent/tests/spring-test/target/spring-test-1.0.jar}"
AGENT_JAR="${TESTAGENT_JAR:-/home/pi/workspace/aiti-ai/TestAgent/TestAgent/target/testagent-1.0.jar}"
ATTACH_CP="${ATTACH_CP:-/home/pi/workspace/aiti-ai/pi-web-ext/aiti-testagent/attach-tool}"
pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT_HTTP=$(pick_port)          # attach 后 agent 默认端口
PORT_APP=$(pick_port)
CONF=/tmp/e2e-att-conf
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

[ -f "$APP_JAR" ] && [ -f "$AGENT_JAR" ] || { echo "缺少应用/agent jar"; exit 1; }
cp /home/pi/workspace/aiti-ai/TestAgent/extensions/testagent-spring/target/testagent-spring-1.0.jar "$(dirname "$AGENT_JAR")/" 2>/dev/null

# 无 agent 启动应用
cleanup; mkdir -p "$CONF"
cat > /tmp/e2e-att-run.sh <<EOF
#!/bin/bash
cd /tmp; echo \$\$ > /tmp/e2e-att.pid
exec java -jar $APP_JAR --server.port=$PORT_APP >> /tmp/e2e-att.log 2>&1
EOF
chmod +x /tmp/e2e-att-run.sh; rm -f /tmp/e2e-att.log
setsid /tmp/e2e-att-run.sh < /dev/null &
for i in $(seq 1 40); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_APP/existing >/dev/null 2>&1 && break; done

say "attach 场景（无 agent 启动 → attach → 热更新全链路）"
check "应用无 agent 正常" "curl -s http://127.0.0.1:$PORT_APP/existing" 'existing-controller'
check "attach 前 API 不可用" "curl -s --max-time 1 http://127.0.0.1:$PORT_HTTP/api/ping | head -c 20" ''

APP_PID=$(cat /tmp/e2e-att.pid)
check "attach 执行" "java --add-modules jdk.attach -cp $ATTACH_CP AttachTool $APP_PID $AGENT_JAR 'conf=$CONF,testagent.basePath='" 'attached'
for i in $(seq 1 20); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_HTTP/api/ping >/dev/null 2>&1 && break; done
check "attach 后 API 可用" "curl -s http://127.0.0.1:$PORT_HTTP/api/ping" '"pong":true'
check "attach 后 session 注册" "ls ~/.cache/testagent/sessions/ | grep -c json" '1'

say "attach 后热更新全链路"
printf '{"source": "package com.demo;\\nimport org.springframework.web.bind.annotation.*;\\n@RestController\\npublic class AttCtl {\\n    @GetMapping(\\"/att\\")\\n    public String a() { return \\"att-live\\"; }\\n}"}' > /tmp/e2e-att-ctl.json
check "attach 后新建 controller" "python3 $(cd "$(dirname "$0")" && pwd)/e2e-helper.py $PORT_HTTP code /tmp/e2e-att-ctl.json" '"/att"'
sleep 1
check "新建 controller 生效" "curl -s http://127.0.0.1:$PORT_APP/att" 'att-live'
printf '{"source": "package com.demo;\\nimport org.springframework.web.bind.annotation.*;\\n@RestController\\npublic class ExistingController {\\n    @GetMapping(\\"/existing\\")\\n    public String existing() { return \\"att-replaced\\"; }\\n}"}' > /tmp/e2e-att-repl.json
sleep 3
say "attach 场景更新路径（replaceBean——绕开 retransform 限制）"
printf '{"source": "package com.demo;\\npublic interface ISvc { String who(); }"}' > /tmp/e2e-att-isvc.json
printf '{"source": "package com.demo;\\nimport org.springframework.stereotype.Service;\\n@Service\\npublic class SvcV1 implements ISvc { public String who() { return \\"V1\\"; } }"}' > /tmp/e2e-att-v1.json
printf '{"source": "package com.demo;\\nimport org.springframework.web.bind.annotation.*;\\n@RestController\\npublic class Svcc { private final ISvc s; public Svcc(ISvc s){this.s=s;} @GetMapping(\\"/svc\\") public String g(){ return s.who(); } }"}' > /tmp/e2e-att-svcc.json
printf '{"source": "package com.demo;\\nimport org.springframework.stereotype.Service;\\n@Service\\npublic class SvcV2 implements ISvc { public String who(){ return \\"V2\\"; } }", "beanName": "svcV1"}' > /tmp/e2e-att-v2.json
check "attach 注册接口" "python3 $(cd "$(dirname "$0")" && pwd)/e2e-helper.py $PORT_HTTP bean /tmp/e2e-att-isvc.json" '"type":"interface"'
check "attach 注册实现V1" "python3 $(cd "$(dirname "$0")" && pwd)/e2e-helper.py $PORT_HTTP bean /tmp/e2e-att-v1.json" 'svcV1'
check "attach 新建controller注入" "python3 $(cd "$(dirname "$0")" && pwd)/e2e-helper.py $PORT_HTTP code /tmp/e2e-att-svcc.json" '"/svc"'
sleep 1
check "attach V1 生效" "curl -s http://127.0.0.1:$PORT_APP/svc" 'V1'
check "attach replaceBean V2" "python3 $(cd "$(dirname "$0")" && pwd)/e2e-helper.py $PORT_HTTP bean_replace /tmp/e2e-att-v2.json" 'rebuiltControllers'
sleep 2
check "attach V2 生效（更新路径）" "curl -s http://127.0.0.1:$PORT_APP/svc" 'V2'

check "attach 幂等（再次 attach 跳过）" "java --add-modules jdk.attach -cp $ATTACH_CP AttachTool $APP_PID $AGENT_JAR 'conf=$CONF,testagent.basePath=' 2>&1; grep -ac 'already attached' /tmp/e2e-att.log" '1'

say "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && echo "✅ 全部通过" || echo "❌ 有失败"
exit $FAIL
