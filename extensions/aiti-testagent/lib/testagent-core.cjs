#!/usr/bin/env node
/**
 * testagent-core.cjs —— TestAgent 发现/挂载/探活共享核心。
 *
 * 两处复用（协议唯一来源，勿在他处复制逻辑）：
 *   - mcp-testagent.cjs（stdio MCP server，ta_discover/ta_attach/ta_bridge）
 *   - index.ts（pi-web 扩展服务端，IDE 面板 API：进程扫描/一键挂载/会话状态）
 *
 * TestAgent Java 侧：挂载后写 ~/.cache/testagent/sessions/<pid>.json（含 httpPort），
 * HTTP JSON API 在 http://127.0.0.1:<httpPort><basePath>（默认 /testagent）。
 *
 * 跨平台（windows-compat 方案 §5 走向 B，2026-09-19 完整移植）：
 *   进程表   Linux/macOS ps -eo pid,args ｜ Windows Get-CimInstance Win32_Process（TSV）
 *   监听端口 Linux ss -tlnp ｜ macOS lsof -nP -iTCP -sTCP:LISTEN ｜ Windows netstat -ano
 *   临时路径 os.tmpdir()（Linux/macOS /tmp，Windows %TEMP%）
 *   自动挂载 Linux/macOS ~/.bashrc+~/.profile 标记块 ｜ Windows 用户级 JAVA_TOOL_OPTIONS（setx）
 * 外部命令一律 execFile（参数数组，Windows 路径不过 cmd 引号）+ 5s TTL 结果缓存
 * （Cim 全表 ~1s，禁同步 execSync：见 docs/windows-compat-lessons.md §0）。
 */
const http = require("node:http");
const crypto = require("node:crypto");
const { execFile, spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
/** 临时基址：conf 目录与桥/应用日志都从这里派生（Windows 无 /tmp）。 */
const TMP_DIR = os.tmpdir();
const DEFAULT_CONF_DIR = path.join(TMP_DIR, "testagent-conf");
/** 传给 java agent 位置参数 / JAVA_TOOL_OPTIONS 的路径形态：Windows 换正斜杠
 *  （Java 两边都认，避开 -javaagent:...=conf=C:\... 在 env 串里的反斜杠歧义）。 */
function agentPath(p) { return IS_WIN ? String(p).split(path.sep).join("/") : String(p); }
const CONF_DIR_ARG = agentPath(DEFAULT_CONF_DIR);

const EXEC_TIMEOUT_MS = 15000;
/** 异步跑外部命令，失败/超时返回空串（调用方按空表处理，不抛）。 */
function execOut(cmd, args, timeoutMs = EXEC_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => resolve(err ? "" : String(stdout || "")));
  });
}

