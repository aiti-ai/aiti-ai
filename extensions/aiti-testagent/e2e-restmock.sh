#!/usr/bin/env bash
# aiti-testagent e2e（REST API 层 URL mock——按 URL 模拟接口返回值）
# 用法: ./e2e-restmock.sh   退出码: 0=全过 1=有失败
# 前置: tools/build-all.sh

set -u
APP_JAR="${APP_JAR:-/home/pi/workspace/pi-work/TestAgent/tests/mybatis-test/target/mybatis-test-1.0.jar}"
pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT_HTTP=$(pick_port)
PORT_APP=$(pick_port)
CONF=/tmp/e2e-restmock-conf
PASS=0; FAIL=0

say() { echo; echo "═══ $1 ═══"; }
post()  { curl -s -X POST "$API/api/mock-url" -H 'Content-Type: application/json' -d "$1"; }
del()   { curl -s -X DELETE "$API/api/mock-url" -H 'Content-Type: application/json' -d "$1"; }
postm() { curl -s -X POST "$API/api/mock-method" -H 'Content-Type: application/json' -d "$1"; }
delm()  { curl -s -X DELETE "$API/api/mock-method" -H 'Content-Type: application/json' -d "$1"; }
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
  rm -rf "$CONF"
}
trap cleanup EXIT

[ -f "$APP_JAR" ] || { echo "缺少 $APP_JAR"; exit 1; }
cleanup; mkdir -p "$CONF"
cat > /tmp/e2e-restmock-run.sh <<EOF
#!/bin/bash
cd /tmp
export TESTAGENT_ENABLE=1 TESTAGENT_HTTP_PORT=$PORT_HTTP TESTAGENT_BASEPATH= TESTAGENT_CONF=$CONF
exec /home/pi/workspace/pi-work/pi-web-ext/aiti-testagent/testagent-java java -jar $APP_JAR --server.port=$PORT_APP >> /tmp/e2e-restmock.log 2>&1
EOF
chmod +x /tmp/e2e-restmock-run.sh; rm -f /tmp/e2e-restmock.log
setsid /tmp/e2e-restmock-run.sh < /dev/null &
for i in $(seq 1 50); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_HTTP/api/ping >/dev/null 2>&1 && break; done
for i in $(seq 1 15); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_APP/users >/dev/null 2>&1 && break; done
API="http://127.0.0.1:$PORT_HTTP/testagent"; APP="http://127.0.0.1:$PORT_APP"

say "REST API URL mock（按 URL 模拟接口返回值）"
jcheck "注册前 /users 真实 2 条" "isinstance(d,list) and len(d)==2" "$(curl -s $APP/users)"
post '{"action":"add","url":"/users","data":[{"ID":1,"NAME":"订单A","AGE":30}],"size":200}' > /dev/null
sleep 3
jcheck "注册后 /users 模拟 200 条（id 递增）" "isinstance(d,list) and len(d)==200 and d[0]['ID']==1 and d[199]['ID']==200" "$(curl -s $APP/users)"
jcheck "未注册接口不受影响" "isinstance(d,dict) and d.get('NAME')=='bob'" "$(curl -s "$APP/user?name=bob")"

say "前缀匹配 + 自定义 status"
post '{"action":"add","url":"/user*","data":{"id":1,"name":"x"},"size":5,"status":500}' > /dev/null
sleep 1
CODE=$(curl -s -o /tmp/e2e-rm-body -w '%{http_code}' "$APP/user?name=bob")
jcheck "前缀 /user* + status 500" "d.get('ok')" "$(printf '{"ok":%s}' "$([ "$CODE" = "500" ] && echo true || echo false)")"
jcheck "mock body 5 条" "isinstance(d,list) and len(d)==5" "$(cat /tmp/e2e-rm-body)"

say "嵌套结构 + copies（jsonpath 列表复制）"
post '{"action":"add","url":"/api/orders","data":{"code":0,"msg":"success","data":{"orders":[{"orderId":1001,"customer":"张三","amount":99.9}],"page":{"total":0}}},"copies":[{"path":"$.data.orders","size":200},{"path":"$.data.page.total","value":200}]}' > /dev/null
sleep 2
jcheck "copies 复制 orders → 200 条（id 递增）" "d.get('data',{}).get('orders') and len(d['data']['orders'])==200 and d['data']['orders'][0]['orderId']==1001 and d['data']['orders'][-1]['orderId']==1200" "$(curl -s $APP/api/orders)"
jcheck "copies 设值 page.total → 200" "d.get('data',{}).get('page',{}).get('total')==200" "$(curl -s $APP/api/orders)"
jcheck "404 接口也被 mock（doDispatch 插桩兜底）" "d.get('ok')" "$(printf '{"ok":%s}' "$([ "$(curl -s $APP/api/orders | grep -c 'Not Found')" = "0" ] && echo true || echo false)")"
del '{"url":"/api/orders"}' > /dev/null
sleep 1
jcheck "删除后还原 404" "d.get('ok')" "$(printf '{"ok":%s}' "$([ "$(curl -s -o /dev/null -w '%{http_code}' $APP/api/orders)" = "404" ] && echo true || echo false)")"

