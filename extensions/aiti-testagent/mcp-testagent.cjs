#!/usr/bin/env node
/**
 * aiti-testagent MCP server（stdio）——TestAgent 2.0 的 AI 调试入口
 *
 * 配合 aiti-devtools 生态：AI 通过标准 MCP 工具调用 TestAgent HTTP JSON API，
 * 实现 Java 后端"写代码热更新 / 新建 controller / 进程内表达式 / 诊断 / 性能采样"。
 *
 * 前置：目标 JVM 已挂载 TestAgent（启动 -javaagent 或 ta_attach 动态挂载），HTTP API 在
 * TESTAGENT_URL（默认 http://127.0.0.1:8564）。
 *
 * 注册：~/.config/mcp/mcp.json 加
 *   "aiti-testagent": { "command": "node", "args": ["<此文件路径>"] }
 *
 * 工具暴露控制（参数 / 环境变量两种机制，参数优先；白名单先选、黑名单后剔；都未配置=全部暴露）：
 *   参数：     node mcp-testagent.cjs --tools "lifecycle,ta_watch" --exclude "ta_heapdump"
 *              （--tools=x / --tools x 两种写法均可，--exclude 同）
 *   环境变量： TESTAGENT_TOOLS / TESTAGENT_EXCLUDE（同格式；同名字段被参数覆盖）
 *   spec 语法：逗号或空格分隔；每项可为——
 *              组名：lifecycle|observe|jvm|inspect|write|mock|startup|history（展开整组，定义见 TOOL_GROUPS）
 *              单个工具名：ta_watch
 *              通配：ta_mock_*（* 结尾前缀匹配）
 *              all 或 * ：全部
 *   效果：隐藏工具同时从 tools/list 消失、tools/call 服务端拒绝（agent 直呼也拦）
 */
const readline = require("node:readline");
const path = require("node:path");
// 发现/挂载/探活共享核心（lib/testagent-core.cjs）——IDE 面板（index.ts）与本 MCP server 复用同一实现
const { api: coreApi, safeParse, discoverJavaProcesses, discoverSessions, attachJava, waitForReady, ensureConnected, buildProcessTable,
  endpointHeaders, fetchEndpoints, tunnelAction, downloadFile, BASE, AGENT_JAR, DEFAULT_BASEPATH, bridgeConfigured, bridgeUseToken,
  startBridge, bridgeReady, bridgeStatus, saveBridgeConfig, loadBridgeConfig, bridgeBaseUrl, BRIDGE_HTTP_PORT_DEFAULT, BRIDGE_WS_PORT_DEFAULT,
  DEFAULT_CONF_DIR, TMP_DIR, agentPath, portOwnerPid, procCmd } = require("./lib/testagent-core.cjs");

// 平台：核心已跨平台移植（Linux ps/ss、Windows Cim/netstat、macOS ps/lsof；见 lib/testagent-core.cjs 头注释）。
// 挂载依赖 jdk.attach（Windows 走命名管道，同样可用）。

// ---------------- 命令行参数（CLI > 环境变量 > bridge.json）----------------
//   node mcp-testagent.cjs --auto-bridge --url http://127.0.0.1:8666 --endpoint <id> --token <端点token> \
//     --bridge-token <桥access-token> --bridge-http-port 8666 --bridge-ws-port 8667 \
//     --bridge-reg-token <注册token> --bridge-use-token <桥access-token>
// 兼容 --k=v 与 --k v 两种写法；与 --tools/--exclude 可混用。以下参数覆盖同名环境变量。
const CLI_OVERRIDES = (() => {
  const argv = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z][a-z0-9-]*)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    if (key === "auto-bridge") { o.autoBridge = true; continue; }
    if (key === "no-auto-bridge") { o.noAutoBridge = true; continue; }
    let val = m[2] !== undefined ? m[2] : "";
    if (m[2] === undefined && argv[i + 1] && !argv[i + 1].startsWith("--")) val = argv[++i];
    if (val !== "") o[key] = val;
  }
  return o;
})();
(function applyCliOverrides() {
  const c = CLI_OVERRIDES;
  const env = {
    url: "TESTAGENT_URL",
    endpoint: "TESTAGENT_ENDPOINT",
    token: "TESTAGENT_TOKEN",
    "bridge-token": "TESTAGENT_BRIDGE_USE_TOKEN",
    "bridge-http-port": "TESTAGENT_BRIDGE_HTTP_PORT",
    "bridge-ws-port": "TESTAGENT_BRIDGE_WS_PORT",
    "bridge-reg-token": "TESTAGENT_BRIDGE_REG_TOKEN",
    "bridge-use-token": "TESTAGENT_BRIDGE_USE_TOKEN",
  };
  for (const [k, e] of Object.entries(env)) {
    if (c[k]) process.env[e] = String(c[k]);
  }
  if (c.autoBridge) process.env.TESTAGENT_AUTO_BRIDGE = "1";
  if (c.noAutoBridge) process.env.TESTAGENT_AUTO_BRIDGE = "0";
})();

// ---------------- tunnel/bridge（方案 docs/tunnel-bridge-plan.md §5.5）----------------
// TESTAGENT_URL 指向 TaBridge 即整套切换（桥模式）：所有工具调用自动带 X-TA-Endpoint 由桥无脑转发。
// 桥配置双源：env TESTAGENT_URL > ~/.cache/testagent/bridge.json（aiti-testagent 扩展桥管理写入，core.BASE 已跟随）。
// endpoint 解析优先级：工具参数 endpoint > env TESTAGENT_ENDPOINT。空/self=直连本机，不带 header。
const CFG_BRIDGE = (() => { try { return bridgeConfigured(); } catch { return false; } })();
const CFG_USE_TOKEN = (() => { try { return bridgeUseToken(); } catch { return ""; } })();
const ENV_ENDPOINT = (process.env.TESTAGENT_ENDPOINT || "").trim();
const ENV_TOKEN = (process.env.TESTAGENT_TOKEN || "").trim();                 // 端点 token（高级加固：X-TA-Token）
const ENV_BRIDGE_USE_TOKEN = (process.env.TESTAGENT_BRIDGE_USE_TOKEN || "").trim(); // 桥使用 token（高级加固：X-TA-Bridge-Token，桥校验后剥离不下发）
let CURRENT_ENDPOINT = ENV_ENDPOINT;
// 统一鉴权/路由头（api 与 downloadFile 共用）：endpoint 寻址 + 端点 token + 桥使用 token
const apiHeaders = () => {
  const h = endpointHeaders(CURRENT_ENDPOINT);
  if (ENV_TOKEN) h["X-TA-Token"] = ENV_TOKEN;
  const useToken = ENV_BRIDGE_USE_TOKEN || CFG_USE_TOKEN;
  if (useToken) h["X-TA-Bridge-Token"] = useToken;
  return h;
};
const api = (method, path, body, port, basePath) => {
  const h = apiHeaders();
  return coreApi(method, path, body, port, basePath, h);
};
const isBridgeMode = () => !!ENV_ENDPOINT || CFG_BRIDGE || (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(BASE) && !!process.env.TESTAGENT_URL);

// ---------------- 启动即自建桥（可选；默认不自建）----------------
// TESTAGENT_AUTO_BRIDGE=1 或 --auto-bridge 开启。开启后：无显式外部桥（TESTAGENT_URL）且
// 无 e2e 隔离（TESTAGENT_BRIDGE_FILE）时，自动写默认 self 桥配置并拉起 TaBridge（8666/8667）
// ——之后 Java 进程加 -Dtestagent.bridge=ws://127.0.0.1:8667/ta/ws -Dtestagent.httpPort=0 即自动注册。
async function ensureBridge() {
  if (process.env.TESTAGENT_AUTO_BRIDGE !== "1") return; // 默认不自建；显式开启才建
  if (process.env.TESTAGENT_URL || process.env.TESTAGENT_BRIDGE_FILE) return; // 显式外部桥 / e2e 隔离
  try {
    const hp = Number(process.env.TESTAGENT_BRIDGE_HTTP_PORT) || BRIDGE_HTTP_PORT_DEFAULT;
    const wp = Number(process.env.TESTAGENT_BRIDGE_WS_PORT) || (hp + 1);
    const reg = (process.env.TESTAGENT_BRIDGE_REG_TOKEN || "").trim();
    const use = (process.env.TESTAGENT_BRIDGE_USE_TOKEN || "").trim();
    const cfg = loadBridgeConfig();
    // 无配置 → 自建默认 self；CLI/env 显式指定端口/token → 合并进 self 段（覆盖）
    const base = cfg && cfg.mode === "self" ? Object.assign({}, cfg.self || {}) : { httpPort: hp, wsPort: wp, regToken: reg, useToken: use };
    if (process.env.TESTAGENT_BRIDGE_HTTP_PORT) base.httpPort = hp;
    if (process.env.TESTAGENT_BRIDGE_WS_PORT) base.wsPort = wp;
    if (process.env.TESTAGENT_BRIDGE_REG_TOKEN) base.regToken = reg;
    if (process.env.TESTAGENT_BRIDGE_USE_TOKEN) base.useToken = use;
    const changed = !cfg || (cfg.mode === "self" && (
      process.env.TESTAGENT_BRIDGE_HTTP_PORT || process.env.TESTAGENT_BRIDGE_WS_PORT ||
      process.env.TESTAGENT_BRIDGE_REG_TOKEN || process.env.TESTAGENT_BRIDGE_USE_TOKEN));
    if (!cfg) saveBridgeConfig({ mode: "self", self: base });
    else if (changed) { cfg.self = base; saveBridgeConfig(cfg); }

    let st = await bridgeStatus(); // self 未运行会自动 spawn（可能尚未就绪）
    if (st.mode === "self" && !st.online && st.url) {
      const ready = await bridgeReady(st.url, use || undefined, 15000);
      if (ready) st = await bridgeStatus();
    }
    if (st.online && st.identityOk === false) {
      process.stderr.write(`[mcp-testagent] ⚠ 端口 ${st.url} 上已是另一个不同配置的 TaBridge（instanceId=${st.bridgeInstanceId}，期望=${st.instanceId}）。\n` +
        `  不会复用/不会重启它——请换 --bridge-http-port 或先停掉旧桥（MCP 回退直连模式）。\n`);
      return;
    }
    if (st.online) {
      const regHint = base.regToken ? ` -Dtestagent.bridge.token=${base.regToken}` : "";
      process.stderr.write(`[mcp-testagent] 自建桥就绪：${st.url}（ws ${st.ws}，在线端点 ${st.endpointCount}）\n` +
        `[mcp-testagent] Java 自动注册：-Dtestagent.bridge=${st.ws} -Dtestagent.httpPort=0${regHint}\n`);
    } else if (st.mode === "self") {
      process.stderr.write(`[mcp-testagent] 自建桥未就绪（${st.url}），MCP 回退直连模式；日志 ${path.join(TMP_DIR, "ta-bridge-*.log")}\n`);
    }
  } catch (e) { /* best-effort：失败不影响直连模式 */ }
}
ensureBridge();