const BASE_ENV = process.env.TESTAGENT_URL || "";
/** agent jar 解析：env TESTAGENT_JAR > 打包布局（与 mcp-testagent.cjs 同目录）> 工作区构建产物。 */
function resolveAgentJar() {
  if (process.env.TESTAGENT_JAR) return process.env.TESTAGENT_JAR;
  const candidates = [
    path.join(__dirname, "..", "testagent-1.0.jar"), // 打包布局：jar 与 mcp-testagent.cjs 同目录
    path.join(__dirname, "..", "..", "..", "TestAgent", "TestAgent", "target", "testagent-1.0.jar"), // 工作区
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return candidates[0];
}
const AGENT_JAR = resolveAgentJar();
// basePath：新 agent 默认 /testagent（共用端口隔离）；TESTAGENT_BASEPATH 显式空=根路径（连旧实例）
const DEFAULT_BASEPATH = process.env.TESTAGENT_BASEPATH !== undefined ? process.env.TESTAGENT_BASEPATH : "/testagent";
const SESSIONS_DIR = process.env.TESTAGENT_SESSIONS_DIR || path.join(os.homedir(), ".cache", "testagent", "sessions");

// ---------------- 桥配置（~/.cache/testagent/bridge.json：扩展 IDE 写入，MCP/IDE 共读）----------------
// { mode: "self"|"external",
//   self: { httpPort, wsPort, regToken, useToken },
//   external: { url, ws, useToken, regToken },
//   jto: { enabled } }  —— jto=JAVA_TOOL_OPTIONS 自动挂载开关（实际状态以 shell 配置块为准，此处为缓存）
const BRIDGE_FILE = process.env.TESTAGENT_BRIDGE_FILE || path.join(os.homedir(), ".cache", "testagent", "bridge.json");
const BRIDGE_HTTP_PORT_DEFAULT = 8666;
const BRIDGE_WS_PORT_DEFAULT = 8667;
function loadBridgeConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8"));
    if (cfg && (cfg.mode === "self" || cfg.mode === "external")) return cfg;
  } catch { }
  return null;
}
function saveBridgeConfig(cfg) {
  fs.mkdirSync(path.dirname(BRIDGE_FILE), { recursive: true });
  fs.writeFileSync(BRIDGE_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}
/** 自建桥配置指纹（sha256 短摘要：httpPort|wsPort|regToken|useToken → 12 位 hex）。
 *  用于 --instance-id 握手：MCP 启动桥时传入，重连时桥在 /api/endpoints 回显，
 *  双方以此确认「端口上是我要的那座桥」（外部桥不校验，用户显式指定地址即信任）。 */
function bridgeFingerprint(cfg) {
  if (!cfg || cfg.mode !== "self") return "";
  const s = ["self", cfg.self?.httpPort, cfg.self?.wsPort, cfg.self?.regToken || "", cfg.self?.useToken || ""].join("|");
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
}
/** 桥 base URL（BASE 回退链：env TESTAGENT_URL > bridge.json > 默认常驻实例）。 */
function bridgeBaseUrl() {
  const cfg = loadBridgeConfig();
  if (!cfg) return null;
  if (cfg.mode === "external" && cfg.external?.url) return String(cfg.external.url).replace(/\/$/, "");
  if (cfg.mode === "self" && cfg.self?.httpPort) return `http://127.0.0.1:${cfg.self.httpPort}`;
  return null;
}
/** 桥 ws 地址（JTO 块/补连用）。 */
function bridgeWsUrl(cfg) {
  const c = cfg || loadBridgeConfig();
  if (!c) return null;
  if (c.mode === "external" && c.external?.ws) return String(c.external.ws).trim();
  if (c.mode === "self" && c.self?.wsPort) return `ws://127.0.0.1:${c.self.wsPort}/ta/ws`;
  return null;
}
/** 桥 access token（X-TA-Bridge-Token）。 */
function bridgeUseToken(cfg) {
  const c = cfg || loadBridgeConfig();
  return String((c?.external?.useToken ?? c?.self?.useToken ?? "")).trim();
}
/** 桥配置有效（mode + 对应地址段完整）。 */
function bridgeConfigured(cfg) {
  const c = cfg || loadBridgeConfig();
  if (!c) return false;
  if (c.mode === "external") return !!String(c.external?.url || "").trim();
  return !!Number(c.self?.httpPort);
}
/** 当前 base URL（动态求值：桥配置可能在 MCP 启动后自动写入，BASE 需跟随变化）。 */
function currentBase() { return BASE_ENV || bridgeBaseUrl() || "http://127.0.0.1:8564"; }
const BASE = currentBase();

/** TestAgent HTTP JSON API 调用。port/basePath 缺省用 BASE+DEFAULT_BASEPATH（常驻实例）。
 *  extraHeaders：tunnel/bridge 转发头（X-TA-Endpoint 等，方案 docs/tunnel-bridge-plan.md §5.5）。 */
/** API 调用空闲超时（S9）：默认 150s —— 覆盖 watch/profile 的 120s 上限 + 余量，且高于桥 fwd-timeout 默认 30s
 *  （经桥时 504 先到）；此前无超时，桥挂起时工具调用无限悬挂。env TESTAGENT_API_TIMEOUT_MS 可覆盖。 */
const API_TIMEOUT_MS = Math.max(1000, Number(process.env.TESTAGENT_API_TIMEOUT_MS) || 150000);
const API_MAX_RESP_BYTES = 64 * 1024 * 1024;

function api(method, path, body, port, basePath, extraHeaders, baseOverride) {
  const bp = basePath !== undefined ? basePath : DEFAULT_BASEPATH;
  const base = baseOverride ? String(baseOverride).replace(/\/$/, "") : (port ? `http://127.0.0.1:${port}` : currentBase());
  const prefix = bp && bp !== "/" ? (bp.startsWith("/") ? bp : "/" + bp) : "";
  return new Promise((resolve) => {
    const u = new URL(base + prefix + path);
    const headers = extraHeaders ? Object.assign({}, extraHeaders, body ? { "Content-Type": "application/json" } : {})
      : (body ? { "Content-Type": "application/json" } : {});
    const req = http.request(u, { method, headers, timeout: API_TIMEOUT_MS }, (res) => {
      let data = "";
      res.on("data", (c) => {
        data += c;
        if (data.length > API_MAX_RESP_BYTES) req.destroy(new Error("响应超过 64MB 上限"));
      });
      res.on("end", () => resolve({ status: res.statusCode, data: safeParse(data) }));
    });
    // timeout = socket 空闲超时：须主动 destroy 才会走 error 分支（resolve 幂等，二次调用无副作用）
    req.on("timeout", () => req.destroy(new Error(`API 空闲超时（${API_TIMEOUT_MS}ms，TESTAGENT_API_TIMEOUT_MS 可调）`)));
    req.on("error", (e) => resolve({
      status: 0,
      data: { ok: false, error: "连接失败: " + e.message + "（目标 JVM 是否挂载了 TestAgent？先 ta_attach）" },
    }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const safeParse = (s) => { try { return JSON.parse(s); } catch { return { raw: s }; } };

/** Cim `Get-CimInstance Win32_Process` TSV（pid⇥ppid⇥name⇥cmdline）→ 进程行；cmdline 内的制表符归入 cmd。 */
function parseCimRows(out) {
  const rows = [];
  for (const line of String(out).split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const pid = parts[0].trim(), ppid = parts[1].trim();
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(ppid)) continue;
    rows.push({ pid, ppid, name: parts[2].trim(), cmd: parts.slice(3).join("\t").trim() });
  }
  return rows;
}

/** `ps -eo pid,ppid,args` → 进程行（无 name，判 java 靠 cmd）。 */
function parsePsArgs(out) {
  const rows = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)/);
    if (!m) continue;
    rows.push({ pid: m[1], ppid: m[2], name: "", cmd: m[3].trim() });
  }
  return rows;
}

/** netstat -ano 的 LISTENING 行（zh-CN 系统的状态列仍是 ASCII LISTENING，表头本地化不影响）。 */
function parseNetstatListening(out) {
  const rows = [];
  for (const line of String(out).split(/\r?\n/)) {
    if (!/\bTCP\b/i.test(line) || !/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[1] || "", pid = cols[cols.length - 1] || "";
    const pm = local.match(/:(\d+)$/);
    if (!pm || !/^\d+$/.test(pid)) continue;
    rows.push({ port: Number(pm[1]), pid });
  }
  return rows;
}

/** ss -tlnp：本地地址 :port + users:(("java",pid=123,...)) */
function parseSsListening(out) {
  const rows = [];
  for (const line of String(out).split(/\r?\n/)) {
    if (!/\bLISTEN\b/.test(line)) continue;
    const m = line.match(/\s\S*:(\d+)\s/) || line.match(/\*:(\d+)\s/);
    const pid = (line.match(/pid=(\d+)/) || [])[1];
    if (!m || !pid) continue;
    rows.push({ port: Number(m[1]), pid });
  }
  return rows;
}

/** lsof -nP -iTCP -sTCP:LISTEN：`COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME`，
 *  NAME 末列 `*:8080` / `127.0.0.1:8080 (LISTEN)`——行尾锚定，避免把 ESTABLISHED 的对端端口读成监听口。 */
function parseLsofListening(out) {
  const rows = [];
  const lines = String(out).split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const pid = (line.match(/^\S+\s+(\d+)\s/) || [])[1];
    const nm = line.match(/\s(\S+):(\d+)(?:->\S*)?\s+\(LISTEN\)\s*$/);
    if (!pid || !nm) continue;
    rows.push({ port: Number(nm[2]), pid });
  }
  return rows;
}

const SCAN_TTL_MS = 5000;
const scanCache = new Map();
/** 进程表 / 端口表按 5s TTL 共享缓存：一次面板刷新多次查询只跑一遍外部命令（Cim 全表 ~1s）。
 *  force=true 跳过缓存（等待新监听端口/新进程这类「刚发生变化」的探测必须取最新）。 */
function cachedScan(key, run, force) {
  const hit = scanCache.get(key);
  if (!force && hit && hit.at + SCAN_TTL_MS > Date.now()) return hit.promise;
  const promise = run().then((v) => { if (!Array.isArray(v)) scanCache.delete(key); else scanCache.set(key, { at: Date.now(), promise }); return v; },
    (e) => { scanCache.delete(key); throw e; });
  return promise;
}

const CIM_PS_SCRIPT = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)" }';

/** 本机进程表（pid/ppid/name/cmd）——Windows Cim，其余 ps；结果 5s 缓存。 */
function procTable(force) {
  return cachedScan("proc", async () => {
    if (IS_WIN) return parseCimRows(await execOut("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", CIM_PS_SCRIPT], 20000));
    return parsePsArgs(await execOut("ps", ["-eo", "pid,ppid,args"], 8000));
  }, force);
}

