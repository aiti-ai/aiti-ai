#!/usr/bin/env bash
# aiti-testagent e2e（Boot 2 兼容）：新建 controller（patternParser 修复）/ 替换 / Bean 注册
# 用法: ./e2e-spring2.sh   退出码: 0=全过 1=有失败

set -u
APP_JAR="${APP_JAR:-/home/pi/workspace/aiti-ai/TestAgent/tests/spring2-test/target/spring2-test-1.0.jar}"
pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT_HTTP=$(pick_port)
PORT_APP=$(pick_port)
CONF=/tmp/e2e-s2-conf
HERE="$(cd "$(dirname "$0")" && pwd)"
PASS=0; FAIL=0

say() { echo; echo "═══ $1 ═══"; }
check() {
  local desc="$1" cmd="$2" expect="$3"
  local out; out=$(eval "$cmd" 2>&1)
  if echo "$out" | grep -q "$expect"; then PASS=$((PASS+1)); echo "  ✅ $desc";
  else FAIL=$((FAIL+1)); echo "  ❌ $desc"; echo "      实际: $(echo "$out" | head -c 140)"; fi
}
cleanup() {
  for p in $(ps -eo pid,args | grep "spring2-test-1.0.jar --server.port=$PORT_APP" | grep -v grep | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
  rm -rf "$CONF" ~/.cache/testagent/sessions
}
trap cleanup EXIT

[ -f "$APP_JAR" ] || { echo "缺少 $APP_JAR（cd tests/spring2-test && mvn package）"; exit 1; }
# 确保 spring 适配 jar（防 target 清理丢失）
cp /home/pi/workspace/aiti-ai/TestAgent/extensions/testagent-spring/target/testagent-spring-1.0.jar /home/pi/workspace/aiti-ai/TestAgent/TestAgent/target/ 2>/dev/null

cleanup; mkdir -p "$CONF"
cat > /tmp/e2e-s2-run.sh <<EOF
#!/bin/bash
cd /tmp
export TESTAGENT_ENABLE=1 TESTAGENT_HTTP_PORT=$PORT_HTTP TESTAGENT_BASEPATH= TESTAGENT_CONF=$CONF
exec /home/pi/workspace/aiti-ai/pi-web-ext/aiti-testagent/testagent-java java -jar $APP_JAR --server.port=$PORT_APP >> /tmp/e2e-s2.log 2>&1
EOF
chmod +x /tmp/e2e-s2-run.sh; rm -f /tmp/e2e-s2.log
setsid /tmp/e2e-s2-run.sh < /dev/null &
for i in $(seq 1 50); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_HTTP/api/ping >/dev/null 2>&1 && break; done
for i in $(seq 1 20); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_APP/hello2 >/dev/null 2>&1 && break; done

say "Boot 2 基础 + 新建 controller（patternParser 修复）"
check "hello2 正常" "curl -s http://127.0.0.1:$PORT_APP/hello2" 'spring2-original'
printf '{"source": "package com.demo2;\\nimport org.springframework.web.bind.annotation.*;\\n@RestController\\npublic class NewCtl {\\n    @GetMapping(\\"/new2\\")\\n    public String n(@RequestParam(defaultValue=\\"w\\") String who) { return \\"new2-\\" + who; }\\n}"}' > /tmp/e2e-s2-ctl.json
check "新建 controller 注册" "python3 $HERE/e2e-helper.py $PORT_HTTP code /tmp/e2e-s2-ctl.json" '"/new2"'
sleep 1
check "新建 controller 生效（修复前 500）" "curl -s 'http://127.0.0.1:$PORT_APP/new2?who=boot2'" 'new2-boot2'

say "Boot 2 替换 + Bean"
cat > /tmp/e2e-s2-repl.json <<'JSON'
{"source": "package com.demo2;\nimport org.springframework.beans.factory.annotation.Autowired;\nimport org.springframework.jdbc.core.JdbcTemplate;\nimport org.springframework.web.bind.annotation.*;\nimport javax.annotation.PostConstruct;\n@RestController\npublic class Ctl2 {\n    @Autowired\n    JdbcTemplate jdbc;\n    @PostConstruct\n    void init() {\n        jdbc.execute(\"CREATE TABLE IF NOT EXISTS users2 (id INT, name VARCHAR(50), age INT)\");\n        jdbc.update(\"DELETE FROM users2\");\n        jdbc.update(\"INSERT INTO users2 VALUES (1,'alice',30),(2,'bob',25)\");\n    }\n\n    @GetMapping(\"/hello2\")\n    public String hello() { return \"boot2-replaced\"; }\n\n    @GetMapping(\"/jdbc2\")\n    public java.util.List<java.util.Map<String, Object>> jdbc2() {\n        return jdbc.queryForList(\"SELECT id, name, age FROM users2 ORDER BY id\");\n    }\n}"}
JSON
check "整类替换" "python3 $HERE/e2e-helper.py $PORT_HTTP code /tmp/e2e-s2-repl.json" 'replaced'
sleep 3
check "替换生效" "curl -s http://127.0.0.1:$PORT_APP/hello2" 'boot2-replaced'
printf '{"source": "package com.demo2;\\nimport org.springframework.stereotype.Service;\\n@Service\\npublic class Svc2 { public String ping() { return \\"svc2-pong\\"; } }"}' > /tmp/e2e-s2-svc.json
check "Bean 注册" "python3 $HERE/e2e-helper.py $PORT_HTTP bean /tmp/e2e-s2-svc.json" 'svc2'

say "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && echo "✅ 全部通过" || echo "❌ 有失败"
exit $FAIL
