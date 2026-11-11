#!/usr/bin/env bash
# aiti-testagent e2e（JDK 8 兼容性——全功能回归）
# 用法: ./e2e-jdk8.sh   退出码: 0=全过 1=有失败
# 前置: tools/build-all.sh（agent+扩展 Java 8 编译）；tests/spring2-test JDK8 构建（Boot 2.7 + H2）

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
JAVA8="${JAVA8:-/usr/lib/jvm/java-1.8.0-openjdk-amd64/bin/java}"
AGENT_JAR=$ROOT/TestAgent/TestAgent/target/testagent-1.0.jar
APP_JAR=$ROOT/TestAgent/tests/spring2-test/target/spring2-test-1.0.jar
pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT_HTTP=$(pick_port)
PORT_APP=$(pick_port)
CONF=/tmp/e2e-jdk8-conf-$$
PASS=0; FAIL=0

# 确保扩展 jar 在 agent 同目录（agent 重建后需拷回）
cp $ROOT/TestAgent/extensions/testagent-calcite/target/testagent-calcite-1.0.jar $ROOT/TestAgent/TestAgent/target/ 2>/dev/null
cp $ROOT/TestAgent/extensions/testagent-spring/target/testagent-spring-1.0.jar $ROOT/TestAgent/TestAgent/target/ 2>/dev/null
[ -x "$JAVA8" ] || { echo "缺少 JDK 8: $JAVA8"; exit 1; }
[ -f "$APP_JAR" ] || { echo "缺少 spring2-test（JDK8 构建）"; exit 1; }
echo "JDK8: $("$JAVA8" -version 2>&1 | head -1) | 端口: $PORT_HTTP/$PORT_APP"