/** 本机 TCP 监听端口表（port/pid）——Windows netstat、macOS lsof、Linux ss；结果 5s 缓存。 */
function sockTable(force) {
  return cachedScan("sock", async () => {
    if (IS_WIN) return parseNetstatListening(await execOut("netstat", ["-ano"], 8000));
    if (IS_MAC) return parseLsofListening(await execOut("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], 8000));
    return parseSsListening(await execOut("ss", ["-tlnp"], 8000));
  }, force);
}

const JAVA_NAME_RE = /^(java|javaw|jshell)(\.exe)?$/i;
const JAVA_CMD_RE = /^\S*(java|jshell)\b/;

/** 进程行是否 Java 进程（Windows 靠映像名，其余靠命令行首 token；`-jar x.jar` 兜住包装器）。 */
function isJavaProc(row) {
  const name = String(row.name || ""), cmd = String(row.cmd || "");
  return JAVA_NAME_RE.test(name) || JAVA_CMD_RE.test(cmd) || /-jar\s+\S+\.jar/.test(cmd);
}

/** 本机 Java 进程扫描（进程表；识别 java/jshell/„-jar *.jar"），标 -javaagent 与应用端口。 */
async function discoverJavaProcesses() {
  const out = [];
  let rows;
  try { rows = await procTable(); } catch (e) { return [{ error: String(e) }]; }
  for (const { pid, name, cmd } of rows) {
    if (!isJavaProc({ name, cmd })) continue;
    const port = (cmd.match(/--server\.port=(\d+)/) || cmd.match(/--port[ =](\d+)/) || [])[1] || "";
    out.push({ pid, agent: cmd.includes("-javaagent") ? "attached" : "no", port, cmd: cmd.slice(0, 140) });
  }
  return out;
}


const tcpAlive = (port) => new Promise((res) => {
  const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); res(true); });
  s.on("error", () => { s.destroy(); res(false); });
  setTimeout(() => { try { s.destroy(); } catch {} res(false); }, 400);
});

/** 读取 sessions 目录（已挂载 TestAgent 的进程），在线探测 httpPort，附自动登录态。 */
async function discoverSessions() {
  const sessions = [];
  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      for (const f of fs.readdirSync(SESSIONS_DIR).filter((n) => n.endsWith(".json"))) {
        try { sessions.push(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"))); } catch {}
      }
    }
  } catch {}
  return Promise.all(sessions.map(async (e) => {
    const active = await tcpAlive(e.httpPort || 0);
    let login = null;
    if (active) {
      // 探测自动登录态（尽力而为；失败/未启用返回 null 不阻塞发现）
      try {
        const r = await api("GET", "/api/login", null, e.httpPort, e.basePath || "/testagent");
        if (r.data && typeof r.data === "object") {
          login = { enabled: !!r.data.enabled, creds: !!r.data.credsRegistered, material: !!r.data.hasMaterial, source: r.data.materialSource || null, mode: r.data.mode || "auto" };
        }
      } catch { login = null; }
    }
    return { pid: e.pid, httpPort: e.httpPort, basePath: e.basePath || "/testagent", agentVersion: e.agentVersion, startTime: e.startTime, cmd: e.cmd, active, login };
  }));
}

/** 某进程的后代 pid 列表（进程树，最多 4 层防环）。 */
async function descendantPids(pid, force) {
  const rows = await procTable(force);
  const byPpid = new Map();
  for (const r of rows) {
    if (!byPpid.has(r.ppid)) byPpid.set(r.ppid, []);
    byPpid.get(r.ppid).push(r.pid);
  }
  const seen = new Set([String(pid)]);
  const out = [];
  let frontier = [String(pid)];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next = [];
    for (const p of frontier) {
      for (const c of (byPpid.get(p) || [])) {
        if (seen.has(c)) continue;
        seen.add(c); out.push(c); next.push(c);
      }
    }
    frontier = next;
  }
  return out;
}

/** owner 是否就是 pid 或其后代（启动器桩另起 JVM 时属主是子进程）。 */
async function ownsByPidTree(owner, pid, force) {
  const o = String(owner), p = String(pid);
  if (!o || o === p) return o === p;
  return (await descendantPids(p, force)).includes(o);
}

/** AttachTool 入口（ta_attach 用）：直接用 agent fat jar——AttachTool 类随主模块 target 1.8
 *  编译进 fat jar（默认包，shade 不 relocate），-cp 一个文件即可；旧包裸目录（attach-tool/）
 *  兜底——新旧包与新旧 MCP 混用时仍可用；都没有则报清晰错误。 */
function resolveAttachEntry() {
  if (fs.existsSync(AGENT_JAR)) return { cp: AGENT_JAR };
  const dir = path.join(__dirname, "..", "attach-tool"); // 旧包布局：AttachTool.class 裸目录
  if (fs.existsSync(path.join(dir, "AttachTool.class"))) return { cp: dir };
  return null;
}

function runAttach(pid, argsStr) {
  return new Promise((resolve) => {
    const entry = resolveAttachEntry();
    if (!entry) { resolve({ ok: false, error: "找不到 agent jar（attach 以 -cp agent jar 直呼内含 AttachTool）——请确认 TESTAGENT_JAR 或包布局完整" }); return; }
    const javaArgs = ["--add-modules", "jdk.attach", "-cp", entry.cp,
      "AttachTool", String(pid), AGENT_JAR, argsStr];
    execFile(resolveJavaBin(), javaArgs, { encoding: "utf8", timeout: 30000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: String(stderr || (err.stdout || "") || err.message).trim() });
        else resolve({ ok: true, result: String(stdout || "").trim() });
      });
  });
}

/** attach TestAgent 到目标 JVM（pid 必须纯数字；jdk.attach VirtualMachine 跨平台——
 *  Windows 走命名管道，同样可用）。execFile 参数数组：路径不过 cmd 引号。
 *  extraAgentArgs：附加 agent 位置参数（逗号前已含 conf；如 "testagent.bridge=ws://host:8667"——
 *  premain 解析器把 testagent.* 同步为系统属性，attach+连桥一步到位）。 */
async function attachJava(pid, extraAgentArgs) {
  if (!/^\d+$/.test(String(pid))) return { ok: false, error: "pid 必须是纯数字（收到: " + pid + "）" };
  const extra = String(extraAgentArgs || "").trim();
  const argsStr = "conf=" + CONF_DIR_ARG + (extra ? "," + extra : "");
  const launcher = String(pid);
  const r = await runAttach(launcher, argsStr);
  if (r.ok) return r;
  // Windows 典型坑：PATH 上的 Oracle javapath `java.exe` 是桩启动器，真正的 JVM 是它另起的子进程
  // （只有加载了 jvm.dll 的那个才可 attach）。命中该特征时自动改挂 java 子进程。
  if (!/jvm\.dll not loaded/i.test(r.error)) return r;
  const kids = (await descendantPids(launcher, true)).filter((k) => k !== launcher);
  for (const k of kids.slice(0, 3)) {
    const r2 = await runAttach(k, argsStr);
    if (r2.ok) {
      return { ...r2, pid: k, launcherPid: launcher,
        note: "目标 pid 是启动器桩（未加载 jvm.dll），已改挂其子进程 pid=" + k };
    }
  }
  return { ...r, hint: "该 pid 是启动器/包装进程（未加载 jvm.dll）——从 ta_discover 的 Java 进程列表里选真正的 JVM pid（其子进程）重试" };
}

