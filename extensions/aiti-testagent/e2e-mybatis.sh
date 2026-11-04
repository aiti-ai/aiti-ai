#!/usr/bin/env bash
# aiti-testagent e2e（MyBatis 场景）：XML 热更新 / SQL 拦截（JDBC 插桩）/ classwatch 自动热加载
# 用法: ./e2e-mybatis.sh   退出码: 0=全过 1=有失败

set -u
APP_JAR="${APP_JAR:-/home/pi/workspace/pi-work/TestAgent/tests/mybatis-test/target/mybatis-test-1.0.jar}"
CLASSES_DIR="${CLASSES_DIR:-/home/pi/workspace/pi-work/TestAgent/tests/mybatis-test/target/classes}"
pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT_HTTP=$(pick_port)
PORT_APP=$(pick_port)
CONF=/tmp/e2e-mb-conf
HERE="$(cd "$(dirname "$0")" && pwd)"
PASS=0; FAIL=0

say() { echo; echo "═══ $1 ═══"; }
check() { # check "描述" "命令" "期望子串"
  local desc="$1" cmd="$2" expect="$3"
  local out; out=$(eval "$cmd" 2>&1)
  if echo "$out" | grep -q "$expect"; then PASS=$((PASS+1)); echo "  ✅ $desc";
  else FAIL=$((FAIL+1)); echo "  ❌ $desc"; echo "      实际: $(echo "$out" | head -c 140)"; fi
}

cleanup() {
  for p in $(ps -eo pid,args | grep "mybatis-test-1.0.jar --server.port=$PORT_APP" | grep -v grep | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
  pkill -f "curl -s http://127.0.0.1:$PORT_APP" 2>/dev/null
  rm -rf "$CONF" ~/.cache/testagent/sessions /tmp/testagent-sql-*.jsonl /tmp/e2e-xml-*.xml /tmp/e2e-mb-cp.txt /tmp/e2e-javac.err
}
trap cleanup EXIT

[ -f "$APP_JAR" ] || { echo "缺少 $APP_JAR（cd tests/mybatis-test && mvn package）"; exit 1; }
# 确保 testagent-spring.jar 在 agent 同目录（rm -rf target 重编会清掉）
_SPRING_SRC=/home/pi/workspace/pi-work/TestAgent/extensions/testagent-spring/target/testagent-spring-1.0.jar
_SPRING_DST="/home/pi/workspace/pi-work/TestAgent/TestAgent/target/testagent-spring-1.0.jar"
[ -f "$_SPRING_SRC" ] && cp "$_SPRING_SRC" "$_SPRING_DST"

cleanup; mkdir -p "$CONF"
cat > /tmp/e2e-mb-run.sh <<EOF
#!/bin/bash
cd /tmp; echo \$\$ > /tmp/e2e-mb.pid
export TESTAGENT_ENABLE=1 TESTAGENT_HTTP_PORT=$PORT_HTTP TESTAGENT_BASEPATH= TESTAGENT_CONF=$CONF
exec /home/pi/workspace/pi-work/pi-web-ext/aiti-testagent/testagent-java java -jar $APP_JAR --server.port=$PORT_APP >> /tmp/e2e-mb.log 2>&1
EOF
chmod +x /tmp/e2e-mb-run.sh; rm -f /tmp/e2e-mb.log /tmp/e2e-mb.pid
setsid /tmp/e2e-mb-run.sh < /dev/null &
for i in $(seq 1 50); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_HTTP/api/ping >/dev/null 2>&1 && break; done
for i in $(seq 1 15); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_APP/users >/dev/null 2>&1 && break; done

say "基础"
check "ping" "curl -s http://127.0.0.1:$PORT_HTTP/api/ping" '"pong":true'
check "users 查询" "curl -s http://127.0.0.1:$PORT_APP/users" '"alice"'

say "MyBatis XML 热更新（改 SQL 不重启）"
cat > /tmp/e2e-xml-age28.xml <<'XEOF'
<?xml version="1.0"?><!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd"><mapper namespace="com.demo.mapper.UserMapper"><select id="findAll" resultType="map">SELECT id,name,age FROM users WHERE age &lt; 28</select></mapper>
XEOF
cat > /tmp/e2e-xml-all.xml <<'XEOF'
<?xml version="1.0"?><!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "http://mybatis.org/dtd/mybatis-3-mapper.dtd"><mapper namespace="com.demo.mapper.UserMapper"><select id="findAll" resultType="map">SELECT id,name,age FROM users</select></mapper>
XEOF
check "xml 热更新(age<28)" "python3 $HERE/e2e-mybatis-helper.py $PORT_HTTP com.demo.mapper.UserMapper /tmp/e2e-xml-age28.xml" 'parsed'
sleep 1
check "改后只剩 bob" "curl -s http://127.0.0.1:$PORT_APP/users" 'bob'
check "alice 被过滤" "curl -s http://127.0.0.1:$PORT_APP/users | grep -c alice" '0'
check "还原 xml" "python3 $HERE/e2e-mybatis-helper.py $PORT_HTTP com.demo.mapper.UserMapper /tmp/e2e-xml-all.xml" 'parsed'
sleep 1
check "还原后 alice 回来" "curl -s http://127.0.0.1:$PORT_APP/users | grep -c alice" '1'

say "SQL 拦截 + classwatch（深度验证见 README 手动步骤）"
check "sql start" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/api/sql -H 'Content-Type: application/json' -d '{\"action\":\"start\"}'" '"action":"start"'
sleep 1
curl -s http://127.0.0.1:$PORT_APP/users > /dev/null; sleep 0.5
check "sql dump 有记录" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/api/sql -H 'Content-Type: application/json' -d '{\"action\":\"dump\"}'" '"records":'
check "sql stop" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/api/sql -H 'Content-Type: application/json' -d '{\"action\":\"stop\"}'" '"action":"stop"'
check "classwatch start" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/api/classwatch -H 'Content-Type: application/json' -d '{\"action\":\"start\",\"dir\":\"'$CLASSES_DIR'\"}'" '"action":"start"'
check "classwatch status" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/api/classwatch -H 'Content-Type: application/json' -d '{\"action\":\"status\"}'" '"watching":true'

say "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && echo "✅ 全部通过" || echo "❌ 有失败"
exit $FAIL