say() { echo; echo "═══ $1 ═══"; }
post()  { curl -s --max-time 60 -X POST "$API/api/$1" -H 'Content-Type: application/json' -d "$2"; }
# 轮询断言（插桩/reload 生效需时间——重试直到预期，免疫时序）
wait_expect() {
  local desc="$1" expr="$2" url="$3" t="${4:-20}"
  local out=""
  for i in $(seq 1 $t); do
    out=$(curl -s --max-time 3 "$url")
    local r=$(printf '%s' "$out" | python3 -c "
import json,sys
raw=sys.stdin.read().strip()
try: d=json.loads(raw)
except Exception: d=raw
try: print('OK' if ($expr) else 'NO')
except Exception: print('NO')" 2>&1)
    [ "$r" = "OK" ] && { PASS=$((PASS+1)); echo "  ✅ $desc"; return 0; }
    sleep 1
  done
  FAIL=$((FAIL+1)); echo "  ❌ $desc"; echo "      最终: $(echo "$out" | head -c 150)"
}
# POST 后轮询（body = "api JSON" 两段——post 需要 api 和 json 两个参数）
wait_post() {
  local desc="$1" expr="$2" geturl="$3" body="$4"
  local api="${body%% *}" json="${body#* }"
  post "$api" "$json" > /dev/null
  wait_expect "$desc" "$expr" "$geturl"
}
jcheck() {
  local desc="$1" expr="$2" body="$3"
  local out; out=$(printf '%s' "$body" | python3 -c "
import json,sys
raw=sys.stdin.read().strip()
try: d=json.loads(raw)
except Exception: d=raw
try: print('OK' if ($expr) else 'FAIL:'+str(d)[:200])
except Exception as e: print('EXPRERR:'+str(e)[:100])
" 2>&1)
  if [ "$out" = "OK" ]; then PASS=$((PASS+1)); echo "  ✅ $desc";
  else FAIL=$((FAIL+1)); echo "  ❌ $desc"; echo "      $out"; fi
}
cleanup() {
  for p in $(ps -eo pid,args | grep "spring2-test-1.0.jar --server.port=$PORT_APP" | grep -v grep | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
  rm -rf "$CONF" /tmp/testagent-sql-*.jsonl
}
trap cleanup EXIT

cleanup; mkdir -p "$CONF"
cat > /tmp/e2e-jdk8-run.sh <<EOF
#!/bin/bash
cd /tmp
export TESTAGENT_ENABLE=1 TESTAGENT_HTTP_PORT=$PORT_HTTP TESTAGENT_BASEPATH= TESTAGENT_CONF=$CONF
exec "$JAVA8" -javaagent:$AGENT_JAR=$CONF -Dtestagent.basePath= -jar $APP_JAR --server.port=$PORT_APP >> /tmp/e2e-jdk8.log 2>&1
EOF
chmod +x /tmp/e2e-jdk8-run.sh; rm -f /tmp/e2e-jdk8.log
setsid /tmp/e2e-jdk8-run.sh < /dev/null &
for i in $(seq 1 120); do sleep 0.5; curl -s --max-time 1 http://127.0.0.1:$PORT_APP/jdbc2 | grep -q "alice" 2>/dev/null && break; done
API="http://127.0.0.1:$PORT_HTTP/testagent"; APP="http://127.0.0.1:$PORT_APP"
[ "$(curl -s --max-time 2 $APP/jdbc2 | head -c 2)" = "[{" ] || { echo "应用未就绪"; tail -5 /tmp/e2e-jdk8.log; exit 1; }

say "JDK 8：基础 + 方法级 mock/篡改"
jcheck "API 在线" "d.get('ok')" "$(curl -s $API/api/ping)"
jcheck "应用正常（/jdbc2 2 条）" "isinstance(d,list) and len(d)==2" "$(curl -s $APP/jdbc2)"
wait_post "篡改-过滤（真实 2 → bob）" "isinstance(d,list) and len(d)==1 and d[0]['NAME']=='bob'" "$APP/jdbc2" 'mock-method {"action":"add","className":"com.demo2.Ctl2","method":"jdbc2","filter":"AGE < 28"}'
wait_post "篡改-修改（SELECT AGE+1）" "isinstance(d,list) and all(u['AGE']>=26 for u in d)" "$APP/jdbc2" 'mock-method {"action":"add","className":"com.demo2.Ctl2","method":"jdbc2","filter":"SELECT NAME, AGE + 1 AS AGE FROM RESULTS"}'
wait_post "篡改-复制（真实 2 → 50）" "isinstance(d,list) and len(d)==50" "$APP/jdbc2" 'mock-method {"action":"add","className":"com.demo2.Ctl2","method":"jdbc2","copies":[{"path":"","size":50}]}'
wait_post "纯 mock（数组 data + size → 5）" "isinstance(d,list) and len(d)==5 and d[0]['NAME']=='MOCK'" "$APP/jdbc2" 'mock-method {"action":"add","className":"com.demo2.Ctl2","method":"jdbc2","data":"[{\"ID\":9,\"NAME\":\"MOCK\",\"AGE\":99}]","size":5}'
wait_post "还原（/jdbc2 2 条）" "isinstance(d,list) and len(d)==2" "$APP/jdbc2" 'mock-method {"action":"delete","className":"com.demo2.Ctl2","method":"jdbc2"}' 

say "JDK 8：URL mock（mock + 篡改——resolveUrlMethod Spring 5.3）"
wait_post "URL mock（对象 data + size → 5）" "isinstance(d,list) and len(d)==5" "$APP/jdbc2" 'mock-url {"action":"add","url":"/jdbc2","data":"{\"ID\":9,\"NAME\":\"MOCK\",\"AGE\":99}","size":5}'
post mock-url '{"action":"delete","url":"/jdbc2"}' > /dev/null
sleep 1
wait_post "URL 篡改（放行真实 → 方法层过滤）" "isinstance(d,list) and len(d)==1 and d[0]['NAME']=='bob'" "$APP/jdbc2" 'mock-url {"action":"add","url":"/jdbc2","filter":"AGE < 28"}'
post mock-url '{"action":"delete","url":"/jdbc2"}' > /dev/null
wait_expect "还原 2 条" "isinstance(d,list) and len(d)==2" "$APP/jdbc2"

say "JDK 8：SQL 拦截（JDBC 插桩——H2 真实执行）"
post sql '{"action":"start"}' > /dev/null
sleep 2
curl -s $APP/jdbc2 > /dev/null
for i in $(seq 1 10); do
  R=$(post sql '{"action":"dump"}')
  echo "$R" | grep -q '"records": 0\|"records":0' || break
  sleep 1
done
echo "$R" | grep -q '"records": [1-9]\|"records":[1-9]' && { PASS=$((PASS+1)); echo "  ✅ SQL 拦截有记录"; } || { FAIL=$((FAIL+1)); echo "  ❌ SQL 拦截有记录"; }
post sql '{"action":"stop"}' > /dev/null; sleep 1
post sql '{"action":"start","inject":{"url":"/jdbc2","exception":"java.sql.SQLException: jdk8-boom"}}' > /dev/null
wait_expect "SQL 故障注入（500）" "isinstance(d,dict) and d.get('status')==500" "$APP/jdbc2"
post sql '{"action":"stop"}' > /dev/null; sleep 1
wait_expect "还原正常" "isinstance(d,list) and len(d)==2" "$APP/jdbc2"

say "JDK 8：eval / watch / 启动分析"
jcheck "eval 表达式" "d.get('data',{}).get('result')=='4'" "$(post eval '{"expr":"String.valueOf(2+2)"}')"
jcheck "watch 注册" "d.get('ok')" "$(post watch '{"className":"com.demo2.Ctl2","method":"jdbc2"}')"
jcheck "启动分析启用" "d.get('ok')" "$(post startup-report '{}')"
jcheck "启动分析报告端点" "d.get('ok') and 'totalBeans' in d.get('data',{})" "$(curl -s $API/api/startup-report)"

say "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && echo "✅ e2e-jdk8 全部通过（JDK 8 全功能兼容）" || echo "❌ e2e-jdk8 有失败"
exit $FAIL