// ---------------- tunnel/bridge（方案 §5.5）----------------

/** endpoint → 转发 header：空/self 不带（直连模式本地应答），其余带 X-TA-Endpoint 由桥无脑转发。 */
function endpointHeaders(endpoint) {
  const ep = endpoint == null ? "" : String(endpoint).trim();
  return ep && ep !== "self" ? { "X-TA-Endpoint": ep } : {};
}

/** 端点列表（BASE 指桥 → {mode:"bridge",endpoints:[…]}；指本地 ApiServer → standalone+self）。 */
async function fetchEndpoints() {
  const r = await api("GET", "/api/endpoints");
  // api() 返回双层包装 {status, data:{ok, data:{mode,endpoints}}}（MCP 历史格式）——取内层
  const inner = r.data && typeof r.data === "object" && r.data.data && typeof r.data.data === "object" ? r.data.data : r.data;
  if (r.status === 200 && inner && typeof inner === "object" && inner.mode) return inner;
  return { mode: r.status === 0 ? "unreachable" : "unknown", endpoints: [], raw: r.data };
}

/** 隧道状态/补连（BASE 视角；经桥 + X-TA-Endpoint 可远程补连，url 为端点视角）。
 *  host：显式桥/端点地址（IDE 面板动态指定）；缺省 BASE。 */
async function tunnelAction(action, url, endpoint, host) {
  const headers = endpointHeaders(endpoint);
  const base = host ? String(host).replace(/\/$/, "") : undefined;
  const r = action === "status"
    ? await api("GET", "/api/tunnel", null, undefined, undefined, headers, base)
    : await api("POST", "/api/tunnel", { action, url }, undefined, undefined, headers, base);
  return r;
}

/** 桥端点列表（IDE 面板双源之一）：GET <bridgeUrl>/api/endpoints → {mode:"bridge", endpoints:[…]}。
 *  独立于 BASE——面板可同时看本机会话与任意桥。失败返回 {mode:"unreachable", error}。 */
async function fetchBridgeEndpoints(bridgeUrl, useToken) {
  const base = String(bridgeUrl || "").replace(/\/$/, "");
  if (!base) return { mode: "none", endpoints: [] };
  try {
    const r = await withTimeout(api("GET", "/api/endpoints", null, undefined, undefined,
      useToken ? { "X-TA-Bridge-Token": String(useToken) } : undefined, base), 4000);
    const inner = r.data && typeof r.data === "object" && r.data.data && typeof r.data.data === "object" ? r.data.data : r.data;
    if (r.status === 200 && inner && inner.mode === "bridge") return inner;
    return { mode: "unreachable", endpoints: [], error: "HTTP " + r.status };
  } catch (e) {
    return { mode: "unreachable", endpoints: [], error: String(e && e.message || e) };
  }
}

/** 删除桥上离线端点条目（视觉清理；id 派生自 cmdline，下次上线自动恢复）。 */
async function removeBridgeEndpoint(bridgeUrl, endpointId, useToken, force) {
  const base = String(bridgeUrl || "").replace(/\/$/, "");
  try {
    const r = await withTimeout(api("DELETE", "/api/endpoints/" + encodeURIComponent(endpointId), null, undefined, undefined,
      Object.assign({ "X-TA-Bridge-Token": String(useToken || "") }, force ? { "X-TA-Force": "true" } : {}), base), 6000);
    const inner = r.data && typeof r.data === "object" && r.data.data ? r.data.data : r.data;
    return { ok: r.status === 200, status: r.status, data: inner };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// ---------------- 注册票据（桥主邀请 TA 加入；TTL 默认 5 分钟） ----------------

async function issueRegToken(bridgeUrl, useToken, ttlSec) {
  const base = String(bridgeUrl || "").replace(/\/$/, "");
  const headers = { "X-TA-Bridge-Token": String(useToken || "") };
  const r = await withTimeout(api("POST", "/api/reg-token", { ttlSec: Number(ttlSec) || 300 }, undefined, undefined, headers, base), 6000);
  const inner = r.data && typeof r.data === "object" && r.data.data ? r.data.data : r.data;
  // 防御：目标必须是 TaBridge（TA 会 200+{ok:false,error:"不支持"}——假成功会导致调用方拿到 undefined token）
  if (r.status !== 200 || !inner || !inner.token) {
    const why = inner && inner.error ? inner.error : "HTTP " + r.status;
    return { ok: false, error: "目标不是 TaBridge 桥（" + why + "）——确认地址为桥的 HTTP 端口" };
  }
  return { ok: true, data: inner };
}

async function listRegTokens(bridgeUrl, useToken) {
  const base = String(bridgeUrl || "").replace(/\/$/, "");
  const r = await withTimeout(api("GET", "/api/reg-token", null, undefined, undefined,
    { "X-TA-Bridge-Token": String(useToken || "") }, base), 6000);
  const inner = r.data && typeof r.data === "object" && r.data.data ? r.data.data : r.data;
  if (r.status !== 200 || !Array.isArray(inner)) {
    return { ok: false, tickets: [], error: "目标不是 TaBridge 桥（" + (inner && inner.error ? inner.error : "HTTP " + r.status) + "）" };
  }
  return { ok: true, tickets: inner };
}

async function revokeRegToken(bridgeUrl, useToken, token) {
  const base = String(bridgeUrl || "").replace(/\/$/, "");
  const r = await withTimeout(api("DELETE", "/api/reg-token/" + encodeURIComponent(token), null, undefined, undefined,
    { "X-TA-Bridge-Token": String(useToken || "") }, base), 6000);
  return { ok: r.status === 200 };
}

/** 桥上端点的隧道状态/补连（经桥转发，endpointId 寻址）。 */
async function bridgeTunnel(bridgeUrl, action, url, endpointId, useToken) {
  const base = String(bridgeUrl || "").replace(/\/$/, "");
  const headers = endpointHeaders(endpointId);
  if (useToken) headers["X-TA-Bridge-Token"] = String(useToken);
  const r = action === "status"
    ? await withTimeout(api("GET", "/api/tunnel", null, undefined, undefined, headers, base), 8000)
    : await withTimeout(api("POST", "/api/tunnel", { action, url }, undefined, undefined, headers, base), 8000);
  const inner = r.data && typeof r.data === "object" && r.data.data && typeof r.data.data === "object" ? r.data.data : r.data;
  return { status: r.status, ok: !!(inner && inner.ok !== false && r.status === 200), data: inner };
}

/** 探活：GET /api/ping。 */
async function pingAgent(port, basePath) {
  return api("GET", "/api/ping", null, port, basePath);
}

/** 进程命令行（Linux 直读 /proc；其余平台走进程表缓存）。 */
async function procCmd(pid) {
  if (!IS_WIN && !IS_MAC) {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim().slice(0, 140); } catch { return ""; }
  }
  try {
    const rows = await procTable();
    const hit = rows.find((r) => String(r.pid) === String(pid));
    return hit ? hit.cmd.slice(0, 140) : "";
  } catch { return ""; }
}

async function portOwnerPid(port, force) {
  const rows = await sockTable(force);
  const hit = rows.find((r) => r.port === Number(port));
  return hit ? hit.pid : null;
}

/** conf 目录（testagent.properties）里配置的 httpPort（缺省 8564）。 */
function readConfPort(confDir = DEFAULT_CONF_DIR) {
  try {
    const props = fs.readFileSync(path.join(confDir, "testagent.properties"), "utf8");
    const m = props.match(/^https?Port\s*=\s*(\d+)/m) || props.match(/^testagent\.httpPort\s*=\s*(\d+)/m) || props.match(/^httpPort\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  } catch {}
  return null;
}

/** 单进程监听的 TCP 端口列表（端口表按 pid 过滤，表本身 5s 缓存）。 */
async function listeningPorts(pid) {
  try {
    const rows = await sockTable();
    return [...new Set(rows.filter((r) => String(r.pid) === String(pid)).map((r) => r.port))];
  } catch { return []; }
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res({ status: -1, data: {} }), ms))]);

