#!/usr/bin/env bash
# aiti-testagent e2e 测试：起 Spring Boot + TestAgent → 断言核心功能（含四轮深审修复点）→ 清理
# 用法: APP_JAR=/path/app.jar ./e2e-test.sh   （或默认 /tmp/spring-test/target/spring-test-1.0.jar）
# 退出码: 0=全过 1=有失败

set -u
APP_JAR="${APP_JAR:-/home/pi/workspace/pi-work/TestAgent/tests/spring-test/target/spring-test-1.0.jar}"
AGENT_JAR="${TESTAGENT_JAR:-/home/pi/workspace/pi-work/TestAgent/TestAgent/target/testagent-1.0.jar}"
pick_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT_HTTP=$(pick_port)
PORT_APP=$(pick_port)
CONF=/tmp/e2e-conf
PASS=0; FAIL=0

say() { echo; echo "═══ $1 ═══"; }
check() { # check "描述" "命令" "期望子串"
  local desc="$1" cmd="$2" expect="$3"
  local out; out=$(eval "$cmd" 2>&1)
  if echo "$out" | grep -q "$expect"; then PASS=$((PASS+1)); echo "  ✅ $desc";
  else FAIL=$((FAIL+1)); echo "  ❌ $desc"; echo "      实际: $(echo "$out" | head -c 140)"; fi
}

cleanup() {
  for p in $(ps -eo pid,args | grep "spring-test-1.0.jar --server.port=$PORT_APP" | grep -v grep | awk '{print $1}'); do kill -9 $p 2>/dev/null; done
  pkill -f "curl -s http://127.0.0.1:$PORT_APP" 2>/dev/null
  rm -rf "$CONF" ~/.cache/testagent/sessions
}
trap cleanup EXIT

[ -f "$APP_JAR" ] || { echo "缺少 $APP_JAR（先构建 Spring Boot 测试应用）"; exit 1; }
[ -f "$AGENT_JAR" ] || { echo "缺少 $AGENT_JAR"; exit 1; }

# ---- 起 Spring Boot（带 agent）----
cleanup; mkdir -p "$CONF"
cat > /tmp/e2e-run.sh <<EOF
#!/bin/bash
cd /tmp; echo \$\$ > /tmp/e2e.pid
export TESTAGENT_ENABLE=1 TESTAGENT_HTTP_PORT=$PORT_HTTP TESTAGENT_BASEPATH= TESTAGENT_CONF=$CONF
exec /home/pi/workspace/pi-work/pi-web-ext/aiti-testagent/testagent-java java -jar $APP_JAR --server.port=$PORT_APP >> /tmp/e2e.log 2>&1
EOF
chmod +x /tmp/e2e-run.sh; rm -f /tmp/e2e.log /tmp/e2e.pid
setsid /tmp/e2e-run.sh < /dev/null &
for i in $(seq 1 40); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_HTTP/api/ping >/dev/null 2>&1 && break; done
for i in $(seq 1 8); do sleep 1; curl -s --max-time 1 http://127.0.0.1:$PORT_APP/existing >/dev/null 2>&1 && break; done
say "基础"
check "ping" 'curl -s http://127.0.0.1:'$PORT_HTTP'/api/ping' '"pong":true'
check "discover 注册" 'ls ~/.cache/testagent/sessions/' '\.json'
check "metrics" 'curl -s http://127.0.0.1:'$PORT_HTTP'/api/metrics' 'heapUsedMB'
check "threads 含 cpuMs" 'curl -s http://127.0.0.1:'$PORT_HTTP'/api/threads' 'cpuMs'
check "status" 'curl -s http://127.0.0.1:'$PORT_HTTP'/api/status' 'httpPort'

say "eval"
check "eval ognl" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/eval -H "Content-Type: application/json" -d "{\"expr\":\"@com.demo.ExistingController@class.getName()\"}"' 'com.demo.ExistingController'
check "eval code 改状态" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/eval -H "Content-Type: application/json" -d "{\"code\":\"java.lang.System.setProperty(\\\"e2e-key\\\",\\\"v\\\"); return \\\"ok\\\";\"}"' '"result":"ok"'
check "eval 错误清晰" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/eval -H "Content-Type: application/json" -d "{\"expr\":\"1/0\"}"' 'ArithmeticException'

say "写代码热更新（fat jar 假成功回归）"
check "整类替换返回 replaced" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/code -H "Content-Type: application/json" -d "{\"source\":\"package com.demo;\\nimport org.springframework.web.bind.annotation.*;\\n@RestController\\npublic class ExistingController {\\n    @GetMapping(\\\"/existing\\\")\\n    public String existing() { return \\\"E2E-REPLACED\\\"; }\\n}\"}"' '"action":"replaced"'
sleep 3
check "替换实际生效（fat jar 修复回归）" 'curl -s http://127.0.0.1:'$PORT_APP'/existing' 'E2E-REPLACED'
check "还原" 'curl -s -X DELETE "http://127.0.0.1:'$PORT_HTTP'/api/code/com.demo.ExistingController"' '"ok":true'
sleep 3
check "还原生效" 'curl -s http://127.0.0.1:'$PORT_APP'/existing' 'existing-controller'

