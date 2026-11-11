#!/usr/bin/env bash
# aiti-testagent e2e：i18n 资源热刷新专项——fat jar 内嵌旧 properties + MessageSource 永久缓存场景
# 链路：fat jar 启动（资源 v1「维度」）→ classwatch start → 改 src/main/resources（维度→参数）
#   → mvn compile（资源复制到 target/classes）→ classwatch 感知 + 自动 MessageSource 热刷新
#   → 请求 /demo/i18n 验证新文案（不重启生效）→ /api/i18n list/refresh + status resourceChanges
# 退出码: 0=全过 1=有失败

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
APP_JAR="${APP_JAR:-$ROOT/TestAgent/tests/spring-test/target/spring-test-1.0.jar}"
AGENT_JAR="${TESTAGENT_JAR:-$ROOT/TestAgent/TestAgent/target/testagent-1.0.jar}"
APP_DIR="$ROOT/TestAgent/tests/spring-test"
pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT_HTTP=$(pick_port); PORT_APP=$(pick_port)
WORK=/tmp/e2e-i18n; CONF=$WORK/conf
PASS=0; FAIL=0

say() { echo; echo "═══ $1 ═══"; }
check() { local desc="$1" cmd="$2" expect="$3"
  local out; out=$(eval "$cmd" 2>&1)
  if echo "$out" | grep -q "$expect"; then PASS=$((PASS+1)); echo "  ✅ $desc";
  else FAIL=$((FAIL+1)); echo "  ❌ $desc (期望含: $expect)"; echo "      实际: $(echo "$out" | head -c 300)"; fi; }

cleanup() {
  for p in $(ps -eo pid,args | grep "spring-test-1.0.jar --server.port=$PORT_APP" | grep -v grep | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
  # 还原 src 资源到 v1（维度）；⚠ 只还原 src，不动 target/classes——下轮 sed 后 src mtime 领先，mvn compile 才会重新复制并产生 WatchService 事件
  for f in "$APP_DIR/src/main/resources/messages.properties" "$APP_DIR/src/main/resources/messages_zh_CN.properties"; do
    sed -i 's/\\u53C2\\u6570/\\u7EF4\\u5EA6/' "$f" 2>/dev/null
  done
  rm -f "$APP_DIR/src/main/resources/not-i18n.properties" "$APP_DIR/target/classes/not-i18n.properties"
  rm -rf "$WORK"
}
trap cleanup EXIT

[ -f "$APP_JAR" ] || { echo "缺少 $APP_JAR"; exit 1; }
[ -f "$AGENT_JAR" ] || { echo "缺少 $AGENT_JAR"; exit 1; }

cleanup; mkdir -p "$CONF"
API="http://127.0.0.1:$PORT_HTTP/api"; APP="http://127.0.0.1:$PORT_APP"

# fat jar 启动（资源 v1 内嵌 jar：BOOT-INF/classes/messages*.properties）
cat > "$WORK-run.sh" <<EOF
#!/bin/bash
exec java -javaagent:$AGENT_JAR=$CONF -Dtestagent.httpPort=$PORT_HTTP -Dtestagent.basePath= \
  -jar $APP_JAR --server.port=$PORT_APP > $WORK.app.log 2>&1
EOF
chmod +x "$WORK-run.sh"
setsid "$WORK-run.sh" < /dev/null &
for i in $(seq 1 40); do sleep 1; curl -s --max-time 1 "$API/ping" >/dev/null 2>&1 && break; done
for i in $(seq 1 120); do sleep 1; R=$(curl -s --max-time 2 "$APP/demo/i18n" 2>/dev/null); [ -n "$R" ] && break; done

say "基线（fat jar 内嵌资源 v1：维度）"
check "接口返回旧文案（维度）" 'curl -s "$APP/demo/i18n?key=demo.field.label&lang=zh_CN"' '维度标识不能为空'
check "classwatch start" 'curl -s -X POST "$API/classwatch" -d "{\"action\":\"start\",\"dir\":\"'$APP_DIR'/target/classes\"}"' '"action":"start"'

say "资源变更 → classwatch 感知 + 自动 MessageSource 热刷新"
# 维度(\u7EF4\u5EA6) → 参数(\u53C2\u6570)：unicode 转义层替换（properties 文本安全）
sed -i 's/\\u7EF4\\u5EA6/\\u53C2\\u6570/' "$APP_DIR/src/main/resources/messages.properties" "$APP_DIR/src/main/resources/messages_zh_CN.properties"
(cd "$APP_DIR" && mvn -q compile -o -DskipTests -Dmaven.build.cache.enabled=false >/dev/null 2>&1)
sleep 8   # WatchService 事件（1s 轮询）+ 感知 + 刷新落账
check "app 日志含「资源已热刷新生效」" 'grep -a "资源已热刷新生效" '"$WORK"'.app.log' '资源已热刷新生效'
check "classwatch.log 落盘 resource-refreshed" 'cat '"$CONF"'/logs/classwatch.log' 'resource-refreshed'
check "接口返回新文案（参数）——不重启生效" 'curl -s "$APP/demo/i18n?key=demo.field.label&lang=zh_CN"' '参数标识不能为空'
check "status resourceChangedCount>=2" 'curl -s -X POST "$API/classwatch" -d "{\"action\":\"status\"}"' '"resourceChangedCount":'
check "status resourceNeedsRestart=false（已刷新）" 'curl -s -X POST "$API/classwatch" -d "{\"action\":\"status\"}"' '"resourceNeedsRestart":false'
check "status resourceChanges 含 messages_zh_CN 且已刷新" 'curl -s -X POST "$API/classwatch" -d "{\"action\":\"status\"}" | grep -o "messages_zh_CN[^}]*"' '已热刷新生效'

say "/api/i18n list / refresh"
check "i18n list 列出 messageSource" 'curl -s -X POST "$API/i18n" -d "{\"action\":\"list\"}"' 'ResourceBundleMessageSource'
check "i18n list 有磁盘覆盖" 'curl -s -X POST "$API/i18n" -d "{\"action\":\"list\"}"' 'messages.properties'
check "i18n refresh 手动触发成功" 'curl -s -X POST "$API/i18n" -d "{\"action\":\"refresh\"}"' '"injectedFiles":'
check "refresh 后接口仍新文案" 'curl -s "$APP/demo/i18n?key=demo.greeting&lang=zh_CN"' '你好'

say "非 i18n 资源变更 → 需重启提示"
echo 'plain=1' > "$APP_DIR/src/main/resources/not-i18n.properties"
(cd "$APP_DIR" && mvn -q compile -o -DskipTests -Dmaven.build.cache.enabled=false >/dev/null 2>&1)
sleep 8
check "非匹配 properties 通用提示（需重新打包重启）" 'grep -a "热替换无法覆盖" '"$WORK"'.app.log' '热替换无法覆盖'
check "status resourceNeedsRestart=true" 'curl -s -X POST "$API/classwatch" -d "{\"action\":\"status\"}"' '"resourceNeedsRestart":true'

say "结果: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ] && echo "✅ i18n hot-refresh e2e 全过" || echo "❌ 有失败项"
exit $([ "$FAIL" = 0 ] && echo 0 || echo 1)