/** S8（tunnel-network-legacy-solutions.md）：从端点 /api/download 流式下载文件到 MCP 本机——
 *  AI 拿大文件闭环（ta_heapdump/ta_profile 落盘后取回分析，不再只有路径没有内容）。
 *  直连端点（port）才流式；经桥（endpoint）时端点只回元数据 JSON + 直连提示，此处原样透传。
 *  本地落盘上限 256MB（防误下整盘；再大走共享目录/scp）。 */
function downloadFile(opts) {
  const port = opts.port;
  const remotePath = String(opts.path || "");
  const bp = opts.basePath !== undefined ? opts.basePath : DEFAULT_BASEPATH;
  const base = String(opts.baseOverride || "").replace(/\/$/, "") || (port ? `http://127.0.0.1:${port}` : currentBase());
  const prefix = bp && bp !== "/" ? (bp.startsWith("/") ? bp : "/" + bp) : "";
  const u = new URL(base + prefix + "/api/download?path=" + encodeURIComponent(remotePath) + (opts.meta ? "&meta=1" : ""));
  const headers = opts.headers || {};
  return new Promise((resolve) => {
    const req = http.request(u, { method: "GET", headers, timeout: API_TIMEOUT_MS }, (res) => {
      const ctype = String(res.headers["content-type"] || "");
      if (opts.meta || ctype.includes("application/json") || res.statusCode !== 200) {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, data: safeParse(data) }));
        return;
      }
      const baseName = path.basename(String(res.headers["x-ta-file"] || remotePath.split(/[\\/]/).pop() || "download"));
      const outPath = opts.dest || path.join(os.tmpdir(), "testagent-dl-" + baseName);
      const ws = fs.createWriteStream(outPath);
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > 256 * 1024 * 1024) req.destroy(new Error("下载超过 256MB 本地上限（大文件请用共享目录/scp 取回）"));
        else ws.write(c);
      });
      res.on("end", () => ws.end());
      ws.on("finish", () => resolve({ status: res.statusCode, data: { ok: true, savedTo: outPath, sizeBytes: size, source: remotePath } }));
      ws.on("error", (e) => resolve({ status: res.statusCode, data: { ok: false, error: "本地写文件失败: " + e.message } }));
    });
    req.on("timeout", () => req.destroy(new Error(`下载空闲超时（${API_TIMEOUT_MS}ms，TESTAGENT_API_TIMEOUT_MS 可调）`)));
    req.on("error", (e) => resolve({ status: 0, data: { ok: false, error: "下载失败: " + e.message + "（直连端点 port 模式才可流式；经桥请看元数据里的 hint）" } }));
    req.end();
  });
}

/** Windows 真 JDK 解析（结果缓存一次）。PATH 上的 Oracle javapath `java.exe` 是桩启动器，
 *  它另起真正 JVM 时不继承 CREATE_NO_WINDOW → 即便 spawn windowsHide:true 仍会弹出可见控制台窗口
 *  （本机实证：TaBridge 被 javapath → 真 JVM 二级启动后挂在 conhost + WindowsTerminal 下）。
 *  解析链：TESTAGENT_JAVA > JAVA_HOME > `where java`（跳过 javapath 桩取真 JDK bin）> 常见安装目录 > 回退 "java"。
 *  非 Windows 直接 "java"（POSIX 无桩、无窗口问题）。spawnSync where 毫秒级、仅首次执行并缓存，不违反服务端红线。 */
let _javaBinCache;
function resolveJavaBin() {
  if (!IS_WIN) return "java";
  if (_javaBinCache) return _javaBinCache;
  const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };
  const pick = (dir) => (dir ? path.join(dir, "bin", "java.exe") : "");
  const out = [];
  if (process.env.TESTAGENT_JAVA) out.push(String(process.env.TESTAGENT_JAVA).trim());
  if (process.env.JAVA_HOME) out.push(pick(process.env.JAVA_HOME));
  try {
    const r = spawnSync("where", ["java"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    if (r.status === 0 && r.stdout) {
      for (const line of String(r.stdout).split(/\r?\n/)) {
        const p = String(line).trim();
        if (p && !/javapath/i.test(p) && exists(p)) out.push(p);
      }
    }
  } catch { }
  const roots = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Java"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Eclipse Adoptium"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Zulu"),
    path.join(os.homedir(), ".jdks"),
  ];
  for (const root of roots) {
    try {
      const dirs = fs.readdirSync(root)
        .filter((d) => /jdk|zulu|temurin|corretto/i.test(d))
        .map((d) => path.join(root, d))
        .sort((a, b) => b.localeCompare(a)); // 版本目录倒序，尽量取新
      for (const d of dirs) out.push(pick(d));
    } catch { }
  }
  for (const p of out) if (exists(p)) { _javaBinCache = p; return p; }
  _javaBinCache = "java";
  return _javaBinCache;
}

