/**
 * upstream-fleet —— fork 引擎（@aiti-ai/pi-subagents）的 Fleet 数据源。
 *
 * fork 模式下子代理由上游扩展 spawn（pi 子进程），状态不经过本扩展内存。
 * 这里从上游工件聚合出 FleetState：
 *   1. subagent-artifacts 工件：sessions/<cwdDir>/subagent-artifacts/<runId>_<agent>_meta.json
 *      （完成后落盘：runId/agent/task/exitCode/model/timestamp/transcriptPath）
 *      + _input.md（任务文本，上游可能脱敏）+ _output.md（输出）
 *   2. bridge-registry（headless 桥登记）：key = 子代理 session 文件路径，
 *      含 /<runUuid>/run-N/ 段 → 与 meta.runId 匹配即「运行中（live）」
 *
 * 无轮询无监听：每次 API 调用现扫（面板打开时一次 + 手动刷新）。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function registryFile() {
  return process.env.PI_BRIDGE_REGISTRY || path.join(agentDir(), "bridge-registry.json");
}

function readRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile(), "utf8"));
    const out = {};
    for (const [key, entry] of Object.entries(raw || {})) {
      const pid = Number(entry && entry.pid);
      let alive = true;
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch { alive = false; }
      }
      if (alive) out[key] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

function sessionFileForRun(registry, runId) {
  if (!runId) return "";
  for (const key of Object.keys(registry)) {
    if (key.includes(`/${runId}/run-`)) return key;
  }
  return "";
}

function readFirst(filePath, limit) {
  try {
    return fs.readFileSync(filePath, "utf8").slice(0, limit).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

// 父会话标题缓存（进程内；避免每次 status 全量重读父文件）
const parentTitleCache = new Map();

/** JSONL 文件首条 user 消息文本（父会话标题用）。 */
function firstUserText(file, limit = 80) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        const m = d.message || d;
        if (m.role !== "user") continue;
        const c = m.content;
        const text = typeof c === "string" ? c : Array.isArray(c)
          ? c.map((x) => (x && typeof x === "object" && x.text) || "").join("")
          : (d.text || "");
        if (text && !text.startsWith("<")) return text.replace(/\s+/g, " ").slice(0, limit);
      } catch { /* 行损坏跳过 */ }
    }
  } catch { /* 文件不可读 */ }
  return "";
}

/** 子代理 session 文件 → 父会话文件路径（header.parentSession）。 */
function parentSessionOf(sessionFile) {
  if (!sessionFile) return "";
  try {
    const header = JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n")[0]);
    return String(header.parentSession || "");
  } catch { return ""; }
}

/** 一次扫描全部上游 async run 目录（runId → dir）。父链/终态富化的数据源。 */
function asyncRunDirMap() {
  const map = new Map();
  const tmp = os.tmpdir();
  let scopes = [];
  try { scopes = fs.readdirSync(tmp).filter((n) => n.startsWith("pi-subagents-")); } catch { return map; }
  for (const scope of scopes) {
    const runsRoot = path.join(tmp, scope, "async-subagent-runs");
    let entries = [];
    try { entries = fs.readdirSync(runsRoot); } catch { continue; }
    for (const runId of entries) {
      if (!/^[0-9a-f-]{36}$/i.test(runId) || map.has(runId)) continue;
      const dir = path.join(runsRoot, runId);
      try { if (fs.statSync(path.join(dir, "status.json")).isFile()) map.set(runId, dir); } catch { /* 无 status 跳过 */ }
    }
  }
  return map;
}

/** async status.json 富化：{ parentSessionFile, childSessionFile, state, endedAt }（fork 语义 sessionId=父会话文件）。 */
function asyncStatusEnrichment(asyncDir) {
  if (!asyncDir) return null;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
    return {
      parentSessionFile: String(s.sessionId || ""),
      childSessionFile: String(s.sessionFile || ""),
      state: String(s.state || ""),
      endedAt: Number(s.endedAt) || undefined,
    };
  } catch { return null; }
}