// ---------------- MCP 工具 ----------------
const TOOLS = [
  { name: "ta_run", description: "启动 Java 应用并自动挂载 TestAgent：默认用 testagent-java 包装（-javaagent）；useJTO=true 时改用 JAVA_TOOL_OPTIONS 环境变量（应用自身脚本/嵌套 java/子进程全部自动挂载，适合 run 脚本启动的复杂应用）。启动后自动注册到发现机制（ta_discover 可见）。Spring Boot 应用建议在 jvmOpts 里加 -Dtestagent.springboot=true（一个开关=懒加载+mybatis延迟+启动分析+配置热刷新全家桶）。", inputSchema: { type: "object", properties: { app: { type: "string", description: "应用启动命令（jar 路径/主类/脚本），如 /path/app.jar 或 com.demo.Main 或 /path/run.sh" }, args: { type: "array", items: { type: "string" }, description: "额外参数（如 --server.port=8080）" }, springboot: { type: "boolean", description: "true=自动加 -Dtestagent.springboot=true（Spring Boot 开发全家桶：懒加载+mybatis延迟+启动分析+配置热刷新；也可用环境变量 TESTAGENT_SPRINGBOOT=true）" }, jvmOpts: { type: "array", items: { type: "string" }, description: "JVM 参数（如 -Dtestagent.springboot=true、-Xmx512m）" }, httpPort: { type: "number", description: "TestAgent HTTP 端口（默认 8564；多进程共用 JAVA_TOOL_OPTIONS 时建议省略→随机端口，session 记录真实端口）" }, useJTO: { type: "boolean", description: "true=用 JAVA_TOOL_OPTIONS（应用及其子进程全挂载）；false=testagent-java 包装（默认）" }, appPort: { type: "number", description: "应用自身端口（可选，记录用）" }, workdir: { type: "string" }, logFile: { type: "string", description: "应用日志文件（默认系统临时目录下 testagent-app-<时间戳>.log）" } }, required: ["app"] } },
  { name: "ta_login", description: "【自动登录】用户只需指定用户名密码（也可 -D 预设启动零配置），自主登录代码为首选路径：① mode=code + code=Java 代码块（{{username}}/{{password}} 占位符注入凭据；return token 串 / {\"token\":..,\"cookie\":..} JSON / 任意非空令牌串均可）——用户自主指定怎么登录；② 自动发现（扫 *Login*/*Auth* Service.login 反射调用 / 真实登录接口 loopback POST）——用户只给 username+password 其余全自动；③ token 直用。三种方式下 TestAgent 均插桩 Tomcat Response：鉴权要回 401 时自动①进程内登录生成 token/session/cookie → ②原请求加登录态 header 后重放（走完整 filter 链）→ 客户端直接拿到重放后的正常响应——裸 curl 调接口即可，无需手工带 token。actions：save=存凭据/代码+当场登录验证一次确保成功（失败直接 ok:false 带 tried 明细）；exec=试运行登录代码（可未 save，临时凭据/代码均可，成功即缓存登录态）；status=拦截/登录态（脱敏）；test=强制重登看 tried 明细；on/off=开关拦截（摘除即字节码还原）；delete=清凭据。参数：username/password=凭据（代码占位符注入用）；code=登录代码；mode=auto|code|eval|http|token（缺省 auto：code 优先→自动发现→接口兜底）；url/className/method=显式指定登录接口或类.方法；tokenPath=响应 token 的 jsonpath；headers=[{name,value}] 自定义注入头（$token/$cookie 占位，如自研 header [{name:\"token\",value:\"$token\"}]）；detect=[401,403] 拦截码。-D 预设（启动零配置自动启用）：-Dtestagent.login.username/password/code/token/mode/url/className/method/tokenPath/ttlSec/detect。事件查 ta_capture type=autologin；凭据存 .testagent/private/conf 0600 文件（gitignore 保护不入库），history/回显全脱敏。已知边界：控制器内 @RequestBody 后才鉴权的 POST 无法忠实重放（放行原 401 并记事件）；Jetty/Undertow 暂不支持（save 如实提示）。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["save", "exec", "status", "test", "on", "off", "delete"], description: "save=存凭据/代码+当场验证登录确保成功（缺省）；exec=试运行登录代码（可未 save，成功即缓存登录态）；status=当前状态；test=强制重登看 tried 明细；on/off=开关拦截；delete=清除" }, username: { type: "string", description: "登录用户名（代码占位符 {{username}} 注入用）" }, password: { type: "string", description: "登录密码（{{password}} 注入；history/回显脱敏）" }, code: { type: "string", description: "【自主登录代码·首选】Java 代码块（eval 机制执行），如：return com.demo.AuthService.login(\"{{username}}\", \"{{password}}\"); —— return token 串 / {\"token\":..,\"cookie\":..} JSON / 任意非空令牌串均可；引用热加载/不可见类直接写全限定名（自动转反射）" }, token: { type: "string", description: "已有 token（token 模式直接用，不做登录）" }, mode: { type: "string", enum: ["auto", "code", "eval", "http", "token"], description: "登录方式（缺省 auto：code→自动发现→接口兜底）" }, url: { type: "string", description: "登录接口路径（http 模式/auto 兜底；如 /api/login）" }, className: { type: "string", description: "登录类全限定名（eval 模式显式指定，自动发现不中时给）" }, method: { type: "string", description: "登录方法名（配合 className；缺省 login）" }, tokenPath: { type: "string", description: "响应/对象里 token 的 jsonpath（如 data.token；缺省自动探测常见字段名+JWT 格式）" }, appPort: { type: "number", description: "应用自身端口（http 登录用；缺省自动学习）" }, headers: { type: "array", description: "重放时注入的自定义 header：[{name:\"token\",value:\"$token\"}]（value 支持 $token/$cookie 占位；缺省 Authorization: Bearer + Cookie）", items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } } } }, detect: { type: "array", description: "拦截的状态码（缺省 [401]；可 [401,403]）", items: { type: "number" } }, bodyTap: { type: "boolean", description: "body tap（默认开）：插桩 InputBuffer.realReadBytes 累积请求体——控制器内 @RequestBody 后才鉴权的 POST 也能重放 body；false 关闭" }, detectRedirect: { type: "boolean", description: "302→登录页识别（默认关；opt-in）：sendRedirect 的 Location 命中 login/signin/sso/auth 时当 401 处理——避免误伤业务重定向，仅在应用用重定向到登录页而非 401 时开启" }, port: { type: "number", description: "目标 TestAgent HTTP 端口（ta_discover 的 httpPort；默认 8564）" } } } },
  { name: "ta_ping", description: "检查目标 JVM 的 TestAgent HTTP API 是否在线（目标是否挂载了 agent）", inputSchema: { type: "object", properties: { port: { type: "number", description: "目标 TestAgent HTTP 端口（ta_discover 的 httpPort；默认 8564）" } } } },
  { name: "ta_attach", description: "把 TestAgent 动态挂载到本机已运行的 Java 进程（agentmain，无需重启），挂载后自动等待 HTTP API 就绪并直接返回 httpPort。发现后端：ta_discover；一键扫描+挂载+接通用 ta_bridge。", inputSchema: { type: "object", properties: { pid: { type: "string", description: "Java 进程 pid（ta_discover 查）" }, bridgeToken: { type: "string", description: "注册 token（可选；桥配了 --reg-token 时必带——TA hello 携带，注册后通道内不再出现）" } }, required: ["pid"] } },
  { name: "ta_bridge", description: "【一键连桥】扫描本机 Java 进程 → 挂载 TestAgent → 等待 HTTP API 就绪，一步接通调试链路。action=connect（缺省）：pid 指定目标；省略 pid 时——已有在线会话直接返回其 httpPort，唯一候选进程自动挂载，多候选列出 pid 供选择。action=status：已挂载会话（含在线探测）+ 候选 Java 进程概览。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["connect", "status"], description: "connect=扫描+挂载+接通（缺省）; status=概览" }, pid: { type: "string", description: "目标 Java 进程 pid（connect 可选；省略时自动选择）" } } } },
  { name: "ta_discover", description: "发现调试目标：① 已挂载 TestAgent 的进程（读 ~/.cache/testagent/sessions，含 httpPort，active=可直接用；active 时额外带 login=自动登录态 {enabled,creds,material,source,mode}）② 本机其他 Java 进程（可用 ta_attach 挂载）", inputSchema: { type: "object", properties: {} } },
  { name: "ta_code", description: "【写代码热更新】提交 Java 源码到运行中的 JVM：类已加载→结构校验+热替换方法体（结构变化在 JBR/DCEVM 运行时自动走 redefine 直换——新增字段/方法直接生效；非 JBR 环境结构变化拒绝，backend=redo 可显式退回既有拒绝语义）；类未加载→新建加载+框架注册（@RestController 自动 registerMapping，新建 controller 直接生效）。port 参数用 ta_discover 返回的 httpPort（多个挂载进程时指定目标）。", inputSchema: { type: "object", properties: { source: { type: "string", description: "完整 Java 源码（package + public class）" }, register: { type: "string", enum: ["auto", "spring", "none"], description: "新建类时的框架注册模式（auto 自动检测注解）" }, backend: { type: "string", enum: ["auto", "redo"], description: "结构变化后端：auto=缺省（JBR/DCEVM 上 redefine 直换，非 JBR 拒绝）；redo=显式 opt-out（结构变化退回拒绝/组 loader 模拟语义）" }, port: { type: "number", description: "目标 TestAgent HTTP 端口（ta_discover 的 httpPort；默认 8564）" } }, required: ["source"] } },
  { name: "ta_restore", description: "移除热更新代码（DELETE /api/code）：新建类→unregisterMapping 回滚；已替换类→热还原原始字节码", inputSchema: { type: "object", properties: { className: { type: "string", description: "类全限定名（com.demo.Foo）" } }, required: ["className"] } },
  { name: "ta_method", description: "方法体级热更新（无结构限制）：改方法返回值/加延迟/抛异常/插桩/mock。属性：body（替换方法体）/insertBefore（开头插入，可 return 改返回值）/insertAfter/sleep/exception/filter/mock.xxx", inputSchema: { type: "object", properties: { className: { type: "string" }, method: { type: "string" }, body: { type: "string" }, insertBefore: { type: "string" }, insertAfter: { type: "string" }, sleep: { type: "string" }, exception: { type: "string" }, filter: { type: "string" } }, required: ["className", "method"] } },
  { name: "ta_eval", description: "进程内表达式（ognl 风格）：@类名@成员（私有/静态/链式反射访问）+ 任意 Java 表达式（public 可见）；code 模式给完整语句块。可读状态/改状态/调方法。示例：@com.demo.MyService@instance.counter 或 System.getProperty(\"java.version\")", inputSchema: { type: "object", properties: { expr: { type: "string", description: "单表达式" }, code: { type: "string", description: "完整语句块（多语句，需 return）" } } } },
  { name: "ta_conf", description: "声明式 conf 管理（return/sleep/exception/mock 快路径）+ 查看当前注入清单", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "write", "delete"] }, name: { type: "string", description: "conf 名（write/delete 需要）" }, content: { type: "string", description: "conf 内容（write 需要）" } } } },
  { name: "ta_status", description: "当前状态：conf 清单、已注入类（transformedClasses）、端口信息", inputSchema: { type: "object", properties: {} } },
  { name: "ta_metrics", description: "JVM 指标：堆内存/线程数/GC/类加载/uptime（dashboard）", inputSchema: { type: "object", properties: {} } },
  { name: "ta_threads", description: "线程栈增强：全量栈+每线程 CPU 时间降序 topN；state=按状态过滤（RUNNABLE/BLOCKED/WAITING/TIMED_WAITING…）；deadlock=true 死锁检测并单列（Arthas thread -b）；utilMs>0 返回两拍 CPU 利用率%（Arthas thread -i）。卡死/阻塞/最忙线程排查首选。", inputSchema: { type: "object", properties: { limit: { type: "number", description: "返回前 N 个（按 CPU 降序，默认 20）；≤0=返回全部" }, state: { type: "string", description: "按状态过滤（如 BLOCKED、WAITING、TIMED_WAITING）" }, deadlock: { type: "boolean", description: "true=检测死锁（findDeadlockedThreads+monitor 集合，结果在 deadlockedThreads）" }, utilMs: { type: "number", description: "CPU 利用率采样间隔 ms（50-2000，建议 300；一次测量非轮询）" }, port: { type: "number" } } } },
  { name: "ta_memory", description: "JVM 内存分池明细（Arthas memory 等价）：eden/survivor/old/metaspace/codeCache 各池 used/committed/max/peakUsed + DirectBuffer(count/capacity)。内存增长定位、metaspace 泄漏排查第一入口。", inputSchema: { type: "object", properties: { port: { type: "number" } } } },
  { name: "ta_sysprop", description: "系统属性（Arthas sysprop 等价）：action=list 全部排序清出 / get 单个 / set 进程内写入 / clear 清除——set|clear 已记 history 审计且重启失效。调开关型属性（如禁用某特性）用完记得还原。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "get", "set", "clear"] }, key: { type: "string" }, value: { type: "string", description: "set 时的值" }, port: { type: "number" } }, required: ["action"] } },
  { name: "ta_sysenv", description: "环境变量只读清单（Arthas sysenv 等价），search 子串过滤 key。JVM 规范不支持运行时改 env——本工具如实只读。", inputSchema: { type: "object", properties: { search: { type: "string", description: "key 子串过滤" }, port: { type: "number" } } } },
  { name: "ta_profile", description: "JFR 采样三种模式（N 秒 ≤120）：type=cpu（缺省，执行采样→栈顶方法命中率+JFR 文件）；alloc=对象分配采样（按字节聚合 top 类——内存泄漏/大对象排查，JDK 11+）；wall=挂钟线程栈采样（含 BLOCKED/WAITING 等 CPU 采样看不到的等待——锁竞争/线程饥饿排查）。返回 top 命中列表 + JFR 文件路径。", inputSchema: { type: "object", properties: { seconds: { type: "number", description: "采样秒数（默认 10）" }, type: { type: "string", enum: ["cpu", "alloc", "wall"], description: "缺省 cpu" }, port: { type: "number" } } } },
  { name: "ta_watch", description: "观察目标方法调用：插桩记录 参数/返回值/耗时/调用栈（limit 条后自动摘除）。costMs=耗时门槛（只记 ≥N ms 的调用，Arthas '#cost>N' 等价）；filter=参数包含子串（deepToString 后 contains，Arthas 参数条件过滤轻量版）；高频方法建议必配其一。先调 ta_watch 启动观察（limit/timeoutSec），同时让应用触发该方法（如调用接口），返回观察记录。排查『这个方法被谁调、传了什么、返回什么、多慢』首选。", inputSchema: { type: "object", properties: { className: { type: "string", description: "类全限定名" }, method: { type: "string", description: "方法名" }, limit: { type: "number", description: "记录条数（默认 1）" }, timeoutSec: { type: "number", description: "等待秒数（默认 5，≤120）" }, costMs: { type: "number", description: "只记录耗时 ≥ 此值的调用（毫秒；不传=全记）" }, filter: { type: "string", description: "参数序列化后包含此子串才记录（≤200 字符）" }, port: { type: "number" } }, required: ["className", "method"] } },
  { name: "ta_heapdump", description: "JVM 堆转储（hprof 文件），返回文件路径+大小（内存泄漏分析）。落盘在端点侧——MCP 本机分析用 ta_download 取回（直连端点 port 才可流式）。", inputSchema: { type: "object", properties: { path: { type: "string", description: "输出路径（默认目标 JVM 的系统临时目录下 testagent-heap-*.hprof）" }, port: { type: "number" } } } },
  { name: "ta_download", description: "从端点下载文件到 MCP 本机（S8 大文件闭环：ta_heapdump/ta_profile 落盘后取回做本地分析；meta=true 只查元数据）。直连端点（port）可流式落盘；经桥（endpoint）只回元数据+直连提示（端点在 NAT 后不可直达）。", inputSchema: { type: "object", properties: { path: { type: "string", description: "端点侧文件绝对路径（如 ta_heapdump 返回的 hprof 路径）" }, dest: { type: "string", description: "本地保存路径（缺省 os.tmpdir()/testagent-dl-<文件名>）" }, meta: { type: "boolean", description: "true=只查元数据（存在性/大小），不下载" }, port: { type: "number" } }, required: ["path"] } },
  { name: "ta_monitor", description: "调用统计：观察目标方法 N 秒，返回调用次数/平均耗时/最大耗时/最近 5 次（Arthas monitor 等价）", inputSchema: { type: "object", properties: { className: { type: "string" }, method: { type: "string" }, timeoutSec: { type: "number", description: "统计秒数（默认 5）" }, port: { type: "number" } }, required: ["className", "method"] } },
  { name: "ta_tt", description: "时空隧道（Arthas tt 等价+回放闭环）：不带 action=同步录制 N 秒返回记录（旧瞬时模式）；action=start=建常驻录制（TTL 到期自动摘除）；records=游标列出录制（seq 即回放句柄）；play=用录制的原始参数+this 真实重放原方法（返回 oldRet/newRet/identical——副作用自负，进 history 审计）；poke=对录制内对象（arg0/ret/this）求 Java 表达式（tt -w 等价，对象变量名 o）；stop=摘除。剧本：start → 触发业务 → records → play 对比行为变化 → poke 深挖对象 → stop。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["start", "records", "play", "poke", "stop"], description: "缺省=同步录制（旧模式）" }, className: { type: "string" }, method: { type: "string" }, capacity: { type: "number", description: "环形容量（start 默认 20/旧模式默认 20）" }, timeoutSec: { type: "number", description: "旧模式录制等待秒数（默认 5）" }, ttlMin: { type: "number", description: "start：存活分钟（默认 60，max 1440）" }, ttlSec: { type: "number", description: "start：存活秒（优先于 ttlMin）" }, id: { type: "string", description: "records/play/poke/stop 必填：start 返回的 job id" }, since: { type: "number", description: "records 游标（seq）" }, limit: { type: "number", description: "records 单次条数（默认 100）" }, index: { type: "number", description: "play/poke 必填：记录 seq" }, target: { type: "string", description: "poke 目标：arg0/arg1/.../args/ret/this（缺省 args）" }, expr: { type: "string", description: "poke 必填：Java 表达式（对象变量名 o，如 o.getName()）" }, port: { type: "number" } } } },
  { name: "ta_jad", description: "源码级反编译目标类（CFR 内嵌——Arthas 同款方案，进程内执行；WebUI/Terminal/MCP 四面同源）：返回可读 Java 源码（业务逻辑/方法体可见）。mode=asm 回落 javap 反汇编（看字节码/签名）。CFR 失败自动回落 javap。", inputSchema: { type: "object", properties: { className: { type: "string" }, mode: { type: "string", enum: ["cfr", "asm"], description: "缺省 cfr（源码级）；asm=javap 反汇编" }, port: { type: "number" } }, required: ["className"] } },
  { name: "ta_xml", description: "【MyBatis mapper XML 热更新】提交 mapper XML 内容 → 热解析覆盖 MappedStatement（改 SQL 不重启立即生效）。排查 SQL 问题首选：改 XML → 调接口验证。", inputSchema: { type: "object", properties: { mapper: { type: "string", description: "mapper namespace（如 com.demo.mapper.UserMapper）" }, content: { type: "string", description: "完整 mapper XML（含 DOCTYPE，XML 里 < 用 &lt; 转义）" }, port: { type: "number" } }, required: ["mapper", "content"] } },
  { name: "ta_sc", description: "类搜索：已加载类按名字匹配（支持 * 通配）；detail=true 补 loader identity、来源 jar（codeSource）、修饰符/kind（Arthas sc -d——看『这个类在哪个 jar 里』）。看有哪些类/由谁提供。", inputSchema: { type: "object", properties: { pattern: { type: "string", description: "类名模式（如 com.demo.*）" }, detail: { type: "boolean", description: "true=带来源 jar/loader 详情" }, port: { type: "number" } } } },
  { name: "ta_sm", description: "方法搜索：类的声明方法列表（签名/修饰符）（Arthas sm）", inputSchema: { type: "object", properties: { className: { type: "string" }, port: { type: "number" } }, required: ["className"] } },
  { name: "ta_classloader", description: "类加载器增强：list=实例级清单（identity/各类数/URLClassLoader 的 urls/父链）/tree=同数据带 parentChain/resource=探测指定类能被哪些 loader 拿到字节（查『为什么这个类找不到』——未加载或仅 bootstrap 可见都会如实报告）。", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["list", "tree", "urls", "resource"] }, className: { type: "string", description: "mode=resource 时的目标类名" }, port: { type: "number" } } } },
  { name: "ta_mbean", description: "MBean 查询（如 java.lang:type=Memory）", inputSchema: { type: "object", properties: { pattern: { type: "string", description: "ObjectName 模式（默认 *:*）" }, port: { type: "number" } } } },
  { name: "ta_dump", description: "类字节码 dump（base64 + 大小）", inputSchema: { type: "object", properties: { className: { type: "string" }, port: { type: "number" } }, required: ["className"] } },
  { name: "ta_vmtool", description: "JVM 工具：forceGc（强制 GC 看堆回收）/ info（堆/类/线程概要）", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["forceGc", "info"] }, port: { type: "number" } } } },
  { name: "ta_trace", description: "方法耗时分析（Arthas trace 等价——子调用树）：tree=true（缺省）递归插桩入口方法+应用类子调用，返回层级耗时树（root/children/selfMs——慢在哪个子调用一目了然）；thresholdMs 剪枝小节点；exclude 追加排除包前缀（JDK/Spring 基础包默认排除）；tree=false=旧扁平 p95。注意：会插桩多个方法（结束自动还原）；插桩方法抛异常的批次丢弃（已知边界）。", inputSchema: { type: "object", properties: { className: { type: "string" }, method: { type: "string" }, timeoutSec: { type: "number", description: "采集窗口秒（默认 10）" }, tree: { type: "boolean", description: "true=子调用树（缺省）；false=旧扁平 p95" }, maxDepth: { type: "number", description: "调用图发现深度（默认 6，max 10）" }, maxNodes: { type: "number", description: "插桩方法数上限（发现 80）" }, thresholdMs: { type: "number", description: "剪枝：cost<阈值的子节点剔除" }, exclude: { type: "string", description: "额外排除包前缀（逗号分隔，如 org.apache.rocketmq.,io.netty.）" }, port: { type: "number" } }, required: ["className", "method"] } },
  { name: "ta_logger", description: "日志级别查看与热调（logback/log4j2 自动探测，无需重启）：不带 level=列出全部 logger 当前级别清单；带 name+level=改级别（排障看不到日志时先把目标 logger 调 DEBUG 再复现，用完还原）。", inputSchema: { type: "object", properties: { name: { type: "string", description: "logger 名（设置时必填；缺省列表模式下忽略）" }, level: { type: "string", enum: ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"], description: "不传=列出全部 logger 与当前级别" }, port: { type: "number" } } } },
  { name: "ta_vmoption", description: "JVM 可写诊断 flag 查看/热设（生产兜底神器）：不带 action=list 列出全部可写 flags（数量随 JDK 版本不同，含 HeapDumpOnOutOfMemoryError 等）；action=get 看 flag 现值/来源；action=set 运行时开启（set 后自动读回 verified=true 才算成功；写入 history 审计；重启失效）。OOM 前自动堆转储一条命令开上。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "get", "set"], description: "缺省=list" }, name: { type: "string", description: "flag 名（get/set 必填，如 HeapDumpOnOutOfMemoryError）" }, value: { type: "string", description: "set 的值（通常 true/false 或路径）" }, port: { type: "number" } } } },
  { name: "ta_perfcounter", description: "JVM 性能计数器文件定位（hsperfdata）", inputSchema: { type: "object", properties: { port: { type: "number" } } } },
  { name: "ta_fs", description: "文件命令：pwd（当前目录）/ ls（列目录，目录优先排序）/ cat（读文件）/ base64（文件转 base64）/ complete（路径前缀补全，autocomplete 用）", inputSchema: { type: "object", properties: { op: { type: "string", enum: ["pwd", "ls", "cat", "base64", "complete"] }, path: { type: "string", description: "文件路径（ls/complete/cat/base64 需要；complete 空串=列 cwd、/结尾=列目录全部、~ 展开）" }, port: { type: "number" } } } },
  { name: "ta_sql", description: "SQL 拦截/模拟（JDBC 插桩，所有驱动/ORM 生效）：start 拦截所有 SQL（内容/耗时/栈/URL）→ 触发请求 → dump 分析 → stop 摘除。filter(s)=只记录匹配（多规则任一命中；规则内 url/sql 子串双条件 AND）；inject(s)=按条件故障注入（exception 模拟失败 / delayMs 模拟延迟，多规则各自独立）；rewrite=改 SQL 片段（match/replaceFrom/replaceTo，replaceFrom 为 * 或空=整条替换）；simulate=calcite 在捕获的真实结果上执行改后 SQL（不改真实库——安全看结果，表名固定 RESULTS）。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["start", "stop", "dump", "simulate", "stats"] }, file: { type: "string", description: "输出文件（默认 /tmp/testagent-sql-<ts>.jsonl）" }, filter: { type: "object", description: "记录过滤（单条兼容）：{url:'/users', sql:'SELECT'}——只记录匹配的" }, filters: { type: "array", description: "记录过滤（多规则，任一匹配即记录）：[{url:'/users', sql:'SELECT'}, {url:'/orders', sql:null}]——规则内 url/sql 双条件 AND，空串=不限制该维度" }, inject: { type: "object", description: "故障注入（单条兼容）：{url:'/users', exception:'java.sql.SQLException: boom', delayMs:2000}" }, injects: { type: "array", description: "故障注入（多规则，各自独立 exception/delayMs，任一命中即按该条注入）：[{url:'/orders', sql:'SELECT', exception:'boom', delayMs:500}]" }, rewrite: { type: "array", description: "改 SQL：[{match:'FROM users', replaceFrom:'ORDER BY id', replaceTo:'ORDER BY age'}]——replaceFrom 为 * 或空=整条替换" }, sql: { type: "string", description: "simulate 的改后 SQL（如 SELECT * FROM RESULTS WHERE AGE<28）" }, port: { type: "number" } }, required: ["action"] } },
  { name: "ta_mock_url", description: "REST 接口 mock/篡改（按 URL——字节码插桩 DispatcherServlet，404 也拦）：mock（有 data）=整体替换返回值（样例复制+id 递增）；篡改（无 data 有 filter/copies）=放行真实请求→方法层篡改真实返回值（filter 为 WHERE 子句=过滤 / 完整 SELECT=改字段表达式；copies=jsonpath 列表复制）。status 可模拟 500。AI 调试：接口返回奇怪→先看真实→篡改调值→对比判断。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["add", "list", "delete"] }, url: { type: "string", description: "URL（* 结尾=前缀匹配；精确优先）" }, data: { type: "string", description: "样例 JSON（数组=List 复制；对象=整体替换；字符串值要带引号）" }, size: { type: "number", description: "复制条数（id 递增）" }, copies: { type: "array", description: "jsonpath 复制/设值：[{path:'$.data.orders', size:200},{path:'$.data.page.total', value:200}]" }, filter: { type: "string", description: "篡改：WHERE 子句（过滤）或完整 SELECT（改字段）——无 data 时生效（放行真实+方法层篡改）" }, status: { type: "number", description: "HTTP status（默认 200；500 模拟故障）" }, port: { type: "number" } }, required: ["url"] } },
  { name: "ta_mock_method", description: "方法级 mock/篡改（任意接口方法——类.方法匹配，字节码插桩改返回值）：有 data=纯 mock（样例替换+复制）；无 data 有 filter=篡改真实返回值（calcite 过滤/改字段）；无 data 有 copies=真实返回值上 jsonpath 复制。AI 调试：Service/Controller 任意方法返回值模拟。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["add", "list", "delete"] }, className: { type: "string", description: "全限定类名（com.x.OrderService）" }, method: { type: "string" }, data: { type: "string", description: "样例 JSON（List 方法用数组；String 方法用带引号字符串 \"x\"）" }, size: { type: "number" }, copies: { type: "array", description: "[{path:'', size:50}]——path 空=顶层数组复制" }, filter: { type: "string", description: "篡改：AGE<28（过滤）或 SELECT NAME, AGE+1 AS AGE FROM RESULTS（改字段）" }, port: { type: "number" } }, required: ["className", "method"] } },
  { name: "ta_startup", description: "启动优化分析：GET /api/startup-report 输出 Top 慢 bean（插桩 createBean 计时——Tomcat/大 bean 是懒加载或裁剪候选）。POST 启用分析插桩。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["report", "enable"] }, port: { type: "number" } } } },
  { name: "ta_mock_results", description: "拉取 mock/篡改拦截结果（type=mock/tamper-*——与 SQL 同统一捕获机制）：dump=取即清；list=不清。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["dump", "list"] }, port: { type: "number" } } } },
  { name: "ta_capture", description: "统一拦截结果端点（SQL/mock/篡改/URL mock 一个队列）：dump=按 type 拉取（sql/mock/tamper-filter/tamper-copies/url-mock）；list=不清；start/stop=开关统一 JSONL 文件；clear=清空。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["dump", "list", "start", "stop", "clear"] }, type: { type: "string", description: "过滤类型（sql/mock/tamper-filter/tamper-copies/url-mock；空=全部）" }, file: { type: "string", description: "start 时的 JSONL 输出文件" }, port: { type: "number" } } } },
  { name: "ta_job", description: "【后台常驻观测任务——偶发问题挂机抓取】Arthas 后台任务的 AI 原生形态：action=create 建常驻插桩（kind=watch 轻量快照/tt 保留原始参数供回放；TTL 到期自动摘除，用完放心），触发业务后 action=pull 用 since 游标拉增量（evicted=true 说明有记录被环形淘汰），list 看全部，delete 摘除。典型剧本：create(ttlMin=60) → 让用户/定时触发业务 → pull → delete。同方法与 watch/live 互斥。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["create", "list", "pull", "delete"], description: "缺省=list" }, kind: { type: "string", enum: ["watch", "tt"], description: "create 必填：watch=轻量快照（参数截断+栈）；tt=保留原始参数（供回放，内存开销高）" }, className: { type: "string", description: "create 必填：类全限定名" }, method: { type: "string", description: "create 必填：方法名" }, capacity: { type: "number", description: "环形容量（默认 200，max 2000，溢出淘汰最旧）" }, ttlMin: { type: "number", description: "存活分钟（默认 60，max 1440）" }, ttlSec: { type: "number", description: "存活秒（测试用，5-86400，优先于 ttlMin）" }, costMs: { type: "number", description: "create(kind=watch)：只记录耗时 ≥ 此值的调用（条件不命中不占环形容量）" }, filter: { type: "string", description: "create(kind=watch)：参数序列化后包含此子串才记录" }, id: { type: "string", description: "pull/delete 必填：job id" }, since: { type: "number", description: "pull 游标：只返回 seq>since（上次 nextSince）" }, limit: { type: "number", description: "pull 单次条数上限（默认 100，max 500）" }, port: { type: "number" } }, required: ["action"] } },
  { name: "ta_classwatch", description: "class 目录监听自动热加载：监听 maven target/classes / gradle build/classes / IDE 编译输出目录，.class 变化自动热替换（结构校验：一致→retransform 生效，不一致→拒绝提示）。LSP/IDE 保存即生效。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["start", "stop", "status"] }, dir: { type: "string", description: "class 目录（如 target/classes）" }, port: { type: "number" } }, required: ["action"] } },
  { name: "ta_lazy_module", description: "懒模块状态/手工激活（需启动时 -Dtestagent.lazy-module=true）：status=看当前状态（enabled/mode/packages/activated已激活/pendingDefinitions待加载/urlTriggers）；activate=手工激活一个模块（pkg=com.example.module1——通常不需要，URL 自动触发；排查/预加载时用）。启动优化闭环：ta_startup 量化→选模块→重启带 lazy 参数→本工具看激活状态。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["status", "activate"] }, pkg: { type: "string", description: "activate 时的包前缀（如 com.example.module1）" }, port: { type: "number" } }, required: ["action"] } },
  { name: "ta_urls", description: "列出应用已注册的 REST 端点（URL pattern + HTTP 方法 + handler 类.方法）——按 URL/method/handler 子串过滤（不区分大小写）。查看后端有哪些接口可用。", inputSchema: { type: "object", properties: { q: { type: "string", description: "过滤子串（url/method/handler 任一匹配，不区分大小写）" }, port: { type: "number" } } } },
  { name: "ta_bean", description: "Spring Bean 热注册/替换（需 testagent-spring 适配库与 agent 同目录）：register=新建 Bean（源码需 @Service/@Component/@Repository 注解，beanName 注册名）；replace=替换已有 Bean 实现（redirect=true 时引用自动重定向到新 bean——重建引用旧 bean 的 controller）。验证：ta_eval 或请求接口看新逻辑。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["register", "replace"] }, source: { type: "string", description: "Java 源码（含 package + 类注解）" }, beanName: { type: "string", description: "Bean 名（replace 时为要替换的目标 bean 名）" }, redirect: { type: "boolean", description: "replace 时是否重定向引用（默认 true）" }, port: { type: "number" } }, required: ["action", "source", "beanName"] } },
  { name: "ta_props", description: "【Spring 属性热刷新】不重启改配置：list=列出生效配置（按优先级展开 propertySources，search 过滤）；set=key/value 写 testagent 属性源（最高优先级）；refresh=重扫单例 Bean 的 @Value 字段+@ConfigurationProperties 重绑；watch_start/watch_status/watch_stop=监听 application.properties/yml 变化自动刷新。配合 ta_bean/ta_classwatch 实现改代码+改配置都不重启。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "set", "refresh", "watch_start", "watch_status", "watch_stop"] }, search: { type: "string", description: "list 时按 key/来源子串过滤" }, key: { type: "string", description: "set 时的属性名（如 app.demo.timeout）" }, value: { type: "string", description: "set 时的属性值" }, dir: { type: "string", description: "watch_start 时配置文件所在目录（缺省扫 cwd 与 cwd/config）" }, port: { type: "number" } }, required: ["action"] } },
  { "name": "ta_addr", "description": "【服务器地址透明替换】应用连不上某环境时把 from 地址重写为 to，覆盖所有 TCP 客户端（Socket.connect 万能兜底）与 JDBC（DriverManager.getConnection）：add=加规则（from 为 host:port，port 可省略=任意端口，支持 * 通配；含 :// 自动按 URL 字面/正则替换——如 jdbc:h2:mem:demo→demo2；to=目标地址）；list=规则+命中计数；delete=按 from 删；clear=清空。规则热增删立即生效，持久化 conf 目录（.testagent/conf，private/conf 同名文件优先）addr-redirect.rules 启动自动恢复。", "inputSchema": { "type": "object", "properties": { "action": { "type": "string", "enum": ["add", "delete", "clear", "list"] }, "from": { "type": "string", "description": "原地址：socket 型 host:port（如 unreachable.invalid:12345、*.internal:6379）或 URL 型（含 ://）" }, "to": { "type": "string", "description": "add 时的目标地址（如 127.0.0.1:19001）" }, "port": { "type": "number" } }, "required": ["action"] } },
  { "name": "ta_solon", "description": "【Solon 框架热操作】（需 testagent-solon 适配库；聚合开关 -Dtestagent.solon=true 一键融合 lazy-mybatis+启动分析+propwatch）：beans=AppContext bean 清单；urls=路由端点清单（url/method/handler 类.方法）；resolve=URL→处理方法（URL mock 篡改用）；props=Solon.cfg() 生效配置清单（n1 为 key 过滤）；setprop=内存级改属性（n1=key n2=value，不写 app.yml）；refresh=逐 bean 重跑 beanInject 热刷新 @Inject/${} 注入（改属性后必调，页面立即生效）；ctrl=注册控制器（name=类全限定名，先经 ta_code/ta_eval 加载，@Mapping 路由自动抽取）；reg=注册 bean（name=类全限定名，n2=bean 名可省）；caches/cache_evict=缓存 bean 清单/清缓存；pools/pool_set=Hikari 连接池查看/热调参（n1=maxPoolSize n2=minIdle）；executors/executor_set=线程池查看/热调（n1=core n2=max）；jobs=Quartz 任务清单（name 过滤）；job_trigger=手动触发一次；job_pause=暂停/恢复（flag=true 恢复）。", "inputSchema": { "type": "object", "properties": { "action": { "type": "string", "enum": ["beans", "urls", "resolve", "props", "setprop", "refresh", "ctrl", "reg", "caches", "cache_evict", "pools", "pool_set", "executors", "executor_set", "jobs", "job_trigger", "job_pause"] }, "name": { "type": "string", "description": "resolve=目标 URL；ctrl=控制器类名；pool_set/executor_set=bean 名；jobs=name 过滤；job_trigger/job_pause=job 名或 group.name" }, "n1": { "description": "props=key 过滤；setprop=属性 key；pool_set=maxPoolSize；executor_set=corePoolSize" }, "n2": { "description": "setprop=属性值；pool_set=minIdle；executor_set=maxPoolSize" }, "flag": { "type": "boolean", "description": "job_pause=true 恢复/false 暂停" }, "port": { "type": "number" } }, "required": ["action"] } },
  {"name": "ta_spring", "description": "【Spring 运行时组件热操作】不重启调运行时：caches/cache_evict/cache_ttl=缓存清单/清空/Caffeine TTL 热调；pools/pool_set=Hikari 连接池查看/热调 maxPoolSize/minIdle；executors/executor_set=线程池查看/热调 corePoolSize/maxPoolSize；scheds/sched_set=@Scheduled 定时任务清单/热重排（n1=cron 或 n2=周期毫秒）；jobs/job_set/job_trigger/job_pause=Quartz 任务清单/热改 cron/手动触发一次/暂停恢复；dubbos/dubbo_invoke=Dubbo 服务清单/进程内泛化调用（走完整 filter 链，args 为参数 JSON 数组）；xxljobs/xxljob_trigger=XXL-Job handler 清单/直调；hcaches/hcache_evict=Hibernate 二级缓存 region 清理；containers/container_set=消息监听容器暂停恢复。", "inputSchema": {"type": "object", "properties": {"action": {"type": "string", "enum": ["caches", "cache_evict", "cache_ttl", "pools", "pool_set", "executors", "executor_set", "scheds", "sched_set", "jobs", "job_set", "job_trigger", "job_pause", "dubbos", "dubbo_invoke", "xxljobs", "xxljob_trigger", "hcaches", "hcache_evict", "containers", "container_set"]}, "name": {"type": "string", "description": "目标名：cache 名 / bean 名 / 类.方法 / job 或 trigger 名 / 接口名；cache_evict 与 hcache_evict 用 * 全清"}, "n1": {"description": "pool_set=maxPoolSize(数字)；executor_set=corePoolSize(数字)；sched_set=cron 表达式(字符串)；job_set=cron 表达式(字符串)；dubbo_invoke=方法名"}, "n2": {"type": "number", "description": "pool_set=minIdle；executor_set=maxPoolSize；sched_set/cache_ttl=秒"}, "flag": {"type": "boolean", "description": "job_pause=false 暂停/true 恢复"}, "args": {"type": "string", "description": "dubbo_invoke 参数 JSON 数组字符串，元素按接口方法类型自动转换，如 \"[\\\"world\\\"]\" 或 \"[2,3]\""}, "port": {"type": "number"}}, "required": ["action"]}},
  { name: "ta_history", description: "操作历史审计/回放：每次 API 操作自动记录（type/name/params+结果）。search=搜历史（q 关键字全文/type 过滤/ok 成败）；save=另存当前操作为可复用配置；load=回放历史操作（还原+reload）；delete=删除历史文件。AI 自审计：改了什么/怎么还原。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["search", "save", "load", "delete"] }, q: { type: "string", description: "search 关键字（name/params/conf 全文）" }, type: { type: "string", description: "type 过滤（method/conf/mock-url/mock-method/sql/bean/xml/code/classwatch）" }, ok: { type: "string", enum: ["true", "false"], description: "成败过滤" }, name: { type: "string", description: "save 时的名字" }, file: { type: "string", description: "load/delete 时的历史文件名（如 2026-08-15/xxx.json）" }, port: { type: "number" } }, required: ["action"] } },
  { name: "ta_tunnel", description: "【tunnel 隧道管理（TaBridge 反向隧道，区别于 ta_bridge 的 attach 接通）】端点 JVM 经 WS 长连接注册到 TaBridge 后，所有 ta_* 工具经桥转发（X-TA-Endpoint 寻址）。status=端点侧隧道状态（state/endpointId/lastError）；connect=运行时补连（url=ws://bridge-host:8667；启动未连桥的端点事后接入；经桥带 endpoint 参数=远程补连）；disconnect=断开并停止重连。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["status", "connect", "disconnect"], description: "缺省 status" }, url: { type: "string", description: "connect 必填：桥 WS 地址 ws://host:8667（注意是端点视角——端点需网络可达该地址）" }, port: { type: "number" } } } },
  { name: "ta_native_modules", description: "枚举指定 Windows 进程的已加载模块（native 层：exe/dll 偏移/大小）。对应 wintrace proc.modules。", inputSchema: { type: "object", properties: { session_id: { type: "string", description: "wintrace 会话 ID（先通过 ta_native_attach 或 pi-web 面板获取）" } }, required: ["session_id"] } },
  { name: "ta_native_watch", description: "挂钩指定 Windows 进程的 native API（Detours inline hook）。返回事件流订阅 ID，后续通过 ta_native_events 读取。对应 wintrace watch.set。", inputSchema: { type: "object", properties: { session_id: { type: "string" }, module: { type: "string", description: "模块名（如 kernel32）" }, func_glob: { type: "string", description: "函数通配（如 CreateFile*|ReadFile）" } }, required: ["session_id", "module", "func_glob"] } },
  { name: "ta_native_stack", description: "抓取指定 Windows 进程的线程栈帧（含导出表最近符号解析的具名帧）。对应 wintrace proc.stack。", inputSchema: { type: "object", properties: { session_id: { type: "string" }, max_frames: { type: "number", description: "最大帧数（默认 30）" } }, required: ["session_id"] } },
  { name: "ta_native_detach", description: "卸载 wintrace agent 并还原全部钩挂（eject=true 零残留）。对应 wintrace proc.detach。", inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] } },

];

// ---------------- 工具暴露控制（白名单/黑名单；组或单个工具名） ----------------
// ---- wintrace ta_native_* 薄代理（bridge-integration-plan BR4）----
// HTTP 调 wintrace broker 8766 /api/rpc，4 个工具对标 TestAgent 惯用名
const WINTRACE_BROKER = process.env.WINTRACE_BROKER_HTTP || "http://127.0.0.1:8766";
async function wintraceRpc(method, params) {
  const res = await fetch(WINTRACE_BROKER + "/api/rpc", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params: params || {} }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error);
  return d;
}

const TOOL_GROUPS = {
  lifecycle: ["ta_run", "ta_ping", "ta_attach", "ta_discover", "ta_bridge"],
  observe:   ["ta_watch", "ta_monitor", "ta_tt", "ta_trace", "ta_job"],
  jvm:       ["ta_metrics", "ta_memory", "ta_threads", "ta_profile", "ta_heapdump", "ta_download", "ta_vmtool", "ta_classloader", "ta_mbean", "ta_vmoption", "ta_perfcounter", "ta_dump", "ta_sysprop", "ta_sysenv"],
  inspect:   ["ta_sc", "ta_sm", "ta_jad", "ta_fs", "ta_urls"],
  write:     ["ta_code", "ta_restore", "ta_method", "ta_eval", "ta_conf", "ta_xml", "ta_classwatch", "ta_bean", "ta_logger", "ta_props", "ta_spring", "ta_solon", "ta_addr"],
  mock:      ["ta_mock_url", "ta_mock_method", "ta_mock_results", "ta_capture", "ta_sql"],
  auth:      ["ta_login"],
  startup:   ["ta_startup", "ta_lazy_module"],
  history:   ["ta_history", "ta_status"],
  native:    ["ta_native_modules", "ta_native_watch", "ta_native_stack", "ta_native_detach"],
};

/** 解析 --tools/--exclude 参数（支持 --k=v 与 --k v 两种写法） */
function parseArgvFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--(tools|exclude)(?:=(.*))?$/);
    if (!m) continue;
    flags[m[1]] = m[2] !== undefined ? m[2] : (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "");
  }
  return flags;
}

/** spec → 工具名 Set：组名展开 / ta_x 精确 / prefix* 通配 / all|* 全部；未知项 stderr 警告并忽略 */
function parseToolSpec(spec, allNames) {
  const out = new Set();
  const warnUnknown = (item) => process.stderr.write(`[mcp-testagent] 警告: 工具过滤项未知，忽略: ${item}（组名：${Object.keys(TOOL_GROUPS).join("/")}）\n`);
  for (const item of String(spec).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) {
    if (item === "all" || item === "*") { allNames.forEach((n) => out.add(n)); continue; }
    if (TOOL_GROUPS[item]) { TOOL_GROUPS[item].forEach((n) => out.add(n)); continue; }
    if (item.endsWith("*")) {
      const pre = item.slice(0, -1);
      let hit = 0;
      allNames.forEach((n) => { if (n.startsWith(pre)) { out.add(n); hit++; } });
      if (!hit) warnUnknown(item);
      continue;
    }
    if (allNames.has(item)) out.add(item);
    else warnUnknown(item);
  }
  return out;
}

const FLAGS = parseArgvFlags(process.argv.slice(2));
const INCLUDE_SPEC = FLAGS.tools !== undefined ? FLAGS.tools : process.env.TESTAGENT_TOOLS;        // 白名单
const EXCLUDE_SPEC = FLAGS.exclude !== undefined ? FLAGS.exclude : process.env.TESTAGENT_EXCLUDE; // 黑名单
const ALL_TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const VISIBLE_TOOLS = (() => {
  const inc = INCLUDE_SPEC ? parseToolSpec(INCLUDE_SPEC, ALL_TOOL_NAMES) : null;
  const exc = EXCLUDE_SPEC ? parseToolSpec(EXCLUDE_SPEC, ALL_TOOL_NAMES) : null;
  return TOOLS.filter((t) => (!inc || inc.has(t.name)) && !(exc && exc.has(t.name)));
})();
const VISIBLE_NAMES = new Set(VISIBLE_TOOLS.map((t) => t.name));

// ---------------- tunnel/bridge：endpoint 参数统一注入 + 桥模式描述适配（§5.5）----------------
// 凡带 port 的工具自动追加 endpoint 参数（不手改 schema）；桥模式下描述前缀提示 AI 改用 endpoint 路由。
const BRIDGE_NOTE = "[桥模式] TESTAGENT_URL 指向 TaBridge：目标路由用 endpoint 参数（ta_discover 返回端点 id；单端点可省略——桥自动选唯一在线端点），port 仅作识别参考。";
for (const t of VISIBLE_TOOLS) {
  const props = t.inputSchema && t.inputSchema.properties;
  if (props && props.port) {
    props.endpoint = { type: "string", description: "桥模式目标端点 id（ta_discover 返回；单端点可省略）" };
    if (isBridgeMode()) t.description = BRIDGE_NOTE + " " + t.description;
  }
}
if (INCLUDE_SPEC || EXCLUDE_SPEC) {
  process.stderr.write(`[mcp-testagent] 工具暴露: ${VISIBLE_TOOLS.length}/${TOOLS.length}` +
    (INCLUDE_SPEC ? `  白名单=${INCLUDE_SPEC}` : "") + (EXCLUDE_SPEC ? `  黑名单=${EXCLUDE_SPEC}` : "") + "\n");
  if (VISIBLE_TOOLS.length === 0) process.stderr.write("[mcp-testagent] 警告: 过滤后没有任何工具暴露\n");
}

// ---------------- MCP stdio 协议 ----------------
const rl = readline.createInterface({ input: process.stdin, terminal: false });
let nextId = 1;
const toolsList = { tools: VISIBLE_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };

rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  const respondError = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message } }) + "\n");

  try {
    if (msg.method === "initialize") {
      respond({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, instructions: `TestAgent 2.0 —— 教你怎么调试运行中的 Java 后端（Spring Boot/任意 JVM）。所有操作可逆（delete/stop 还原），放心实验。

【第一步：找到目标】ta_discover → 目标进程的 httpPort → 之后的工具都传 port 参数（多进程必传）。没挂 agent → ta_attach（按 pid 动态挂载，无需重启）。

【工具分类】
· 偶发抓捕：ta_job（常驻观测任务——create 挂机 → 业务触发 → pull 游标拉增量 → delete；TTL 到期自动摘除）、ta_threads（死锁检测 deadlock=true/状态过滤 state/CPU 利用率 utilMs）、ta_memory（内存分池）、ta_profile/ta_heapdump（资源）、ta_jad（反编译）
· JVM 管理：ta_sysprop set/clear（系统属性热改，已审计）、ta_sysenv（环境变量只读）、ta_vmoption action=set（热开 HeapDumpOnOutOfMemoryError 等可写诊断 flag——生产兜底一条命令）、ta_classloader mode=resource（查类为什么加载不到）
· 改返回值：ta_mock_url（按 URL 拦接口）、ta_mock_method（按类.方法拦任意方法）、ta_method（改方法体/插桩）、ta_code（写 Java 源码热更新）、ta_conf（声明式）
· 模拟异常：ta_mock_url status=500/delayMs、ta_sql inject（SQL 失败 exception/延迟 delayMs）
· 验证修改：ta_sql simulate（calcite 内存执行改后 SQL——不改真实库，表名固定 RESULTS）、ta_eval（表达式）
· 启动优化：ta_startup report（Top 慢 bean——懒加载/裁剪候选）+ ta_lazy_module status（懒模块状态/激活——启动带 -Dtestagent.lazy-module=true 后看效果）
· 被登录拦截（401）时：ta_login save(username,password) 开启自动登录——TestAgent 拦截 server 401→进程内登录→改写请求重放，之后裸 curl 直接调接口即可；test 看试过哪些候选；事件查 ta_capture type=autologin
· Spring 组件热操作：ta_spring（清缓存/连接池线程池热调参/定时任务清单/Kafka-Rabbit 消费暂停恢复——不重启）；Spring Bean：ta_bean（热注册/替换——需 testagent-spring 适配库）；属性热刷新：ta_props（list 看生效配置 / set 写属性 / refresh 重绑 @Value+@ConfigurationProperties / watch 监听配置文件自动刷新）；历史审计：ta_history（搜/回放——AI 自查改了什么怎么还原）
· Solon 框架（运行时容器，轻量 Spring 平替）：ta_solon（beans/urls/resolve/props/setprop/refresh 热刷新 @Inject/\${}/ctrl 注册控制器/pools 连接池/executors 线程池/jobs Quartz 任务热操作——均不重启；应用侧一键 -Dtestagent.solon=true 融合 lazy-mybatis+启动分析+app.yml 监听热刷新）；
· 服务器地址替换：ta_addr（add/delete/clear/list——Socket/JDBC 连接透明重写，覆盖所有 Redis 客户端与 Hikari；规则热生效+持久化）

【调试工作流——先看真实 → mock 调值 → 快速判断】
1) 接口返回奇怪：先看真实（ta_watch 或 ta_mock_method 加 filter 查真实结果）→ 篡改调值（filter 过滤/改字段表达式/copies 复制数量）→ 请求接口对比 → 判断是数据问题还是逻辑问题。
2) 模拟故障：接口 500/慢（ta_mock_url status/delayMs）；SQL 失败/延迟（ta_sql inject）——测重试/回滚/降级/超时。
3) SQL 问题：ta_sql start → 触发请求 → dump（真实 SQL/耗时/栈）→ simulate 模拟改 SQL 看结果（不改库）→ rewrite 真改执行验证。
4) 快速改代码：ta_code 提交源码（新建 controller 自动注册）→ 验证 → ta_restore 还原。
5) 大数量/边界：copies size=200 或 10000（分页/性能）；篡改过滤到空（空列表 UI）。

【补充工作流——AI 正经能用】
6) 接手陌生代码（不知道类/方法）：ta_sc（按类名/接口搜）→ ta_sm（方法签名/返回值）→ ta_jad（CFR 源码级反编译——业务逻辑直接可读）→ 才知道怎么 mock/watch。
7) 性能排查（慢/卡/内存）：ta_threads（死锁/阻塞/线程状态）→ ta_metrics（指标）→ ta_profile（CPU 采样 Top 方法）→ ta_heapdump（内存对象）→ ta_watch（方法耗时）→ ta_trace（调用树找慢链路）。
8) 生产进程（不想重启）：ta_attach（动态挂载已运行 JVM——agentmain 无需重启）——先 attach 再调试。
9) 验证假设（改代码前）：ta_eval（进程内表达式试逻辑——不用改代码先看结果）→ 确认后再 ta_code。
10) 细粒度行为（不整体 mock）：ta_method（insertBefore 改参数/开头 return、sleep 延迟、exception 抛异常——改方法内部行为）。
11) 历史现场（"刚才发生了什么"）：ta_tt（记录方法调用回放——参数/返回值/异常）——问题复现后看记录定位。
12) 动态调日志/改 SQL 映射：ta_logger（运行时改日志级别——不重启）；ta_xml（MyBatis XML 热更新——不重启）。
13) 迭代开发：ta_classwatch（监听 class 目录——改代码自动热加载验证）→ ta_code（正式热更新）。
15) Spring Boot 一键开发模式：启动加 -Dtestagent.springboot=true = lazy-module 懒加载 + lazy-mybatis 注入延迟 + startup-report 启动分析开箱即用 + propwatch 配置文件监听自动刷新；子项可用 -Dtestagent.<name>=false 单独退出。
14) 改配置不重启：ta_props list（看当前生效值和来源）→ set（写新值）→ refresh（同步到已存在 Bean 的 @Value/@ConfigurationProperties）；或 watch_start 后直接改 application.properties/yml 文件自动生效。

【元规则】
· 先看后改：mock/篡改前先确认真实行为（dump/watch）——避免盲改。
· 最小篡改：改一个字段/条件优先于整体替换——对比才有意义。
· 语义匹配：List 返回方法用数组样例；对象用对象；String 用带引号 JSON 字符串。
· 篡改≠mock：篡改（无 data 有 filter/copies）基于真实返回值加工；mock（有 data）整体替换。
· 用完还原：delete/stop 移除，避免影响后续调试。
· basePath：新 agent 默认 /testagent 前缀（MCP 已自动处理）。
· 桥模式：TESTAGENT_URL 指向 TaBridge 时，目标寻址用 endpoint 参数（ta_discover 列端点）；ta_bridge=attach 接通、ta_tunnel=tunnel 隧道管理，两者别混。`, serverInfo: { name: "aiti-testagent", version: "0.2.0" } });
    } else if (msg.method === "tools/list") {
      respond(toolsList);
    } else if (msg.method === "tools/call") {
      const { name, arguments: args = {} } = msg.params;
      if (!VISIBLE_NAMES.has(name)) {
        respond({ content: [{ type: "text", text: JSON.stringify({ ok: false, error: `工具 ${name} 未暴露（被 --tools/--exclude 白名单黑名单过滤，服务端拒绝调用）` }) }] });
        return;
      }
      const text = await callTool(name, args);
      respond({ content: [{ type: "text", text }] });
    } else if (msg.method === "notifications/initialized") {
      // noop
    } else {
      respondError(-32601, "unknown method: " + msg.method);
    }
  } catch (e) {
    respondError(-32603, String(e));
  }
});

/** 启动 Java 应用：默认 testagent-java 包装；useJTO=true 用 JAVA_TOOL_OPTIONS（应用及子进程全挂载） */
async function runApp(args) {
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const agentJar = AGENT_JAR;
  const conf = process.env.TESTAGENT_CONF || DEFAULT_CONF_DIR;
  const logFile = args.logFile || path.join(TMP_DIR, `testagent-app-${Date.now()}.log`);
  const httpPort = args.httpPort; // undefined → 随机端口（session 记录真实端口，ta_discover 发现）
  const app = String(args.app);
  if (!app || app.length > 500) return { ok: false, error: "app 参数无效" };
  const extraArgs = (args.args || []).map(String);

  // ---- Node 自己拼 JAVA_TOOL_OPTIONS（-javaagent + 端口），无需 AI/外部脚本构建 ----
  // 路径统一 agentPath()：Windows 换正斜杠（Java 两边都认，env 串里不留反斜杠歧义）
  let jto = `-javaagent:${agentPath(agentJar)}=${agentPath(conf)}`;
  if (httpPort) jto += ` -Dtestagent.httpPort=${httpPort}`;
  else jto += ` -Dtestagent.httpPort=0`; // 未指定 → 随机端口（session 记录真实端口，多进程不冲突）
  const sessionsDir = process.env.TESTAGENT_SESSIONS_DIR;
  if (sessionsDir) jto += ` -Dtestagent.sessionsDir=${agentPath(sessionsDir)}`;
  const token = process.env.TESTAGENT_TOKEN;
  if (token) jto += ` -Dtestagent.token=${token}`;
  if (args.springboot) jto += ` -Dtestagent.springboot=true`; // Spring Boot 开发全家桶一键开关
  for (const o of (args.jvmOpts || [])) jto += ` ${String(o)}`; // 自定义 JVM 参数
  if (process.env.JAVA_TOOL_OPTIONS) jto = `${process.env.JAVA_TOOL_OPTIONS} ${jto}`;
  const env = Object.assign({}, process.env, { JAVA_TOOL_OPTIONS: jto, TESTAGENT_CONF: conf });

  // ---- spawn 应用原始命令（JTO 让应用及其子进程全部自动挂载）----
  const appPath = path.resolve(app);
  let cmd, cmdArgs;
  if (appPath.endsWith(".jar")) { cmd = "java"; cmdArgs = ["-jar", appPath].concat(extraArgs); }
  else if (appPath.endsWith(".sh")) {
    if (process.platform === "win32") {
      return { ok: false, error: "Windows 不启动 .sh 脚本（POSIX shell）——改指 jar（app=…jar）或已编译主类；脚本内部的 java 也可改用 ta_attach 挂到已运行进程" };
    }
    cmd = "bash"; cmdArgs = [appPath].concat(extraArgs);
  } else if (process.platform === "win32" && /\.(bat|cmd)$/i.test(appPath)) {
    // win32 下 .bat/.cmd 必须 shell:true，而 shell:true 会把参数原样拼进命令行（& | 等可直接注入）——
    // 参数来自模型输入，拒绝而非冒注入风险（见 docs/windows-compat-lessons.md §0 规则 1）
    return { ok: false, error: "Windows 不启动 .bat/.cmd 包装脚本（需 shell 解释，参数拼接有注入风险）——直接指 jar 或 exe" };
  } else { cmd = appPath; cmdArgs = extraArgs; } // 可执行脚本/二进制（内部 java 继承 JTO 同样挂载）
  const outFd = fs.openSync(logFile, "a");
  const child = spawn(cmd, cmdArgs, {
    env, stdio: ["ignore", outFd, outFd],
    cwd: args.workdir || process.cwd(),
    detached: true,
    windowsHide: true,
  });
  child.unref();
  return { ok: true, pid: child.pid, httpPort: httpPort || "random", mode: "JAVA_TOOL_OPTIONS",
    logFile, appPort: args.appPort || null,
    message: `已启动 pid=${child.pid}（httpPort=${httpPort || "随机（ta_discover 查看）"}，JAVA_TOOL_OPTIONS 挂载，日志 ${logFile}）。等 10-30s 后 ta_discover 确认就绪并拿 httpPort，然后 ta_code/ta_eval(port) 直接调试。` };
}
async function callTool(name, args) {
  CURRENT_ENDPOINT = String(args.endpoint || ENV_ENDPOINT).trim();   // 每次调用按参数刷新（桥转发寻址）
  switch (name) {
    case "ta_run": return JSON.stringify(await runApp(args), null, 2);
    case "ta_ping": {
      const resp = await api("GET", "/api/ping", null, args.port, args.basePath);
      // 端口属主指纹：防止端口被别的进程/僵尸 agent 占用时误认目标（跨目标误答防护）
      let portOwner = null;
      try {
        const pid = await portOwnerPid(args.port || 8564, true);
        if (pid) portOwner = { pid, cmd: await procCmd(pid) };
      } catch (e) { }
      const body = resp.data && typeof resp.data === "object" ? resp.data : {};
      return JSON.stringify({ status: resp.status, data: resp.data, portOwner,
        hint: portOwner && portOwner.cmd && !/java/i.test(portOwner.cmd) ? "⚠ 端口属主非 java 进程——目标端口可能被无关服务占用" : undefined }, null, 2);
    }
    case "ta_discover": {
      // 桥模式优先：TESTAGENT_URL 指向 TaBridge 时 /api/endpoints 返回 mode=bridge + 端点全量列表
      try {
        const eps = await fetchEndpoints();
        if (eps.mode === "bridge") {
          const on = eps.endpoints.filter((e) => e.online);
          return JSON.stringify({ ok: true, mode: "bridge",
            message: on.length > 0
              ? "桥模式在线端点 " + on.length + " 个：" + on.map((e) => e.endpointId + "（pid=" + e.pid + " port=" + e.httpPort + " " + String(e.cmd || "").slice(0, 50) + "）").join(" | ")
                + "。路由用工具的 endpoint 参数（单端点可省略）；识别目标看 cmd/pid/remoteIp。"
              : "桥模式但无在线端点（等被调服务上线，或 ta_tunnel connect 补连）。",
            mode: "bridge", endpoints: eps.endpoints }, null, 2);
        }
      } catch (e) { /* 探测失败走本机发现 */ }
      const attached = await discoverSessions();
      const javaProcesses = await discoverJavaProcesses();
      const stale = attached.filter((s) => !s.active);
      let active = attached.filter((s) => s.active);
      // Windows 兜底：agent 侧 Registry.cleanupStale 用 /proc 判活（非 Linux 一律判死），session 文件写了就被删
      // ——文件发现链不可靠，改由端口探测补齐（方案 windows-compat §5 实施记录）。
      if (active.length === 0) {
        const t = await buildProcessTable();
        active = t.connected.filter((e) => e.taSource === "probe").map((e) => ({
          pid: e.pid, httpPort: e.ta.port, basePath: e.ta.basePath, agentVersion: e.ta.version, cmd: e.cmd, active: true, via: "probe" }));
      }
      return JSON.stringify({ ok: true,
        message: active.length > 0
          ? "已挂载 TestAgent 的进程（直接用 ta_code/ta_eval 等，端口见 httpPort）：" + active.map((s) => `pid=${s.pid} httpPort=${s.httpPort} cmd=${s.cmd}`).join(" | ")
          : "没有已挂载 TestAgent 的在线进程。目标 Java 进程见 javaProcesses，用 ta_attach 挂载（或启动时加 -javaagent）。",
        attached: active, stale, javaProcesses }, null, 2);
    }
    case "ta_attach": {
      const pid = String(args.pid);
      const extra = [];
      if (args.bridge) extra.push("testagent.bridge=" + String(args.bridge).trim());
      if (args.bridgeToken) extra.push("testagent.bridge.token=" + String(args.bridgeToken).trim());
      const r = await attachJava(pid, extra.join(","));
      if (!r.ok) return JSON.stringify(r, null, 2);
      // attach 成功后自动等待 HTTP API 就绪（免得 AI 再去 ta_discover 反复查）
      const ready = await waitForReady(r.pid || pid, 20000);
      return JSON.stringify({ ok: true, pid: r.pid || pid, ready: !!ready,
        ...(r.note ? { note: r.note } : {}),
        ...(ready ? { httpPort: ready.httpPort, basePath: ready.basePath, agentVersion: ready.agentVersion, cmd: ready.cmd } : {}),
        hint: ready
          ? `挂载完成，HTTP API 就绪——ta_code/ta_eval/ta_watch 等直接传 port=${ready.httpPort}`
          : "attach 已执行但 API 未就绪——稍后 ta_discover 再查（目标进程日志可能有报错）" }, null, 2);
    }
    case "ta_tunnel": {
      const action = String(args.action || "status");
      if (action === "status") return JSON.stringify(await tunnelAction("status", "", CURRENT_ENDPOINT), null, 2);
      if (action === "connect" || action === "disconnect") {
        if (action === "connect" && (!args.url || !/^wss?:\/\//.test(String(args.url)))) return JSON.stringify({ ok: false, error: "connect 需要 url（ws://host:port）" });
        return JSON.stringify(await tunnelAction(action, args.url, CURRENT_ENDPOINT), null, 2);
      }
      return JSON.stringify({ ok: false, error: "action 需要 status|connect|disconnect" });
    }
    case "ta_bridge": {
      const action = String(args.action || "connect");
      if (action === "status") {
        // 进程↔ta 端口对齐全表：每个 Java 进程连了哪个桥（TestAgent 端口/basePath/在线/降级）
        const t = await buildProcessTable();
        return JSON.stringify({ ok: true,
          message: t.connected.length > 0
            ? "已连桥（TestAgent 端口在线）：" + t.connected.map((e) => `pid=${e.pid} port=${e.ta.port}${e.ta.degraded ? "（degraded）" : ""} cmd=${(e.cmd || "").slice(0, 60)}`).join(" | ")
              + `；另有 ${t.plain.length} 个 Java 进程未挂载、${t.dead.length} 条陈旧会话。`
            : `没有在线的 TestAgent 实例。${t.plain.length} 个 Java 进程可挂载（ta_attach / ta_bridge connect）。`,
          connected: t.connected, plain: t.plain, dead: t.dead }, null, 2);
      }
      // connect：一键连桥 —— 已挂载直接返回；唯一候选自动挂载；多候选列出 pid 供选择
      const r = await ensureConnected({ pid: args.pid ? String(args.pid) : undefined });
      if (!r.ok) return JSON.stringify({ ...r, hint: r.candidates ? "用 ta_attach{pid} 指定目标，或确认后重试" : undefined }, null, 2);
      const s = r.session;
      return JSON.stringify({ ok: true, pid: s.pid, httpPort: s.httpPort, basePath: s.basePath, cmd: s.cmd,
        alreadyAttached: !!r.already,
        message: `调试链路已接通：pid=${s.pid} httpPort=${s.httpPort}——ta_code/ta_eval/ta_watch 等传 port=${s.httpPort} 即可` }, null, 2);
    }
    case "ta_code": return JSON.stringify(await api("POST", "/api/code", { source: args.source, register: args.register, backend: args.backend }, args.port, args.basePath), null, 2);
    case "ta_restore": return JSON.stringify(await api("DELETE", "/api/code/" + encodeURIComponent(args.className), null, args.port, args.basePath), null, 2);
    case "ta_login": {
      const action = args.action || "status";
      if (action === "status") return JSON.stringify(await api("GET", "/api/login", null, args.port, args.basePath), null, 2);
      if (action === "delete") return JSON.stringify(await api("DELETE", "/api/login", null, args.port, args.basePath), null, 2);
      return JSON.stringify(await api("POST", "/api/login", args, args.port, args.basePath), null, 2);
    }
    case "ta_method": return JSON.stringify(await api("POST", "/api/method", args, args.port, args.basePath), null, 2);
    case "ta_eval": return JSON.stringify(await api("POST", "/api/eval", { expr: args.expr, code: args.code }, args.port, args.basePath), null, 2);
    case "ta_conf": {
      if (args.action === "list") return JSON.stringify(await api("GET", "/api/conf", null, args.port, args.basePath), null, 2);
      if (args.action === "write") return JSON.stringify(await api("POST", "/api/conf", { name: args.name, content: args.content }, args.port, args.basePath), null, 2);
      if (args.action === "delete") return JSON.stringify(await api("DELETE", "/api/conf/" + encodeURIComponent(args.name), null, args.port, args.basePath), null, 2);
      return JSON.stringify({ ok: false, error: "action 需要 list/write/delete" });
    }
    case "ta_status": return JSON.stringify(await api("GET", "/api/status", null, args.port, args.basePath), null, 2);
    case "ta_native_modules": {
      const wr = await wintraceRpc("proc.modules", { session_id: args.session_id });
      return JSON.stringify(wr, null, 2);
    }
    case "ta_native_watch": {
      const wr = await wintraceRpc("watch.set", { session_id: args.session_id, watches: [{ module: args.module, func_glob: args.func_glob }] });
      const sub = await wintraceRpc("events.subscribe", { session_id: args.session_id });
      return JSON.stringify({ ...wr, sub_id: sub.sub_id }, null, 2);
    }
    case "ta_native_stack": {
      const wr = await wintraceRpc("proc.stack", { session_id: args.session_id, max_frames: args.max_frames || 30 });
      return JSON.stringify(wr, null, 2);
    }
    case "ta_native_detach": {
      const wr = await wintraceRpc("proc.detach", { session_id: args.session_id, eject: true });
      return JSON.stringify(wr, null, 2);
    }
    case "ta_metrics": return JSON.stringify(await api("GET", "/api/metrics", null, args.port, args.basePath), null, 2);
    case "ta_threads": {
      const qs = new URLSearchParams();
      if (args.limit) qs.set("limit", String(args.limit));
      if (args.state) qs.set("state", args.state);
      if (args.deadlock) qs.set("deadlock", "true");
      if (args.utilMs) qs.set("utilMs", String(args.utilMs));
      return JSON.stringify(await api("GET", "/api/threads" + (qs.toString() ? "?" + qs.toString() : ""), null, args.port, args.basePath), null, 2);
    }
    case "ta_memory": return JSON.stringify(await api("GET", "/api/memory", null, args.port, args.basePath), null, 2);
    case "ta_sysprop": {
      const a = String(args.action || "list");
      if (a === "list") return JSON.stringify(await api("GET", "/api/sysprop", null, args.port, args.basePath), null, 2);
      if (a === "get") return JSON.stringify(await api("GET", "/api/sysprop?key=" + encodeURIComponent(args.key || ""), null, args.port, args.basePath), null, 2);
      if (a === "set") return JSON.stringify(await api("POST", "/api/sysprop", { key: args.key, value: args.value }, args.port, args.basePath), null, 2);
      if (a === "clear") return JSON.stringify(await api("POST", "/api/sysprop", { key: args.key, del: true }, args.port, args.basePath), null, 2);
      return JSON.stringify({ ok: false, error: "action 需要 list/get/set/clear" });
    }
    case "ta_sysenv": return JSON.stringify(await api("GET", "/api/sysenv" + (args.search ? "?search=" + encodeURIComponent(args.search) : ""), null, args.port, args.basePath), null, 2);
    case "ta_profile": return JSON.stringify(await api("POST", "/api/profile", { seconds: args.seconds || 10, type: args.type || "cpu" }, args.port, args.basePath), null, 2);
    case "ta_watch": return JSON.stringify(await api("POST", "/api/watch", { className: args.className, method: args.method, limit: args.limit || 1, timeoutSec: args.timeoutSec || 5, costMs: args.costMs, filter: args.filter }, args.port, args.basePath), null, 2);
    case "ta_heapdump": return JSON.stringify(await api("POST", "/api/heapdump", { path: args.path }, args.port, args.basePath), null, 2);
    case "ta_download": return JSON.stringify(await downloadFile({ path: args.path, dest: args.dest, meta: args.meta, port: args.port, basePath: args.basePath, headers: apiHeaders() }), null, 2);
    case "ta_monitor": return JSON.stringify(await api("POST", "/api/monitor", { className: args.className, method: args.method, timeoutSec: args.timeoutSec || 5 }, args.port, args.basePath), null, 2);
    case "ta_tt": {
      const a = args.action;
      if (!a) return JSON.stringify(await api("POST", "/api/tt", { className: args.className, method: args.method, capacity: args.capacity || 20, timeoutSec: args.timeoutSec || 5 }, args.port, args.basePath), null, 2);
      if (a === "start") return JSON.stringify(await api("POST", "/api/tt", { action: "start", className: args.className, method: args.method, capacity: args.capacity, ttlMin: args.ttlMin, ttlSec: args.ttlSec }, args.port, args.basePath), null, 2);
      if (a === "records") return JSON.stringify(await api("POST", "/api/tt", { action: "records", id: args.id, since: args.since, limit: args.limit }, args.port, args.basePath), null, 2);
      if (a === "play") return JSON.stringify(await api("POST", "/api/tt", { action: "play", id: args.id, index: args.index }, args.port, args.basePath), null, 2);
      if (a === "poke") return JSON.stringify(await api("POST", "/api/tt", { action: "poke", id: args.id, index: args.index, target: args.target, expr: args.expr }, args.port, args.basePath), null, 2);
      if (a === "stop") return JSON.stringify(await api("POST", "/api/tt", { action: "stop", id: args.id }, args.port, args.basePath), null, 2);
      return JSON.stringify({ ok: false, error: "action 支持 start|records|play|poke|stop（缺省=同步录制）" });
    }
    case "ta_jad": return JSON.stringify(await api("POST", "/api/jad", { className: args.className }, args.port, args.basePath), null, 2);
    case "ta_xml": return JSON.stringify(await api("POST", "/api/xml", { mapper: args.mapper, content: args.content }, args.port, args.basePath), null, 2);
    case "ta_sc": return JSON.stringify(await api("POST", "/api/sc", { pattern: args.pattern, detail: !!args.detail }, args.port, args.basePath), null, 2);
    case "ta_sm": return JSON.stringify(await api("POST", "/api/sm", { className: args.className }, args.port, args.basePath), null, 2);
    case "ta_classloader": return JSON.stringify(await api("POST", "/api/classloader", { mode: args.mode, className: args.className }, args.port, args.basePath), null, 2);
    case "ta_mbean": return JSON.stringify(await api("POST", "/api/mbean", { pattern: args.pattern }, args.port, args.basePath), null, 2);
    case "ta_dump": return JSON.stringify(await api("POST", "/api/dump", { className: args.className }, args.port, args.basePath), null, 2);
    case "ta_vmtool": return JSON.stringify(await api("POST", "/api/vmtool", { action: args.action || "info" }, args.port, args.basePath), null, 2);
    case "ta_trace": return JSON.stringify(await api("POST", "/api/trace", { className: args.className, method: args.method, timeoutSec: args.timeoutSec || 10, tree: args.tree !== false, maxDepth: args.maxDepth, maxNodes: args.maxNodes, thresholdMs: args.thresholdMs, exclude: args.exclude }, args.port, args.basePath), null, 2);
    case "ta_logger": return JSON.stringify(await api("POST", "/api/logger", { name: args.name, level: args.level }, args.port, args.basePath), null, 2);
    case "ta_vmoption": {
      const a = String(args.action || "list");
      if (a === "list") return JSON.stringify(await api("GET", "/api/vmoption", null, args.port, args.basePath), null, 2);
      return JSON.stringify(await api("POST", "/api/vmoption", { action: a, name: args.name, value: args.value }, args.port, args.basePath), null, 2);
    }
    case "ta_perfcounter": return JSON.stringify(await api("GET", "/api/perfcounter", null, args.port, args.basePath), null, 2);
    case "ta_fs": return JSON.stringify(await api("POST", "/api/fs", { op: args.op || "pwd", path: args.path }, args.port, args.basePath), null, 2);
    case "ta_urls": return JSON.stringify(await api("GET", "/api/urls" + (args.q ? "?q=" + encodeURIComponent(args.q) : ""), null, args.port, args.basePath), null, 2);
    case "ta_sql": return JSON.stringify(await api("POST", "/api/sql", { action: args.action, file: args.file, filter: args.filter, filters: args.filters, inject: args.inject, injects: args.injects, rewrite: args.rewrite, sql: args.sql }, args.port, args.basePath), null, 2);
    case "ta_classwatch": return JSON.stringify(await api("POST", "/api/classwatch", { action: args.action, dir: args.dir }, args.port, args.basePath), null, 2);
    case "ta_lazy_module": return JSON.stringify(args.action === "activate" ? await api("POST", "/api/lazy-module", { pkg: args.pkg }, args.port, args.basePath) : await api("GET", "/api/lazy-module", null, args.port, args.basePath), null, 2);
    case "ta_bean": return JSON.stringify(await api("POST", args.action === "replace" ? "/api/bean_replace" : "/api/bean", { source: args.source, beanName: args.beanName, redirect: args.action === "replace" ? (args.redirect !== false) : undefined }, args.port, args.basePath), null, 2);
    case "ta_props": {
      const a = String(args.action || "");
      if (a === "watch_start") return JSON.stringify(await api("POST", "/api/propwatch", { action: "start", dir: args.dir }, args.port, args.basePath), null, 2);
      if (a === "watch_stop") return JSON.stringify(await api("POST", "/api/propwatch", { action: "stop" }, args.port, args.basePath), null, 2);
      if (a === "watch_status") return JSON.stringify(await api("POST", "/api/propwatch", { action: "status" }, args.port, args.basePath), null, 2);
      return JSON.stringify(await api("POST", "/api/props", { action: a, search: args.search, key: args.key, value: args.value }, args.port, args.basePath), null, 2);
    }
    case "ta_spring": return JSON.stringify(await api("POST", "/api/springops", { action: args.action, name: args.name, n1: args.n1, n2: args.n2, flag: args.flag }, args.port, args.basePath), null, 2);
    case "ta_solon": {
      const a = String(args.action || "beans");
      if (a === "ctrl") return JSON.stringify(await api("POST", "/api/solon", { action: "ctrl" }, args.port, args.basePath), null, 2);
      const body = { action: a, name: args.name, n1: args.n1, n2: args.n2, flag: args.flag };
      return JSON.stringify(await api("POST", "/api/solon", body, args.port, args.basePath), null, 2);
    }
    case "ta_addr": return JSON.stringify(await api("POST", "/api/addr", { action: args.action, from: args.from, to: args.to }, args.port, args.basePath), null, 2);
    case "ta_history": {
      if (args.action === "search") {
        const qs = new URLSearchParams();
        if (args.q) qs.set("q", args.q);
        if (args.type) qs.set("type", args.type);
        if (args.ok) qs.set("ok", args.ok);
        return JSON.stringify(await api("GET", "/api/history" + (qs.toString() ? "?" + qs.toString() : ""), null, args.port, args.basePath), null, 2);
      }
      if (args.action === "save") return JSON.stringify(await api("POST", "/api/history", { action: "save", type: args.type, name: args.name }, args.port, args.basePath), null, 2);
      if (args.action === "load") return JSON.stringify(await api("POST", "/api/history", { action: "load", file: args.file }, args.port, args.basePath), null, 2);
      if (args.action === "delete" && args.file) return JSON.stringify(await api("DELETE", "/api/history/" + args.file, null, args.port, args.basePath), null, 2);
      return JSON.stringify({ ok: false, error: "action 需 search/save/load/delete" });
    }
    case "ta_mock_url": return JSON.stringify(await api("POST", "/api/mock-url", { action: args.action, url: args.url, data: args.data, size: args.size, copies: args.copies, filter: args.filter, status: args.status }, args.port, args.basePath), null, 2);
    case "ta_mock_method": return JSON.stringify(await api("POST", "/api/mock-method", { action: args.action, className: args.className, method: args.method, data: args.data, size: args.size, copies: args.copies, filter: args.filter }, args.port, args.basePath), null, 2);
    case "ta_startup": return JSON.stringify(args.action === "enable" ? await api("POST", "/api/startup-report", {}, args.port, args.basePath) : await api("GET", "/api/startup-report", null, args.port, args.basePath), null, 2);
    case "ta_mock_results": return JSON.stringify(await api("POST", "/api/mock-results", { action: args.action || "list" }, args.port, args.basePath), null, 2);
    case "ta_capture": return JSON.stringify(await api("POST", "/api/capture", { action: args.action, type: args.type, file: args.file }, args.port, args.basePath), null, 2);
    case "ta_job": {
      const a = String(args.action || "list");
      if (a === "list") return JSON.stringify(await api("GET", "/api/jobs", null, args.port, args.basePath), null, 2);
      if (a === "pull") return JSON.stringify(await api("GET", "/api/job/" + encodeURIComponent(args.id) + "?since=" + (args.since || 0) + (args.limit ? "&limit=" + args.limit : ""), null, args.port, args.basePath), null, 2);
      if (a === "delete") return JSON.stringify(await api("DELETE", "/api/job/" + encodeURIComponent(args.id), null, args.port, args.basePath), null, 2);
      if (a === "create") return JSON.stringify(await api("POST", "/api/job", { kind: args.kind || "watch", className: args.className, method: args.method, capacity: args.capacity, ttlMin: args.ttlMin, ttlSec: args.ttlSec, costMs: args.costMs, filter: args.filter }, args.port, args.basePath), null, 2);
      return JSON.stringify({ ok: false, error: "action 需要 create/list/pull/delete" });
    }
    default: return JSON.stringify({ ok: false, error: "未知工具 " + name });
  }
}