/** 本机启动 TaBridge（同 jar 双角色）。opts: {jar?,httpPort?,wsPort?,regToken?,useToken?,logFile?} → {ok,pid,url,wsUrl,logFile} */
function startBridge(opts = {}) {
  const jar = opts.jar || AGENT_JAR;
  const httpPort = Number(opts.httpPort) || 8666;
  const wsPort = Number(opts.wsPort) || httpPort + 1;
  if (!fs.existsSync(jar)) return { ok: false, error: "找不到 agent jar: " + jar };
  const args = ["-cp", jar, "com.teesoft.testagent.bridge.TaBridge", "--http-port", String(httpPort), "--ws-port", String(wsPort)];
  if (opts.regToken) args.push("--reg-token", String(opts.regToken));
  if (opts.useToken) args.push("--use-token", String(opts.useToken));
  if (opts.instanceId) args.push("--instance-id", String(opts.instanceId));
  const logFile = opts.logFile || path.join(TMP_DIR, `ta-bridge-${httpPort}-${Date.now()}.log`);
  try {
    const out = fs.openSync(logFile, "a");
    const child = spawn(resolveJavaBin(), args, { stdio: ["ignore", out, out], detached: true, windowsHide: true });
    child.unref();
    fs.closeSync(out);
    return { ok: true, pid: child.pid, url: `http://127.0.0.1:${httpPort}`, wsUrl: `ws://127.0.0.1:${wsPort}/ta/ws`, logFile };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

/** 桥就绪探活（带 useToken）：GET /api/endpoints 200 = 就绪。 */
async function bridgeReady(bridgeUrl, useToken, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await fetchBridgeEndpoints(bridgeUrl, useToken);
    if (t.mode === "bridge") return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------------- 桥管理（扩展面板：默认自建桥 / 外部桥 / JTO 自动挂载开关）----------------

/** 桥状态探测：按配置探桥 HTTP（/api/endpoints，带 useToken）→ { configured, mode, url, ws, online, endpoints, useToken }。 */
async function bridgeStatus() {
  const cfg = loadBridgeConfig();
  const configured = bridgeConfigured(cfg);
  const url = bridgeBaseUrl();
  const ws = bridgeWsUrl(cfg);
  const token = bridgeUseToken(cfg);
  const out = { configured, mode: cfg?.mode ?? null, url: url ?? "", ws: ws ?? "", useToken: !!token,
    online: false, pid: null, endpoints: [], endpointCount: 0 };
  if (!configured || !url) return out;
  const fp = cfg.mode === "self" ? bridgeFingerprint(cfg) : "";
  out.instanceId = fp;
  if (cfg.mode === "self") {
    // 自建桥 pid 探测（端口表属主）
    out.pid = await portOwnerPid(Number(cfg.self?.httpPort), true);
    // 未运行 → 自动拉起（幂等：spawn detached，日志同 startBridge）
    if (!out.pid || !(await tcpAlive(Number(cfg.self?.httpPort)))) {
      const r = startBridge({ httpPort: Number(cfg.self?.httpPort) || BRIDGE_HTTP_PORT_DEFAULT,
        wsPort: Number(cfg.self?.wsPort) || BRIDGE_WS_PORT_DEFAULT,
        regToken: cfg.self?.regToken || undefined, useToken: token || undefined, instanceId: fp });
      if (r.ok) out.pid = r.pid;
    }
  }
  const eps = await fetchBridgeEndpoints(url, token || undefined);
  out.online = eps.mode === "bridge";
  out.endpoints = eps.endpoints || [];
  out.endpointCount = out.endpoints.filter((e) => e.online).length;
  // 身份确认：自建桥必须 instanceId 匹配（老桥无 id 视为兼容可用；外部桥不校验）
  out.bridgeInstanceId = (eps && eps.instanceId) || "";
  out.identityOk = cfg.mode !== "self" || !fp || !out.bridgeInstanceId || fp === out.bridgeInstanceId;
  return out;
}

/** JTO 自动挂载（JAVA_TOOL_OPTIONS）：
 *  Linux/macOS —— 双文件落点 ~/.bashrc（交互终端）+ ~/.profile（登录 shell：ssh/su/bash -l/用户会话；
 *    Ubuntu 默认 .bashrc 开头对非交互 shell 直接 return，仅写 bashrc 登录场景不生效）标记块；
 *  Windows —— 用户级环境变量（reg 键 HKCU\Environment，setx 写入并广播 WM_SETTINGCHANGE；
 *    Windows 无 shell rc 惯例，持久 env 即等价机制，仅影响此后新启动的进程）。 */
const JTO_BEGIN = "# >>> aiti-testagent auto-bridge >>>";
const JTO_END = "# <<< aiti-testagent auto-bridge <<<";
const JTO_FILES = [path.join(os.homedir(), ".bashrc"), path.join(os.homedir(), ".profile")];
const JTO_WIN_KEY = "JAVA_TOOL_OPTIONS";
const JTO_WIN_REG = "HKCU\\Environment";
/** agent 侧参数串（两平台同构；Windows 路径已转正斜杠，避开 env 串里的反斜杠歧义）。 */
function jtoAgentOpts() {
  const cfg = loadBridgeConfig();
  const ws = bridgeWsUrl(cfg) || `ws://127.0.0.1:${BRIDGE_WS_PORT_DEFAULT}/ta/ws`;
  return `-javaagent:${agentPath(AGENT_JAR)}=conf=${CONF_DIR_ARG} -Dtestagent.bridge=${ws} -Dtestagent.httpPort=0`;
}
function jtoSnippet() {
  const opts = jtoAgentOpts();
  if (IS_WIN) {
    return [
      `# Windows 用户级环境变量（aiti-testagent 管理；影响所有新启动的 Java 进程，含 maven/gradle 等构建工具）`,
      `setx ${JTO_WIN_KEY} "${opts}"`,
      `# 生效范围：写入 ${JTO_WIN_REG} 并广播，此后新启动的进程可见（已在运行的进程不受影响）`,
      `# 关闭：reg delete ${JTO_WIN_REG} /v ${JTO_WIN_KEY} /f`,
    ].join("\n");
  }
  // 幂等：JAVA_TOOL_OPTIONS 已含本 agent（javaagent:...testagent）时不重复追加——防嵌套 shell 逐层叠加（同一 JVM 挂多份 agent，初始化/Shutdown 均翻倍）
  return `${JTO_BEGIN} (aiti-testagent 管理；删除本块即关闭。注意：影响所有新启动的 Java 进程，含 maven/gradle 等构建工具)\n# 幂等：已含本 agent 则不重复追加（防嵌套 shell 叠加）\ncase \"\$JAVA_TOOL_OPTIONS\" in *javaagent:*testagent*) ;; *) export JAVA_TOOL_OPTIONS=\"\${JAVA_TOOL_OPTIONS:+\$JAVA_TOOL_OPTIONS }${opts}\" ;; esac\n${JTO_END}`;
}
/** 读用户级 JAVA_TOOL_OPTIONS（reg query 输出 `    名称    REG_SZ    值`）。 */
async function winUserEnv(name) {
  const out = await execOut("reg", ["query", JTO_WIN_REG, "/v", name], 8000);
  const m = out.match(new RegExp("^\\s+" + name + "\\s+REG_SZ\\s+(.*)$", "im"));
  return m ? m[1].trim() : "";
}
/** 从既有 JAVA_TOOL_OPTIONS 剥掉本扩展注入的段（用户自己的其他参数保留）。 */
function stripWinJto(value, applied) {
  let v = String(value || "");
  if (applied && v.includes(applied)) v = v.split(applied).join(" ");
  return v.replace(/-javaagent:\S*testagent\S*/gi, " ")
    .replace(/-Dtestagent\.\S+/gi, " ")
    .replace(/\s+/g, " ").trim();
}
async function jtoEnabled() {
  if (IS_WIN) return /-javaagent:\S*testagent/i.test(await winUserEnv(JTO_WIN_KEY));
  return JTO_FILES.some((f) => { try { return fs.readFileSync(f, "utf8").includes(JTO_BEGIN); } catch { return false; } });
}
async function applyJto(enabled) {
  if (enabled) { try { fs.mkdirSync(DEFAULT_CONF_DIR, { recursive: true }); } catch {} }
  if (IS_WIN) {
    const prevApplied = String(loadBridgeConfig()?.jto?.winValue || "");
    // 幂等：先剥掉自己上次写的段（桥地址变了也能干净重写），再决定是否写回
    const others = stripWinJto(await winUserEnv(JTO_WIN_KEY), prevApplied);
    let applied = "";
    if (enabled) {
      applied = (others ? others + " " : "") + jtoAgentOpts();
      if (applied.length > 1024) {
        return { ok: false, error: "JAVA_TOOL_OPTIONS 将超过 setx 的 1024 字符上限——请先移除该变量里无关的参数" };
      }
      await execOut("setx", [JTO_WIN_KEY, applied], 8000);
    } else if (others) {
      await execOut("setx", [JTO_WIN_KEY, others], 8000); // 只清自己的段，保留用户其他参数
    } else {
      await execOut("reg", ["delete", JTO_WIN_REG, "/v", JTO_WIN_KEY, "/f"], 8000);
    }
    try {
      const cfg = loadBridgeConfig() || { mode: "self", self: { httpPort: BRIDGE_HTTP_PORT_DEFAULT, wsPort: BRIDGE_WS_PORT_DEFAULT } };
      cfg.jto = { ...(cfg.jto ?? {}), enabled: !!enabled, winValue: enabled ? applied : "" };
      saveBridgeConfig(cfg);
    } catch { }
    return { ok: (await jtoEnabled()) === !!enabled, snippet: jtoSnippet() };
  }
  for (const file of JTO_FILES) {
    let cur = "";
    try { cur = fs.readFileSync(file, "utf8"); } catch { }
    // 剥旧块（幂等重写）
    let lines = cur.split("\n");
    const i0 = lines.findIndex((l) => l.startsWith(JTO_BEGIN));
    if (i0 >= 0) {
      const i1 = lines.findIndex((l) => l.startsWith(JTO_END));
      lines = i1 > i0 ? [...lines.slice(0, i0), ...lines.slice(i1 + 1)] : lines.slice(0, i0);
    }
    if (enabled) {
      lines = [...lines.filter((l) => l.trim() !== ""), "", jtoSnippet(), ""];
    }
    fs.writeFileSync(file, lines.join("\n"));
  }
  // 配置缓存同步（bridge.json.jto.enabled —— MCP/其他读者可感知；实际生效以 shell 文件为准）
  try {
    const cfg = loadBridgeConfig() || { mode: "self", self: { httpPort: BRIDGE_HTTP_PORT_DEFAULT, wsPort: BRIDGE_WS_PORT_DEFAULT } };
    cfg.jto = { ...(cfg.jto ?? {}), enabled: !!enabled };
    saveBridgeConfig(cfg);
  } catch { }
  return { ok: (await jtoEnabled()) === !!enabled, snippet: jtoSnippet() };
}

/** TestAgent 指纹探测：对端口试 /testagent 与 / 两个 basePath；任意 TestAgent 风格 JSON（含 5xx 错误响应）= 在线。 */
async function probeTa(port) {
  for (const bp of ["/testagent", "/"]) {
    try {
      const r = await withTimeout(api("GET", "/api/ping", null, port, bp), 1500);
      // 必须校验 agent 特征：RuoYi 系框架对未知路径返回 HTTP 200 + body{code:401}（应用端口被误判为 agent 端口的实测根因），
      // 只看状态码会把宿主应用端口误认成 TestAgent API——必须 pong:true 结构同时成立。
      const body = r.data && typeof r.data === "object" ? r.data : null;
      const pong = body && body.ok === true && body.data && typeof body.data === "object" && body.data.pong === true;
      if (r.status === 200 && pong) return { port, basePath: bp, online: true, degraded: false };
      // TestAgent 风格 JSON 错误响应（如类缺失 5xx）也证明 agent 在线（同样要求 ok/error 键而非宿主 401 文案）
      if (r.status >= 400 && body && ("ok" in body || "error" in body) && !("code" in body && "msg" in body && body.code === 401)) {
        return { port, basePath: bp, online: true, degraded: true };
      }
    } catch {}
  }
  return null;
}

/**
 * 进程↔TestAgent 端口对齐全表：回答「这个 Java 进程连了哪个桥 / 开了哪个 ta 端口」。
 * 三路数据融合：进程表骨架（alive）+ sessions 文件（含陈旧，标 dead）+ 监听端口指纹探测
 * （session 未覆盖的进程逐监听端口 probeTa，并发执行；端口表 5s 缓存整轮共用）。
 * 返回 { connected, plain, dead, all }：connected=有在线 ta 端口；plain=活进程但无 ta；dead=会话陈旧进程已死。
 */
async function buildProcessTable() {
  const [sessions, procs] = await Promise.all([discoverSessions(), discoverJavaProcesses()]);
  const byPid = new Map();
  for (const p of procs) {
    if (!p.pid) continue;
    byPid.set(String(p.pid), { pid: String(p.pid), cmd: p.cmd, alive: true, ta: null, taSource: null });
  }
  for (const s of sessions) {
    const pid = String(s.pid);
    let e = byPid.get(pid);
    if (!e) { e = { pid, cmd: s.cmd || "", alive: false, ta: null, taSource: null }; byPid.set(pid, e); }
    if (s.active) {
      e.ta = { port: s.httpPort, basePath: s.basePath, version: s.agentVersion, online: true, degraded: false, login: s.login || null };
      e.taSource = "session";
    }
  }
  await Promise.all([...byPid.values()]
    .filter((e) => e.alive && !e.ta)
    .map(async (e) => {
      for (const port of await listeningPorts(e.pid)) {
        const hit = await probeTa(port);
        if (hit) {
          e.ta = { port: hit.port, basePath: hit.basePath, version: null, online: hit.online, degraded: hit.degraded, login: null };
          e.taSource = "probe";
          break;
        }
      }
    }));
  const all = [...byPid.values()];
  return {
    connected: all.filter((e) => e.ta && e.ta.online),
    plain: all.filter((e) => e.alive && !e.ta),
    dead: all.filter((e) => !e.alive),
    all,
  };
}

function saveSession(session) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SESSIONS_DIR, `${session.pid}.json`), JSON.stringify(session, null, 2));
  } catch {}
}