/** 扫描全部 subagent-artifacts，返回上游 run 的统一视图。 */
function listUpstreamRuns() {
  const runs = [];
  const sessionsRoot = path.join(agentDir(), "sessions");
  let cwdDirs = [];
  try {
    cwdDirs = fs.readdirSync(sessionsRoot).filter((d) => {
      try { return fs.statSync(path.join(sessionsRoot, d)).isDirectory(); } catch { return false; }
    });
  } catch {
    return runs;
  }

  const registry = readRegistry();
  const liveKeys = new Set(Object.keys(registry));
  const seenRunIds = new Set();
  const asyncMap = asyncRunDirMap();

  for (const cwdDir of cwdDirs) {
    const artDir = path.join(sessionsRoot, cwdDir, "subagent-artifacts");
    let entries = [];
    try {
      entries = fs.readdirSync(artDir);
    } catch {
      continue; // 该 cwd 无工件目录
    }

    // ① 有 meta 的（已完成；live 则标 running）
    for (const f of entries) {
      if (!f.endsWith("_meta.json")) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(artDir, f), "utf8"));
        const runId = String(meta.runId || "");
        if (!runId || seenRunIds.has(runId)) continue;
        seenRunIds.add(runId);
        const base = f.replace(/_meta\.json$/, "");
        const agent = String(meta.agent || base.split("_").pop() || "unknown");
        const stat = fs.statSync(path.join(artDir, f));
        const sessionFile = sessionFileForRun(registry, runId);
        const live = sessionFile ? true : false;
        const exitCode = Number(meta.exitCode);
        const usage = (meta.modelAttempts || []).find((a) => a && a.success)?.usage || {};
        // 父会话链：async status.json（sessionId=父会话文件，最可靠）→ live 子代理 session header → 工件 transcript 首行 header（旧格式假设常不匹配，仅兜底）
        const as = asyncStatusEnrichment(asyncMap.get(runId));
        const parentSessionFile = (as && as.parentSessionFile) || parentSessionOf(sessionFile) || parentFromArtifact(path.join(artDir, `${base}_transcript.jsonl`));
        const childSessionFile = (as && as.childSessionFile) || "";
        runs.push({
          id: runId,
          agent,
          task: readFirst(path.join(artDir, `${base}_input.md`), 120) || String(meta.task || "").slice(0, 120),
          parentSessionId: "",
          parentSessionFile,
          turns: Number(usage.turns) || undefined,
          tokens: (Number(usage.input) || 0) + (Number(usage.output) || 0) + (Number(usage.cacheRead) || 0) || undefined,
          status: live ? "running" : as && as.state === "stopped" ? "stopped" : exitCode === 0 ? "completed" : "failed",
          createdAt: Number(meta.timestamp) || stat.birthtimeMs,
          completedAt: live ? undefined : (as && as.endedAt) || stat.mtimeMs,
          durationMs: live ? undefined : ((as && as.endedAt) || stat.mtimeMs) - (Number(meta.timestamp) || stat.birthtimeMs),
          output: readFirst(path.join(artDir, `${base}_output.md`), 400),
          model: String(meta.model || ""),
          mode: "single",
          background: true,
          sessionFile: sessionFile || childSessionFile,
        });
      } catch { /* 单工件损坏不阻断 */ }
    }

    // ② 无 meta 的（进行中：input 已写、meta 未落）
    for (const f of entries) {
      if (!f.endsWith("_input.md")) continue;
      const base = f.replace(/_input\.md$/, "");
      const m = base.match(/([0-9a-f-]{36})_([A-Za-z0-9_-]+)$/);
      if (!m) continue;
      const runId = m[1];
      if (seenRunIds.has(runId)) continue;
      seenRunIds.add(runId);
      const agent = m[2];
      const stat = fs.statSync(path.join(artDir, f));
      const liveSessionFile = sessionFileForRun(registry, runId);
      // 父链 + 终态：meta 未落（运行中或刚结束）时以 async status.json 为准
      const as2 = asyncStatusEnrichment(asyncMap.get(runId));
      const terminal = as2 && ["complete", "failed", "stopped"].includes(as2.state) && !liveSessionFile;
      runs.push({
        id: runId,
        agent,
        task: readFirst(path.join(artDir, f), 120) || "（任务文本不可读）",
        parentSessionId: "",
        parentSessionFile: (as2 && as2.parentSessionFile) || parentSessionOf(liveSessionFile),
        status: !terminal ? "running" : as2.state === "complete" ? "completed" : as2.state,
        createdAt: stat.birthtimeMs,
        completedAt: terminal ? as2.endedAt : undefined,
        mode: "single",
        background: true,
        sessionFile: liveSessionFile || (as2 && as2.childSessionFile) || "",
      });
    }
  }

  return { runs, liveKeys };
}