say "精确匹配优先 + 删除还原"
post '{"action":"add","url":"/api/orders*","data":[{"orderId":1001}],"size":200}' > /dev/null
post '{"action":"add","url":"/api/orders","data":{"orderId":1},"size":3}' > /dev/null
sleep 1
jcheck "精确 /api/orders → 3 条（优先于前缀）" "isinstance(d,list) and len(d)==3" "$(curl -s $APP/api/orders)"
jcheck "前缀 /api/orders/123 → 200 条" "isinstance(d,list) and len(d)==200" "$(curl -s $APP/api/orders/123)"
del '{"url":"/api/orders"}' > /dev/null
del '{"url":"/api/orders*"}' > /dev/null
jcheck "删除后还原（404）" "d.get('ok')" "$(printf '{"ok":%s}' "$([ "$(curl -s -o /dev/null -w '%{http_code}' $APP/api/orders)" = "404" ] && echo true || echo false)")"
del '{"url":"/users"}' > /dev/null
del '{"url":"/user*"}' > /dev/null
sleep 1
jcheck "全部删除后 /users 还原 2 条" "isinstance(d,list) and len(d)==2" "$(curl -s $APP/users)"

say "方法级 mock（/api/mock-method——任意接口方法，字节码插桩改返回值；篡改：过滤/修改/复制）"
postm '{"action":"add","className":"com.demo.UserController","method":"users","filter":"AGE < 28"}' > /dev/null
sleep 2
jcheck "篡改-过滤（真实结果 WHERE AGE<28 → bob）" "isinstance(d,list) and len(d)==1 and d[0]['NAME']=='bob'" "$(curl -s $APP/users)"
postm '{"action":"add","className":"com.demo.UserController","method":"users","filter":"SELECT NAME, AGE + 1 AS AGE FROM RESULTS"}' > /dev/null
sleep 1
jcheck "篡改-修改（完整 SELECT 表达式 AGE+1）" "isinstance(d,list) and all(u['AGE']>=26 for u in d)" "$(curl -s $APP/users)"
postm '{"action":"add","className":"com.demo.UserController","method":"users","copies":[{"path":"","size":50}]}' > /dev/null
sleep 1
jcheck "篡改-复制（真实 2 条 → 50 条）" "isinstance(d,list) and len(d)==50" "$(curl -s $APP/users)"
delm '{"className":"com.demo.UserController","method":"users"}' > /dev/null
sleep 1
jcheck "删除还原 2 条" "isinstance(d,list) and len(d)==2" "$(curl -s $APP/users)"

say "方法级 mock（/api/mock-method——任意接口方法，字节码插桩改返回值）"
postm '{"action":"add","className":"com.demo.UserController","method":"users","data":[{"ID":1,"NAME":"订单A","AGE":30}],"size":200}' > /dev/null
sleep 2
jcheck "方法级 mock：UserController.users → 200 条" "isinstance(d,list) and len(d)==200" "$(curl -s $APP/users)"
jcheck "未 mock 的方法不受影响" "isinstance(d,dict) and d.get('NAME')=='bob'" "$(curl -s "$APP/user?name=bob")"
jcheck "方法级清单" "d.get('data',{}).get('mocks') and any(m['key']=='com.demo.UserController.users' for m in d['data']['mocks'])" "$(curl -s $API/api/mock-method)"
delm '{"className":"com.demo.UserController","method":"users"}' > /dev/null
sleep 2
jcheck "删除后还原 2 条" "isinstance(d,list) and len(d)==2" "$(curl -s $APP/users)"

say "URL mock 篡改（url + filter——HTTP 放行真实 → 方法层篡改真实返回值）"
post '{"action":"add","url":"/users","filter":"AGE < 28"}' > /dev/null
sleep 2
jcheck "URL 篡改-过滤（/users + WHERE → bob）" "isinstance(d,list) and len(d)==1 and d[0]['NAME']=='bob'" "$(curl -s $APP/users)"
post '{"action":"add","url":"/users","filter":"SELECT NAME, AGE + 1 AS AGE FROM RESULTS ORDER BY AGE DESC"}' > /dev/null
sleep 1
jcheck "URL 篡改-修改（SELECT AGE+1 → 31/26）" "isinstance(d,list) and [u['AGE'] for u in d]==[31,26]" "$(curl -s $APP/users)"
del '{"url":"/users"}' > /dev/null
sleep 2
jcheck "删除还原 2 条" "isinstance(d,list) and len(d)==2" "$(curl -s $APP/users)"

say "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && echo "✅ e2e-restmock 全部通过" || echo "❌ e2e-restmock 有失败"
exit $FAIL