say "watch + heapdump"
( sleep 0.5; curl -s http://127.0.0.1:$PORT_APP/existing > /dev/null ) &
check "watch 记录" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/watch -H "Content-Type: application/json" -d "{\"className\":\"com.demo.ExistingController\",\"method\":\"existing\",\"limit\":1,\"timeoutSec\":6}"' '"records":1'
check "watch 后 conf 清理" 'ls '$CONF'/ 2>/dev/null | wc -l' '^0$'
check "heapdump" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/heapdump -H "Content-Type: application/json" -d "{}"' 'sizeMB'

say "结构校验拒绝"
check "新增方法拒绝" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/code -H "Content-Type: application/json" -d "{\"source\":\"package com.demo;\\nimport org.springframework.web.bind.annotation.*;\\n@RestController\\npublic class ExistingController {\\n    public String extra() { return \\\"x\\\"; }\\n    @GetMapping(\\\"/existing\\\")\\n    public String existing() { return \\\"e\\\"; }\\n}\"}"' '新增方法'

say "monitor + tt + jad"
( sleep 0.5; curl -s http://127.0.0.1:'$PORT_APP'/existing > /dev/null; curl -s http://127.0.0.1:'$PORT_APP'/existing > /dev/null ) &
check "monitor 统计" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/monitor -H "Content-Type: application/json" -d "{\"className\":\"com.demo.ExistingController\",\"method\":\"existing\",\"timeoutSec\":4}"' '"count":'
( sleep 0.5; curl -s http://127.0.0.1:'$PORT_APP'/existing > /dev/null ) &
check "tt 时空隧道" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/tt -H "Content-Type: application/json" -d "{\"className\":\"com.demo.ExistingController\",\"method\":\"existing\",\"capacity\":5,\"timeoutSec\":4}"' '"records":'
check "jad 反编译" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/jad -H "Content-Type: application/json" -d "{\"className\":\"com.demo.ExistingController\"}"' 'public class'

say "attach 幂等（premain 已挂载 → attach 跳过）"
P=$(cat /tmp/e2e.pid)
check "attach 返回" 'java --add-modules jdk.attach -cp /home/pi/workspace/pi-work/pi-web-ext/aiti-testagent/attach-tool AttachTool '$P' '$AGENT_JAR' "conf='$CONF'" 2>&1' 'attached'
sleep 1
check "already attached 标记" 'grep -ac "already attached" /tmp/e2e.log' '1'
check "无第二 reload 监听" 'grep -ac "for refreshing configuration" /tmp/e2e.log' '1'

say "新命令（monitor/tt/trace/jad/sc/sm/classloader/mbean/dump/vmtool/logger/fs）"
( sleep 0.5; curl -s http://127.0.0.1:'$PORT_APP'/existing > /dev/null; curl -s http://127.0.0.1:'$PORT_APP'/existing > /dev/null ) &
check "monitor 统计" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/monitor -H "Content-Type: application/json" -d "{\"className\":\"com.demo.ExistingController\",\"method\":\"existing\",\"timeoutSec\":4}"' '"count":'
check "tt 时空隧道" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/tt -H "Content-Type: application/json" -d "{\"className\":\"com.demo.ExistingController\",\"method\":\"existing\",\"timeoutSec\":4}"' '"records":'
( sleep 0.5; curl -s http://127.0.0.1:'$PORT_APP'/existing > /dev/null; curl -s http://127.0.0.1:'$PORT_APP'/existing > /dev/null ) &
check "trace API" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/trace -H "Content-Type: application/json" -d "{\"className\":\"com.demo.ExistingController\",\"method\":\"existing\",\"timeoutSec\":4}"' '"ok":true'
check "jad 反编译" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/jad -H "Content-Type: application/json" -d "{\"className\":\"com.demo.ExistingController\"}"' 'public class'
check "sc 类搜索" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/sc -H "Content-Type: application/json" -d "{\"pattern\":\"com.demo.*\"}"' '"total":'
check "sm 方法列表" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/sm -H "Content-Type: application/json" -d "{\"className\":\"com.demo.ExistingController\"}"' 'methodCount'
check "classloader" 'curl -s http://127.0.0.1:'$PORT_HTTP'/api/classloader' 'loaders'
check "mbean" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/mbean -H "Content-Type: application/json" -d "{\"pattern\":\"java.lang:type=Memory\"}"' '"count":'
check "dump 类字节" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/dump -H "Content-Type: application/json" -d "{\"className\":\"com.demo.ExistingController\"}"' 'base64'
check "vmtool forceGc" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/vmtool -H "Content-Type: application/json" -d "{\"action\":\"forceGc\"}"' 'heapAfterMB'
check "logger logback" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/logger -H "Content-Type: application/json" -d "{\"name\":\"ROOT\",\"level\":\"DEBUG\"}"' 'logback'
check "vmoption" 'curl -s http://127.0.0.1:'$PORT_HTTP'/api/vmoption' 'inputArguments'
check "perfcounter" 'curl -s http://127.0.0.1:'$PORT_HTTP'/api/perfcounter' 'perfDataFile'
check "fs pwd" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/fs -H "Content-Type: application/json" -d "{\"op\":\"pwd\"}"' 'cwd'
check "eval 改状态" 'curl -s -X POST http://127.0.0.1:'$PORT_HTTP'/api/eval -H "Content-Type: application/json" -d "{\"code\":\"return \\\"eval-ok-\\\" + (1+1);\"}"' '"result":"eval-ok-2"'

say "Bean 替换 + 引用重定向"
HERE="$(cd "$(dirname "$0")" && pwd)"
cat > /tmp/e2e-isvc.json <<'JEOF'
{"source": "package com.demo;\npublic interface ISvc { String who(); }"}
JEOF
cat > /tmp/e2e-svcv1.json <<'JEOF'
{"source": "package com.demo;\nimport org.springframework.stereotype.Service;\n@Service\npublic class SvcV1 implements ISvc { public String who() { return \"V1\"; } }"}
JEOF
cat > /tmp/e2e-svcc.json <<'JEOF'
{"source": "package com.demo;\nimport org.springframework.web.bind.annotation.*;\n@RestController\npublic class Svcc { private final ISvc s; public Svcc(ISvc s){this.s=s;} @GetMapping(\"/svc\") public String g(){ return s.who(); } }"}
JEOF
cat > /tmp/e2e-svcv2.json <<'JEOF'
{"source": "package com.demo;\nimport org.springframework.stereotype.Service;\n@Service\npublic class SvcV2 implements ISvc { private String e=\"V2\"; public String who(){ return e; } }", "beanName": "svcV1"}
JEOF
check "注册接口" "python3 $HERE/e2e-helper.py $PORT_HTTP bean /tmp/e2e-isvc.json" '"type":"interface"'
check "注册实现V1" "python3 $HERE/e2e-helper.py $PORT_HTTP bean /tmp/e2e-svcv1.json" 'svcV1'
check "新建controller注入接口" "python3 $HERE/e2e-helper.py $PORT_HTTP code /tmp/e2e-svcc.json" '"/svc"'
sleep 1
check "V1 生效" "curl -s http://127.0.0.1:$PORT_APP/svc" 'V1'
check "replaceBean V2" "python3 $HERE/e2e-helper.py $PORT_HTTP bean_replace /tmp/e2e-svcv2.json" 'rebuiltControllers'
sleep 2
check "V2 生效（重定向）" "curl -s http://127.0.0.1:$PORT_APP/svc" 'V2'

say "Bean 生命周期（@Value / @PostConstruct / @ConfigurationProperties）"
printf '{"source": "package com.demo;\\nimport org.springframework.stereotype.Service;\\nimport org.springframework.beans.factory.annotation.Value;\\nimport jakarta.annotation.PostConstruct;\\n@Service\\npublic class LifeBean {\\n    @Value(\\"${server.port}\\") String port;\\n    String init = \\"NO\\";\\n    @PostConstruct void boot(){ init = \\"YES\\"; }\\n    public String report(){ return \\"port=\\" + port + \\" init=\\" + init; }\\n}"}' > /tmp/e2e-life.json
check "注册生命周期bean" "python3 $HERE/e2e-helper.py $PORT_HTTP bean /tmp/e2e-life.json" 'lifeBean'
check "@Value+@PostConstruct 生效" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/api/eval -H 'Content-Type: application/json' -d '{\"code\":\"Object c=com.teesoft.testagent.api.CodeOps.findSpringContext(); Object b=c.getClass().getMethod(\\\"getBean\\\",String.class).invoke(c,\\\"lifeBean\\\"); return String.valueOf(b.getClass().getMethod(\\\"report\\\").invoke(b));\"}'" 'port='$PORT_APP' init=YES'

printf '{"source": "package com.demo;\\nimport org.springframework.stereotype.Component;\\nimport org.springframework.boot.context.properties.ConfigurationProperties;\\n@Component\\n@ConfigurationProperties(prefix = \\"custom\\")\\npublic class HotConfig {\\n    private String demoName;\\n    private int count;\\n    public String getDemoName(){return demoName;} public void setDemoName(String v){demoName=v;}\\n    public int getCount(){return count;} public void setCount(int v){count=v;}\\n    public String report(){return demoName + \\":\\" + count;}\\n}"}' > /tmp/e2e-config.json
check "注册@ConfigurationProperties" "python3 $HERE/e2e-helper.py $PORT_HTTP bean /tmp/e2e-config.json" 'hotConfig'
check "配置绑定生效" "curl -s -X POST http://127.0.0.1:$PORT_HTTP/api/eval -H 'Content-Type: application/json' -d '{\"code\":\"Object c=com.teesoft.testagent.api.CodeOps.findSpringContext(); Object b=c.getClass().getMethod(\\\"getBean\\\",String.class).invoke(c,\\\"hotConfig\\\"); return String.valueOf(b.getClass().getMethod(\\\"report\\\").invoke(b));\"}'" 'hot-config-name:42'

say "结果: $PASS 通过 / $FAIL 失败"
[ "$FAIL" -eq 0 ] && echo "✅ 全部通过" || echo "❌ 有失败"
exit $FAIL
