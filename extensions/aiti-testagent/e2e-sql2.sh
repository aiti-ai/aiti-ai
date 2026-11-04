#!/usr/bin/env bash
# aiti-testagent e2e（SQL 拦截增强——filter/inject/rewrite/simulate/还原）
# 用法: ./e2e-sql2.sh   退出码: 0=全过 1=有失败
# 前置: tools/build-all.sh（含 testagent-calcite-1.0.jar）

set -u
APP_JAR="${APP_JAR:-/home/pi/workspace/aiti-ai/TestAgent/tests/mybatis-test/target/mybatis-test-1.0.jar}"
AGENT_DIR=/home/pi/workspace/aiti-ai/TestAgent/TestAgent/target
pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT_HTTP=$(pick_port)
PORT_APP=$(pick_port)
CONF=/tmp/e2e-sql2-conf
PASS=0; FAIL=0

say() { echo; echo "═══ $1 ═══"; }
post()  { curl -s -X POST "$API/api/sql" -H 'Content-Type: application/json' -d "$1"; }
jcheck() {
  local desc="$1" expr="$2" body="$3"
  local out; out=$(printf '%s' "$body" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print('OK' if ($expr) else 'FAIL:'+json.dumps(d)[:220])
except Exception as e:
    print('JSONERR:'+str(e)[:120])
" 2>&1)
  if [ "$out" = "OK" ]; then PASS=$((PASS+1)); echo "  ✅ $desc";
  else FAIL=$((FAIL+1)); echo "  ❌ $desc"; echo "      $out"; fi
}
cleanup() {
  for p in $(ps -eo pid,args | grep "mybatis-test-1.0.jar --server.port=$PORT_APP" | grep -v grep | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
  rm -rf "$CONF" /tmp/testagent-sql-*.jsonl
}
trap cleanup EXIT

[ -f "$APP_JAR" ] || { echo "缺少 $APP_JAR（先构建 mybatis-test）"; exit 1; }
[ -f "$AGENT_DIR/testagent-calcite-1.0.jar" ] || { echo "缺少 calcite 扩展（先 tools/build-all.sh）"; exit 1; }

cleanup; mkdir -p "$CONF"
cat > /tmp/e2e-sql2-run.sh <<EOF
#!/bin/bash
cd /tmp
export TESTAGENT_ENABLE=1 TESTAGENT_HTTP_PORT=$PORT_HTTP TESTAGENT_BASEPATH= TESTAGENT_CONF=$CONF
exec /home/pi/workspace/aiti-ai/pi-web-ext/aiti-testagent/testagent-java java -jar $APP_JAR --server.port=$PORT_APP >> /tmp/e2e-sql2.log 2>&1
EOF
chmod +x /tmp/e2e-sql2-run.sh; rm -f /tmp/e2e-sql2.log
setsid /tmp/e2e-sql2-run.sh < /dev/null &
for i in $(seq 1 50); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_HTTP/api/ping >/dev/null 2>&1 && break; done
for i in $(seq 1 15); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_APP/users >/dev/null 2>&1 && break; done
API="http://127.0.0.1:$PORT_HTTP/testagent"; APP="http://127.0.0.1:$PORT_APP"

say "SQL 修改（rewrite——真改执行）"
post '{"action":"start","rewrite":[{"match":"FROM users ORDER","replace":"FROM users WHERE age < 28 ORDER"}]}' > /dev/null
sleep 3
jcheck "/users 只剩 bob（1 条·旧格式整段替换）" "isinstance(d,list) and len(d)==1 and d[0]['NAME']=='bob'" "$(curl -s $APP/users)"
jcheck "dump 有 rewrites 比对" "d.get('data',{}).get('rewrites','')!=''" "$(post '{"action":"dump"}')"
post '{"action":"stop"}' > /dev/null; sleep 2
jcheck "stop 还原 2 条" "isinstance(d,list) and len(d)==2" "$(curl -s $APP/users)"

say "rewrite 新格式（match 条件 + replaceFrom/replaceTo 部分替换）"
post '{"action":"start","rewrite":[{"match":"FROM users","replaceFrom":"ORDER BY id","replaceTo":"ORDER BY age ASC"}]}' > /dev/null
sleep 3
jcheck "部分替换 ORDER BY age ASC → bob, alice" "isinstance(d,list) and [u['NAME'] for u in d]==['bob','alice']" "$(curl -s $APP/users)"
post '{"action":"stop"}' > /dev/null; sleep 2
post '{"action":"start","rewrite":[{"match":"FROM users","replaceFrom":"*","replaceTo":"SELECT 1"}]}' > /dev/null
sleep 3
jcheck "整条替换（replaceFrom=*）→ SELECT 1" "isinstance(d,list) and d==[{'1':1}]" "$(curl -s $APP/users)"
post '{"action":"stop"}' > /dev/null; sleep 2
jcheck "还原 2 条" "isinstance(d,list) and len(d)==2" "$(curl -s $APP/users)"

say "故障注入（inject exception——模拟 SQL 失败）"
post '{"action":"start","inject":{"url":"/users","exception":"java.sql.SQLException: boom"}}' > /dev/null
sleep 3
jcheck "/users → 500（模拟失败）" "isinstance(d,dict) and d.get('status')==500" "$(curl -s $APP/users)"
jcheck "/user?name= 正常（条件精准）" "isinstance(d,dict) and d.get('NAME')=='bob'" "$(curl -s "$APP/user?name=bob")"
post '{"action":"stop"}' > /dev/null; sleep 2
jcheck "还原后 /users 正常" "isinstance(d,list) and len(d)==2" "$(curl -s $APP/users)"

say "延迟注入（inject delayMs）"
post '{"action":"start","inject":{"url":"/users","delayMs":1500}}' > /dev/null
sleep 3
T0=$(date +%s%N); curl -s $APP/users > /dev/null; T1=$(date +%s%N)
MS=$(( (T1 - T0) / 1000000 ))
post '{"action":"stop"}' > /dev/null
if [ $MS -ge 3000 ]; then PASS=$((PASS+1)); echo "  ✅ 延迟注入（${MS}ms ≥3s 嵌套放大）";
else FAIL=$((FAIL+1)); echo "  ❌ 延迟注入（仅 ${MS}ms）"; fi
sleep 2
T0=$(date +%s%N); curl -s $APP/users > /dev/null; T1=$(date +%s%N)
MS2=$(( (T1 - T0) / 1000000 ))
if [ $MS2 -lt 1000 ]; then PASS=$((PASS+1)); echo "  ✅ 还原后正常（${MS2}ms）";
else FAIL=$((FAIL+1)); echo "  ❌ 还原后仍慢（${MS2}ms）"; fi

say "记录过滤（filter——只记录匹配 SQL）"
post '{"action":"start","filter":{"url":"/users"}}' > /dev/null
sleep 3
post '{"action":"dump"}' > /dev/null   # 清空前段 BUFFER 残留
curl -s $APP/users > /dev/null
curl -s "$APP/user?name=bob" > /dev/null
sleep 1
jcheck "只记录 /users（url 全为 GET /users）" "d.get('data',{}).get('records',0)>=1 and all(r.get('url')=='GET /users' for r in d['data']['data'])" "$(post '{"action":"dump"}')"
post '{"action":"stop"}' > /dev/null; sleep 2

say "结果模拟（simulate——calcite 扩展动态加载，不改真实执行）"
post '{"action":"start"}' > /dev/null
sleep 3
curl -s $APP/users > /dev/null
sleep 1
jcheck "simulate 加 WHERE age<28 → bob（原表名）" "d.get('ok') and d['data']['rows']==1 and d['data']['result'][0]['NAME']=='bob'" "$(post '{"action":"simulate","sql":"SELECT NAME FROM USERS WHERE AGE < 28"}')"
jcheck "RESULTS 固定名（结果集通用）" "d.get('ok') and d['data']['rows']==1 and d['data']['result'][0]['NAME']=='bob'" "$(post '{"action":"simulate","sql":"SELECT NAME FROM RESULTS WHERE AGE < 28"}')"
jcheck "RESULTS 聚合（COUNT/MAX）" "d.get('ok') and d['data']['result'][0]['CNT']==2" "$(post '{"action":"simulate","sql":"SELECT COUNT(*) AS CNT FROM RESULTS"}')"
jcheck "simulate set 值（MOCKED-）" "d.get('ok') and all(r['NAME'].startswith('MOCKED-') for r in d['data']['result'])" "$(post "{\"action\":\"simulate\",\"sql\":\"SELECT 'MOCKED-' || NAME AS NAME FROM USERS\"}")"
jcheck "simulate 不改真实执行（/users 仍 2 条）" "isinstance(d,list) and len(d)==2" "$(curl -s $APP/users)"
post '{"action":"stop"}' > /dev/null

say "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && echo "✅ e2e-sql2 全部通过" || echo "❌ e2e-sql2 有失败"
exit $FAIL