/** 按 runId 反查上游 async run 目录（<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<runId>）。 */
function findAsyncDir(runId) {
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) return null;
  const tmp = os.tmpdir();
  let scopes = [];
  try { scopes = fs.readdirSync(tmp).filter((n) => n.startsWith("pi-subagents-")); } catch { return null; }
  for (const scope of scopes) {
    const dir = path.join(tmp, scope, "async-subagent-runs", runId);
    try { if (fs.statSync(path.join(dir, "status.json")).isFile()) return dir; } catch { /* 下一 scope */ }
  }
  return null;
}

/**
 * 向上游 control inbox 投递 stop 请求（协议照抄上游 control-channel.ts @0.58.0：
 * <asyncDir>/control/stop-requests/<13位ts>-<uuid>.json，{type:"stop",ts,source,reason}）。
 * Herdr inspector 同款跨进程控制方式——runner 监听 inbox。
 */
function requestStop(runId, reason) {
  const asyncDir = findAsyncDir(runId);
  if (!asyncDir) return { ok: false, error: `找不到 run ${runId} 的上游 async 目录（可能已完成或被清理）` };
  const ts = Date.now();
  const inbox = path.join(asyncDir, "control", "stop-requests");
  fs.mkdirSync(inbox, { recursive: true });
  const file = path.join(inbox, `${String(ts).padStart(13, "0")}-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ type: "stop", ts, source: "aiti-subagents-fleet", reason: String(reason || "fleet panel stop") }));
  return { ok: true, file };
}

/**
 * 投递 steer 请求（协议照抄上游 0.58.0：
 * <asyncDir>/control/steer-requests/<13位ts>-<requestId base64url>.json，
 * {type:"steer", id(requestId), ts, message, source}；steer-inbox-closed.json 存在时拒绝）。
 */
function requestSteer(runId, message) {
  const text = String(message || "").trim();
  if (!text) return { ok: false, error: "消息内容不能为空" };
  if (Buffer.byteLength(text, "utf8") > 65536) return { ok: false, error: "消息超过 64KB 上限" };
  const asyncDir = findAsyncDir(runId);
  if (!asyncDir) return { ok: false, error: `找不到 run ${runId} 的上游 async 目录` };
  if (fs.existsSync(path.join(asyncDir, "control", "steer-inbox-closed.json"))) {
    return { ok: false, error: "该 run 已结束，不再接受新消息" };
  }
  const ts = Date.now();
  const requestId = randomUUID();
  const inbox = path.join(asyncDir, "control", "steer-requests");
  fs.mkdirSync(inbox, { recursive: true });
  const file = path.join(
    inbox,
    `${String(ts).padStart(13, "0")}-${Buffer.from(requestId).toString("base64url")}.json`,
  );
  fs.writeFileSync(file, JSON.stringify({ type: "steer", id: requestId, ts, message: text, source: "aiti-subagents-fleet" }));
  return { ok: true, file };
}

/**
 * 单个 run 的详情聚合（上游 FleetView 详情功能的数据源）：
 * status.json（状态/steps/usage/cost/steering）+ subagent-log-<runId>.md（现成 run 报告）
 * + subagent-artifacts 工件（task/output）+ bridge-registry（live 标记）。
 */
function getRunDetail(runId) {
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) return null;
  const asyncDir = findAsyncDir(runId);
  const registry = readRegistry();
  const sessionFile = sessionFileForRun(registry, runId);
  let status = null;
  if (asyncDir) {
    try { status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")); } catch { /* 无 status */ }
  }
  // 工件（完成态补充：task/output）
  let task = "", output = "", metaAgent = "", inputPath = null;
  try {
    const sessionsRoot = path.join(agentDir(), "sessions");
    for (const cwdDir of fs.readdirSync(sessionsRoot)) {
      const artDir = path.join(sessionsRoot, cwdDir, "subagent-artifacts");
      let files = [];
      try { files = fs.readdirSync(artDir); } catch { continue; }
      const metaF = files.find((f) => f.startsWith(runId) && f.endsWith("_meta.json"));
      if (!metaF) continue;
      const base = metaF.replace(/_meta\.json$/, "");
      try { metaAgent = String(JSON.parse(fs.readFileSync(path.join(artDir, metaF), "utf8")).agent || ""); } catch {}
      task = readFirst(path.join(artDir, `${base}_input.md`), 2000);
      inputPath = path.join(artDir, `${base}_input.md`);
      try { output = fs.readFileSync(path.join(artDir, `${base}_output.md`), "utf8").slice(0, 8000); } catch {}
      break;
    }
  } catch { /* 工件扫描失败不阻断 */ }
  // run 报告 markdown（上游现成的人类可读全文）
  let logMarkdown = "";
  if (asyncDir) {
    try {
      const logF = fs.readdirSync(asyncDir).find((f) => f === `subagent-log-${runId}.md` || (f.startsWith("subagent-log-") && f.endsWith(".md")));
      if (logF) logMarkdown = fs.readFileSync(path.join(asyncDir, logF), "utf8").slice(0, 16384);
    } catch { /* 无日志 */ }
  }
  const live = Boolean(sessionFile);
  const pid = status ? Number(status.pid) : undefined;
  const pidAlive = pid ? (function () { try { process.kill(pid, 0); return true; } catch { return false; } })() : false;
  return {
    id: runId,
    agent: metaAgent || String(status?.steps?.[0]?.agent || "unknown"),
    state: String(status?.state ?? (live ? "running" : "unknown")),
    mode: String(status?.mode ?? ""),
    live,
    pid,
    pidAlive,
    startedAt: status?.startedAt,
    endedAt: status?.endedAt,
    deadlineAt: status?.deadlineAt,
    totalTokens: status?.totalTokens,
    totalCost: status?.totalCost,
    turnCount: status?.turnCount,
    toolCount: status?.toolCount,
    steps: Array.isArray(status?.steps) ? status.steps.map((s) => ({ agent: s.agent, description: String(s.description || "").slice(0, 160), state: s.state })) : [],
    steering: status?.steering,
    task,
    output,
    logMarkdown,
    sessionFile,
    asyncDir: asyncDir || undefined,
    engine: "fork",
  };
}

/** 工件 transcript 首行为 session header（含 parentSession）时返回父文件。 */
function parentFromArtifact(transcriptPath) {
  try {
    const first = fs.readFileSync(transcriptPath, "utf8").split("\n")[0];
    const d = JSON.parse(first);
    if (d.recordType === "session" || d.parentSession) return String(d.parentSession || "");
  } catch { /* 不可读/非 header */ }
  return "";
}

/** FleetState（上游工件聚合 + parent 分组信息）。 */
function getFleetState() {
  const { runs } = listUpstreamRuns();
  // 父标题（缓存优先）
  for (const r of runs) {
    const pf = r.parentSessionFile;
    if (!pf) continue;
    if (!parentTitleCache.has(pf)) parentTitleCache.set(pf, firstUserText(pf) || path.basename(pf).replace(/\.jsonl$/, ""));
    r.parentTitle = parentTitleCache.get(pf);
  }
  const running = runs.filter((r) => r.status === "running" || r.status === "pending");
  const done = runs.filter((r) => r.status !== "running" && r.status !== "pending");
  done.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
  return {
    running,
    recent: done.slice(0, 20),
    agentCount: 0, // fork 模式 agent 定义由上游管理（builtin/profiles），面板不计数
    runCount: runs.length,
    engine: "fork",
  };
}

/** doctor（fork 模式）：包安装 / registry 可读 / 工件目录存在。 */
function doctor() {
  const issues = [];
  let forkInstalled = false;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir(), "settings.json"), "utf8"));
    forkInstalled = (settings.packages || []).some((p) => String(p).includes("pi-subagents"));
  } catch { /* settings 不可读 */ }
  if (!forkInstalled) issues.push({ level: "warn", msg: "agent 目录 settings.json packages 未发现 @aiti-ai/pi-subagents（子代理工具由 pi packages 提供）" });
  const reg = readRegistry();
  let artDirs = 0;
  try {
    const sessionsRoot = path.join(agentDir(), "sessions");
    for (const d of fs.readdirSync(sessionsRoot)) {
      if (fs.existsSync(path.join(sessionsRoot, d, "subagent-artifacts"))) artDirs++;
    }
  } catch { /* 无 sessions 目录 */ }
  if (artDirs === 0) issues.push({ level: "info", msg: "尚无上游子代理工件（委派一次后出现）" });
  return {
    ok: issues.every((i) => i.level !== "error"),
    engine: "fork",
    forkInstalled,
    liveBridges: Object.keys(reg).length,
    artifactDirs: artDirs,
    issues,
  };
}

module.exports = { getFleetState, listUpstreamRuns, doctor, requestStop, requestSteer, getRunDetail };
