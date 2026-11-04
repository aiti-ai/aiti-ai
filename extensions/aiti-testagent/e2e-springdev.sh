#!/usr/bin/env bash
# aiti-testagent e2e：SpringBoot 开发模式专项——总开关四件套 / props 属性热刷新 /
# propwatch 配置监听 / springops 运行时组件热操作（缓存·连接池·线程池·定时任务重排）
# 用法: ./e2e-springdev.sh   （默认用 TestAgent/tests/spring-test 的 jar，需先构建）
# 退出码: 0=全过 1=有失败

set -u
APP_JAR="${APP_JAR:-/home/pi/workspace/pi-work/TestAgent/tests/spring-test/target/spring-test-1.0.jar}"
AGENT_JAR="${TESTAGENT_JAR:-/home/pi/workspace/pi-work/TestAgent/TestAgent/target/testagent-1.0.jar}"
pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT_HTTP=$(pick_port); PORT_APP=$(pick_port)
WORK=/tmp/e2e-springdev; CONF=$WORK/conf
PASS=0; FAIL=0

say() { echo; echo "═══ $1 ═══"; }
check() { local desc="$1" cmd="$2" expect="$3"
  local out; out=$(eval "$cmd" 2>&1)
  if echo "$out" | grep -q "$expect"; then PASS=$((PASS+1)); echo "  ✅ $desc";
  else FAIL=$((FAIL+1)); echo "  ❌ $desc"; echo "      实际: $(echo "$out" | head -c 160)"; fi; }