/**
 * attach 后等待 HTTP API 就绪。两级发现：
 *   ① sessions 目录（兼容 ta_run 写入场景）②直接探测候选端口（8564 + conf 配置）——
 *   attach（agentmain）路径不写 session 文件，就绪后由这里补写，保证 ta_discover/IDE 可见。
 *   端口属主校验（端口表 pid 比对，强制刷新缓存）防把其他实例误认成目标；任意 HTTP 响应（含 4xx/5xx）= 在线。
 *   pid 可为启动器（Oracle javapath 桩另起子 JVM）：属主 pid 与其 java 后代同等视为目标，会话按真实属主记录。
 */
async function waitForReady(pid, timeoutMs = 20000, opts = {}) {
  const { confDir = DEFAULT_CONF_DIR, basePath = DEFAULT_BASEPATH } = opts;
  const launcher = String(pid);
  // 后代集合：桩启动器另起的 JVM 也算目标（agent 的随机端口/会话文件都记在子 JVM 名下）；
  // 进入时强扫一次，循环内按 5s 缓存刷新（每 800ms 强扫会把 Cim 全表打成常态开销）。
  const familyOf = async (force) => new Set([launcher, ...(await descendantPids(launcher, force))]);
  let family = await familyOf(true);
  const deadline = Date.now() + timeoutMs;
  const ports = new Set([8564]);
  const confPort = readConfPort(confDir);
  if (confPort) ports.add(confPort);
  while (Date.now() < deadline) {
    try {
      const hit = (await discoverSessions()).find((s) => family.has(String(s.pid)) && s.active);
      if (hit) return hit;
    } catch {}
    for (const port of ports) {
      try {
        const r = await pingAgent(port, basePath);
        const owner = r.status > 0 ? await portOwnerPid(port, true) : null;
        if (owner && family.has(String(owner))) {
          const session = { pid: String(owner), httpPort: port, basePath, agentVersion: "testagent-2.0",
            startTime: Date.now(), cmd: await procCmd(owner), updatedAt: Date.now(),
            ...(String(owner) === launcher ? {} : { launcherPid: launcher }) };
          saveSession(session);
          return session;
        }
      } catch {}
    }
    // 无固定端口可猜（agent 随机端口 / conf 未落盘）：直接问这一家子进程各自在监听什么
    for (const cand of family) {
      for (const port of await listeningPorts(cand)) {
        if (ports.has(port)) continue; // 已在候选集里（含探测失败的无关服务）
        const hit = await probeTa(port);
        if (hit && hit.online) {
          const session = { pid: cand, httpPort: port, basePath: hit.basePath, agentVersion: "testagent-2.0",
            startTime: Date.now(), cmd: await procCmd(cand), updatedAt: Date.now(),
            ...(cand === launcher ? {} : { launcherPid: launcher }) };
          saveSession(session);
          return session;
        }
        ports.add(port);
      }
    }
    family = await familyOf(false);
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

/** 一键连桥编排：已挂载→直接返回；未挂载→attach+等就绪。pick=pid 或 "auto"（唯一候选自动挂）。 */
async function ensureConnected(opts = {}) {
  const { pid, auto = true, timeoutMs = 20000 } = opts;
  const attached = await discoverSessions();
  const active = attached.filter((s) => s.active);
  if (pid) {
    const hit = active.find((s) => String(s.pid) === String(pid));
    if (hit) return { ok: true, already: true, session: hit, attached: active };
    const r = await attachJava(pid);
    if (!r.ok) return { ok: false, error: r.error, pid };
    const ready = await waitForReady(r.pid || pid, timeoutMs);
    return ready
      ? { ok: true, attachedNow: true, session: ready, attached: [...active, ready], ...(r.note ? { note: r.note } : {}) }
      : { ok: false, error: `attach 已执行但 ${timeoutMs}ms 内 HTTP API 未就绪（查看目标进程日志）`, pid };
  }
  if (active.length > 0) {
    // 逐个 HTTP ping 验证（TCP 通 ≠ API 活），选第一个真正可用的会话
    for (const s of active) {
      try {
        const ping = await pingAgent(s.httpPort, s.basePath);
        if (ping.status === 200) return { ok: true, already: true, session: s, attached: active };
      } catch {}
    }
  }
  if (!auto) return { ok: false, error: "没有已挂载的在线会话，且未指定 pid", attached: active };
  const candidates = (await discoverJavaProcesses()).filter((p) => p.pid && p.agent !== "attached");
  const mappedPids = new Set(attached.map((s) => String(s.pid)));
  const fresh = candidates.filter((p) => !mappedPids.has(String(p.pid)));
  if (fresh.length === 1) {
    const one = fresh[0];
    const r = await attachJava(one.pid);
    if (!r.ok) return { ok: false, error: r.error, pid: one.pid };
    const ready = await waitForReady(r.pid || one.pid, timeoutMs);
    return ready
      ? { ok: true, attachedNow: true, session: ready, attached: [...active, ready], ...(r.note ? { note: r.note } : {}) }
      : { ok: false, error: `attach 已执行但 HTTP API 未就绪`, pid: one.pid };
  }
  return { ok: false, error: fresh.length === 0
    ? "没有可挂载的 Java 进程（都未运行或已挂载）"
    : `发现 ${fresh.length} 个候选 Java 进程，请指定 pid：` + fresh.map((p) => p.pid).join(", "), candidates: fresh };
}

module.exports = { withTimeout, removeBridgeEndpoint, issueRegToken, listRegTokens, revokeRegToken, api, downloadFile, safeParse, discoverJavaProcesses, discoverSessions, attachJava, pingAgent, waitForReady, ensureConnected, buildProcessTable, listeningPorts, probeTa, endpointHeaders, fetchEndpoints, fetchBridgeEndpoints, bridgeTunnel, tunnelAction, startBridge, bridgeReady, resolveJavaBin, BASE, AGENT_JAR, DEFAULT_BASEPATH, SESSIONS_DIR,
  // 跨平台机制（进程表/端口表 + 解析器，测试钉死外部命令输出格式）
  IS_WIN, IS_MAC, TMP_DIR, DEFAULT_CONF_DIR, CONF_DIR_ARG, agentPath, execOut, procTable, sockTable,
  parseCimRows, parsePsArgs, parseNetstatListening, parseSsListening, parseLsofListening, isJavaProc, descendantPids, ownsByPidTree,
  // 桥配置管理（bridge.json：扩展写/MCP 读；JTO 自动挂载开关）
  BRIDGE_FILE, BRIDGE_HTTP_PORT_DEFAULT, BRIDGE_WS_PORT_DEFAULT, loadBridgeConfig, saveBridgeConfig, bridgeBaseUrl, bridgeWsUrl, bridgeUseToken, bridgeConfigured, bridgeStatus, bridgeFingerprint, jtoAgentOpts, jtoSnippet, jtoEnabled, applyJto, winUserEnv, stripWinJto, portOwnerPid, procCmd };