cleanup() {
  for p in $(ps -eo pid,args | grep "spring-test-1.0.jar --server.port=$PORT_APP" | grep -v grep | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
  rm -rf "$WORK"
}
trap cleanup EXIT

[ -f "$APP_JAR" ] || { echo "缺少 $APP_JAR"; exit 1; }
[ -f "$AGENT_JAR" ] || { echo "缺少 $AGENT_JAR"; exit 1; }

cleanup; mkdir -p "$CONF"
API="http://127.0.0.1:$PORT_HTTP/api"; APP="http://127.0.0.1:$PORT_APP"

# ---- 起 Spring Boot：总开关走环境变量（顺带覆盖 TESTAGENT_SPRINGBOOT 路径），cwd 放配置文件 ----
printf 'custom:\n  demo-name: sbdev-v1\n  count: 42\n' > "$WORK/application.yml"
cat > "$WORK/run.sh" <<EOF
#!/bin/bash
cd $WORK
export TESTAGENT_SPRINGBOOT=true
exec java -javaagent:$AGENT_JAR=$CONF -Dtestagent.httpPort=$PORT_HTTP -Dtestagent.basePath= \
  -jar $APP_JAR --server.port=$PORT_APP >> $WORK/app.log 2>&1
EOF
chmod +x "$WORK/run.sh"
setsid "$WORK/run.sh" < /dev/null &
for i in $(seq 1 40); do sleep 1; curl -s --max-time 1 "$API/ping" >/dev/null 2>&1 && break; done
sleep 8   # 等 startup-cmds(3s)+propwatch 自动拉起(5s)

say "总开关（环境变量 TESTAGENT_SPRINGBOOT=true）"
check "横幅" 'grep -a "springboot dev mode" '"$WORK"'/app.log' 'springboot dev mode'
check "lazy-mybatis 随总开关启用" 'grep -a "lazy-mybatis enabled" '"$WORK"'/app.log' 'prefetch'
check "lazy-module 随总开关启用" 'grep -a "lazy-module enabled" '"$WORK"'/app.log' 'mode='
check "startup conf 已预置" 'ls '"$CONF"'/startup.analysis.0.conf' 'startup.analysis.0.conf'
check "startup-report 开箱有数据" 'curl -s '"$API"'/startup-report' 'tomcatServletWebServerFactory'
check "propwatch 自动拉起" 'curl -s -X POST '"$API"'/propwatch -d "{\"action\":\"status\"}"' '"watching":true'

say "props 属性热刷新"
PSC='package com.demo;\nimport org.springframework.beans.factory.annotation.Value;\nimport org.springframework.web.bind.annotation.GetMapping;\nimport org.springframework.web.bind.annotation.RestController;\n@RestController\npublic class PcheckController {\n    @Value(\"${custom.demo-name}\")\n    private String demoName;\n    @GetMapping(\"/pcheck\")\n    public String check() { return demoName + \"/\" ; }\n}'
check "热注册 @Value controller" "curl -s -X POST $API/code -H 'Content-Type: application/json' -d '{\"source\":\"$PSC\"}'" '"/pcheck"'
sleep 1
check "初始值来自 yml" 'curl -s '"$APP"'/pcheck' 'sbdev-v1'
check "set 写属性源" "curl -s -X POST $API/props -d '{\"action\":\"set\",\"key\":\"custom.demo-name\",\"value\":\"sbdev-v2\"}'" '"source":"testagent"'
check "refresh 回填 @Value" "curl -s -X POST $API/props -d '{\"action\":\"refresh\"}'" '"updatedCount":1'
check "刷新后接口生效" 'curl -s '"$APP"'/pcheck' 'sbdev-v2'

say "propwatch 配置文件监听（自动拉起的）"
printf 'custom:\n  demo-name: sbdev-v3\n' > "$WORK/application.yml"
sleep 4
check "改 yml 自动生效" 'curl -s '"$APP"'/pcheck' 'sbdev-v3'
check "applied 计数增长" 'curl -s -X POST '"$API"'/propwatch -d "{\"action\":\"status\"}"' '"applied":1'

say "springops 缓存"
check "caches 注解静态发现" "curl -s -X POST $API/springops -d '{\"action\":\"caches\"}'" '"demoCache"'
curl -s "$APP/demo/cache/a" > /dev/null
C1=$(curl -s "$APP/demo/stats")
check "命中缓存 compute 不涨" 'curl -s '"$APP"'/demo/stats' "$(echo $C1 | grep -o 'compute=[0-9]*')"
check "cache_evict 清缓存" "curl -s -X POST $API/springops -d '{\"action\":\"cache_evict\",\"name\":\"demoCache\"}'" '"cleared":1'
curl -s "$APP/demo/cache/a" > /dev/null
C2=$(curl -s "$APP/demo/stats")
if [ "${C1#*compute=}" != "${C2#*compute=}" ]; then PASS=$((PASS+1)); echo "  ✅ 清缓存后重算";
else FAIL=$((FAIL+1)); echo "  ❌ 清缓存后未重算: $C1 → $C2"; fi

say "springops 定时任务"
check "scheds 清单含 interval" "curl -s -X POST $API/springops -d '{\"action\":\"scheds\"}'" '"interval":"1000"'
check "sched_set 热重排 200ms" "curl -s -X POST $API/springops -d '{\"action\":\"sched_set\",\"name\":\"DemoService.tick\",\"n2\":200}'" '"matched":1'
A=$(curl -s "$APP/demo/stats"); sleep 2; B=$(curl -s "$APP/demo/stats")
T1=$(echo $A | grep -o 'tick=[0-9]*' | tr -d 'tick='); T2=$(echo $B | grep -o 'tick=[0-9]*' | tr -d 'tick=')
if [ $((T2-T1)) -ge 6 ]; then PASS=$((PASS+1)); echo "  ✅ 重排后速率加快($((T2-T1))/2s)";
else FAIL=$((FAIL+1)); echo "  ❌ 重排未生效($((T2-T1))/2s)"; fi
check "非法 cron 拒绝且任务不丢" "curl -s -X POST $API/springops -d '{\"action\":\"sched_set\",\"name\":\"DemoService.tick\",\"n1\":\"bad\"}'" 'cron 表达式非法'
A=$(curl -s "$APP/demo/stats"); sleep 2; B=$(curl -s "$APP/demo/stats")
T1=$(echo $A | grep -o 'tick=[0-9]*' | tr -d 'tick='); T2=$(echo $B | grep -o 'tick=[0-9]*' | tr -d 'tick=')
if [ $((T2-T1)) -ge 6 ]; then PASS=$((PASS+1)); echo "  ✅ 拒绝后任务仍在跑";
else FAIL=$((FAIL+1)); echo "  ❌ 任务丢失"; fi

say "springops 线程池（executor + scheduler 双支持）"
check "executors 清单" "curl -s -X POST $API/springops -d '{\"action\":\"executors\"}'" 'applicationTaskExecutor'
check "executor_set executor 调参" "curl -s -X POST $API/springops -d '{\"action\":\"executor_set\",\"name\":\"applicationTaskExecutor\",\"n1\":4,\"n2\":16}'" '"coreOrPoolSize":4'
check "executor_set scheduler 调参(setPoolSize)" "curl -s -X POST $API/springops -d '{\"action\":\"executor_set\",\"name\":\"taskScheduler\",\"n1\":2}'" '"coreOrPoolSize":2'

say "springops 连接池（H2 内嵌 Hikari）"
check "pools 发现 HikariDataSource" "curl -s -X POST $API/springops -d '{\"action\":\"pools\"}'" 'HikariDataSource'
check "pool_set 热调 minIdle" "curl -s -X POST $API/springops -d '{\"action\":\"pool_set\",\"name\":\"dataSource\",\"n1\":8,\"n2\":2}'" '"minIdle":2'

say "springops Quartz"
check "jobs 清单（cron/nextFireTime）" "curl -s -X POST $API/springops -d '{\"action\":\"jobs\"}'" '"cron":"0/30'
check "job_trigger 手动触发" "curl -s -X POST $API/springops -d '{\"action\":\"job_trigger\",\"name\":\"demoTrigger\"}'" '"matched":1'
Q1=$(curl -s "$APP/demo/stats" | grep -o 'quartz=[0-9]*' | tr -d 'quartz=')
check "job_set 热改 cron 每秒" "curl -s -X POST $API/springops -d '{\"action\":\"job_set\",\"name\":\"demoTrigger\",\"n1\":\"* * * * * ?\"}'" '"matched":1'
sleep 4; Q2=$(curl -s "$APP/demo/stats" | grep -o 'quartz=[0-9]*' | tr -d 'quartz=')
if [ $((Q2-Q1)) -ge 3 ]; then PASS=$((PASS+1)); echo "  ✅ 热改后速率加快($((Q2-Q1))/4s)";
else FAIL=$((FAIL+1)); echo "  ❌ cron 未生效($((Q2-Q1))/4s)"; fi
check "非法 cron 友好拒绝" "curl -s -X POST $API/springops -d '{\"action\":\"job_set\",\"name\":\"demoTrigger\",\"n1\":\"bad\"}'" 'cron 表达式非法'
check "job_pause 暂停" "curl -s -X POST $API/springops -d '{\"action\":\"job_pause\",\"name\":\"demoTrigger\",\"flag\":false}'" '"op":"pause"'
Q3=$(curl -s "$APP/demo/stats" | grep -o 'quartz=[0-9]*' | tr -d 'quartz=')
sleep 2.5; Q4=$(curl -s "$APP/demo/stats" | grep -o 'quartz=[0-9]*' | tr -d 'quartz=')
if [ $((Q4-Q3)) -eq 0 ]; then PASS=$((PASS+1)); echo "  ✅ 暂停生效(增量0)";
else FAIL=$((FAIL+1)); echo "  ❌ 暂停未生效($((Q4-Q3))/2.5s)"; fi
check "resume 恢复" "curl -s -X POST $API/springops -d '{\"action\":\"job_pause\",\"name\":\"demoTrigger\",\"flag\":true}'" '"matched":1'

say "springops Caffeine TTL"
check "cache_ttl 查看当前 TTL" "curl -s -X POST $API/springops -d '{\"action\":\"cache_ttl\",\"name\":\"demoCache\"}'" 'ttlSeconds'
curl -s "$APP/demo/cache/a" > /dev/null
C5=$(curl -s "$APP/demo/stats" | grep -o 'compute=[0-9]*' | tr -d 'compute=')
check "cache_ttl 设 1 秒过期" "curl -s -X POST $API/springops -d '{\"action\":\"cache_ttl\",\"name\":\"demoCache\",\"n2\":1}'" '"applied":true'
sleep 2
curl -s "$APP/demo/cache/a" > /dev/null
C6=$(curl -s "$APP/demo/stats" | grep -o 'compute=[0-9]*' | tr -d 'compute=')
if [ $((C6-C5)) -ge 1 ]; then PASS=$((PASS+1)); echo "  ✅ TTL 过期生效($C5→$C6)";
else FAIL=$((FAIL+1)); echo "  ❌ TTL 未生效($C5→$C6)"; fi

say "springops Hibernate 2LC"
check "首读加载 2LC" 'curl -s '"$APP"'/huser/1' '1:u1'
check "直改库绕过缓存" 'curl -s -X POST "$APP'/huser/1/direct-update/u1-edited'"' 'db-updated'
check "脏读现场（仍 u1）" 'curl -s '"$APP"'/huser/1' '1:u1'
check "hcaches region 清单" "curl -s -X POST $API/springops -d '{\"action\":\"hcaches\"}'" 'com.demo.CachedUser'
check "hcache_evict 清 region" "curl -s -X POST $API/springops -d '{\"action\":\"hcache_evict\",\"name\":\"com.demo.CachedUser\"}'" 'evictRegion'
check "清理后读到新值" 'curl -s '"$APP"'/huser/1' 'u1-edited'

say "springops Dubbo / XXL-Job"
check "dubbos provider 清单" "curl -s -X POST $API/springops -d '{\"action\":\"dubbos\"}'" '\"interface\":\"com.demo.DemoDubboApi\"'
check "xxljobs handler 清单" "curl -s -X POST $API/springops -d '{\"action\":\"xxljobs\"}'" 'demoXxlHandler'
check "xxljob_trigger 直调" "curl -s -X POST $API/springops -d '{\"action\":\"xxljob_trigger\",\"name\":\"demoXxlHandler\"}'" '\"costMs\":'

check "dubbo_invoke 泛化调用 hello" "curl -s -X POST $API/springops -d '{\"action\":\"dubbo_invoke\",\"name\":\"DemoDubboApi\",\"n1\":\"hello\",\"args\":\"[\\\"e2e\\\"]\"}'" 'dubbo-hello:e2e'
check "dubbo_invoke add 数字转换" "curl -s -X POST $API/springops -d '{\"action\":\"dubbo_invoke\",\"name\":\"DemoDubboApi\",\"n1\":\"add\",\"args\":\"[20,22]\"}'" '"result":"42"'

say "边界与防御"
check "空 body 友好报错(springops)" "curl -s -X POST $API/springops -d ''" 'action 需要'
check "空 body 友好报错(props)" "curl -s -X POST $API/props -H 'Content-Length: 0'" 'action 需要'
check "containers 无 MQ 优雅空列表" "curl -s -X POST $API/springops -d '{\"action\":\"containers\"}'" '"count":0'

echo
echo "════════ 结果: PASS=$PASS FAIL=$FAIL ════════"
[ $FAIL -eq 0 ]
