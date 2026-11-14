/**
 * aiti-subagents —— 子代理扩展（pi-subagents 的 pi-web 适配版）
 *
 * 能力：
 *   - aiti_subagent 工具：委托任务给专用子代理（scout/worker/reviewer/oracle 等）
 *   - 进程内子代理会话：复用 pi-web SDK createAgentSessionFromServices，零 spawn 零配置
 *   - Fleet 监控面板：Web UI 版（替代原版 TUI FleetView），实时查看所有子代理状态
 *   - 子代理检查器：查看运行详情/日志/工具调用/输出
 *   - 自检 doctor：诊断 agent 定义/模型/权限
 *   - 工作流模板：implement / review-loop / parallel-review 等
 *
 * agent 扩展点（方案 M 模式）：server.agent.agentTools() → SDK customTools 进程内注入
 */
// pi-web 扩展系统不自动解析 npm 依赖（typebox/@earendil-works/*），
// 因此使用纯 JSON Schema 定义工具参数，ToolDefinition 类型用内联接口。
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createConnection } = require("node:net");

// 引擎：fork（上游 @aiti-ai/pi-subagents spawn 子代理）为唯一引擎。
// legacy 自研进程内引擎已退役（aiti-subagents-fork-upstream-core-plan §1.2）：
// subagent 工具由 pi packages 的上游扩展提供，本扩展只做 Fleet 观测 + Agent 管理 + 桥控制。
const ENGINE = "fork";

// ── fork Fleet 性能层：跨 reload 缓存（transcript 解析按 mtime+size 失效）──
// transcript 大文件（MB 级）逐行 parse 会阻塞事件循环 50-200ms；详情/列表反复
// 打开时按 (mtimeMs,size) 命中缓存直接返回，运行中文件增长自动失效重析。
const gStore = globalThis as Record<string, unknown>;
const fleetCache = (gStore.__aitiSubagentFleetCache ??= { toolCalls: new Map<string, { mtimeMs: number; size: number; calls: { tool: string; args: string; timestamp?: number }[] }>() }) as { toolCalls: Map<string, { mtimeMs: number; size: number; calls: { tool: string; args: string; timestamp?: number }[] }> };

// ── fork 跨会话控制（内联，避免 jiti 子模块缓存；协议照抄上游 control-channel.ts @0.58.0）──
function findAsyncDirInline(runId) {
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) return null;
  const tmp = require("node:os").tmpdir();
  let scopes = [];
  try { scopes = fs.readdirSync(tmp).filter((n) => n.startsWith("pi-subagents-")); } catch { return null; }
  for (const scope of scopes) {
    const dir = path.join(tmp, scope, "async-subagent-runs", runId);
    try { if (fs.statSync(path.join(dir, "status.json")).isFile()) return dir; } catch { /* 下一 scope */ }
  }
  return null;
}
function requestStopInline(runId, reason) {
  const asyncDir = findAsyncDirInline(runId);
  if (!asyncDir) return { ok: false, error: `找不到 run ${runId} 的上游 async 目录（可能已完成或被清理）` };
  const ts = Date.now();
  const inbox = path.join(asyncDir, "control", "stop-requests");
  fs.mkdirSync(inbox, { recursive: true });
  const file = path.join(inbox, `${String(ts).padStart(13, "0")}-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ type: "stop", ts, source: "aiti-subagents-fleet", reason: String(reason || "fleet panel stop") }));
  return { ok: true, file };
}

// ── fork Fleet 详情聚合（内联；依赖 jiti 子模块缓存规避，同上）──
function agentDirInline() {
  return process.env.PI_CODING_AGENT_DIR || path.join(require("node:os").homedir(), ".pi", "agent");
}
function readRegistryInline() {
  try {
    const regFile = process.env.PI_BRIDGE_REGISTRY || path.join(agentDirInline(), "bridge-registry.json");
    const raw = JSON.parse(fs.readFileSync(regFile, "utf8"));
    const out = {};
    for (const [key, entry] of Object.entries(raw || {})) {
      const pid = Number(entry && entry.pid);
      let alive = true;
      if (Number.isFinite(pid) && pid > 0) { try { process.kill(pid, 0); } catch { alive = false; } }
      if (alive) out[key] = entry;
    }
    return out;
  } catch { return {}; }
}
function sessionFileForRunInline(registry, runId) {
  // ① childSessionUuid 直匹配（registry key 形如 .../<childSessionUuid>/run-0/session.jsonl）
  for (const key of Object.keys(registry)) {
    if (key.includes(`/${runId}/run-`)) return key;
  }
  // ② async runId → 扫 async run 目录的 status.sessionFile（= registry key）反查
  const tmp = require("node:os").tmpdir();
  try {
    for (const scope of fs.readdirSync(tmp)) {
      if (!scope.startsWith("pi-subagents-")) continue;
      const sf = path.join(tmp, scope, "async-subagent-runs", runId, "status.json");
      try {
        const st = JSON.parse(fs.readFileSync(sf, "utf8"));
        if (st.sessionFile && registry[st.sessionFile]) return st.sessionFile;
      } catch { /* 下一 scope */ }
    }
  } catch { /* ignore */ }
  return "";
}
function readFirstInline(filePath, limit) {
  try { return fs.readFileSync(filePath, "utf8").slice(0, limit).replace(/\s+/g, " ").trim(); } catch { return ""; }
}

// 首条非 < 开头的 user 文本（带进程内缓存；父会话标题/子代理真实任务文本共用）
const firstUserTextCacheInline = new Map<string, string>();
function firstUserTextInline(file: string, limit = 400): string {
  let full = firstUserTextCacheInline.get(file);
  if (full === undefined) {
    full = "";
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          const m = d.message || d;
          if ((m.role ?? d.role) !== "user") continue;
          const c = m.content ?? d.content;
          const text = typeof c === "string" ? c : Array.isArray(c)
            ? c.map((x: { text?: string }) => (x && typeof x === "object" && x.text) || "").join("")
            : (d.text || "");
          if (text && !text.startsWith("<")) { full = String(text).replace(/\s+/g, " ").trim(); break; }
        } catch { /* 行损坏跳过 */ }
      }
    } catch { /* 文件不可读 */ }
    firstUserTextCacheInline.set(file, full);
  }
  return full.slice(0, limit);
}

// 运行中发现子会话文件（status.json.sessionFile 完成时才回填）：扫父会话目录两种布局
// （forks/<ts>_<uuid>.jsonl 与 <uuid>/run-*/session.jsonl），取 startedAt 之后最新修改者
function findChildSessionFileInline(parentSessionFile: string, startedAt = 0): string {
  try {
    const dir = path.dirname(parentSessionFile);
    let best = "", bestM = 0;
    const consider = (f: string) => {
      try {
        const st = fs.statSync(f);
        if (!st.isFile() || st.size === 0) return;
        if (startedAt && st.mtimeMs < startedAt - 5000) return;
        if (st.mtimeMs > bestM) { bestM = st.mtimeMs; best = f; }
      } catch { /* skip */ }
    };
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
        if (name === "forks") {
          for (const f of fs.readdirSync(full)) if (f.endsWith(".jsonl")) consider(path.join(full, f));
        } else {
          for (const sub of fs.readdirSync(full)) {
            if (sub === "run-0" || /^run-\d+$/.test(sub)) consider(path.join(full, sub, "session.jsonl"));
          }
        }
      } catch { /* skip */ }
    }
    return best;
  } catch { return ""; }
}

// 父会话 transcript 里的 subagent tool_call（运行中行真实任务源：工件/子会话文件运行中均拿不到原文）
const parentSubagentCallsCache = new Map<string, { mtimeMs: number; size: number; calls: { agent: string; task: string }[] }>();
function parentSubagentCalls(file: string): { agent: string; task: string }[] {
  try {
    const st = fs.statSync(file);
    const cached = parentSubagentCallsCache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.calls;
    const content = fs.readFileSync(file, "utf8");
    const capped = content.length > 8 * 1024 * 1024 ? content.slice(0, 8 * 1024 * 1024) : content;
    const calls: { agent: string; task: string }[] = [];
    for (const line of capped.split("\n")) {
      if (!line.includes("subagent")) continue;
      try {
        const e = JSON.parse(line);
        const m = e.message ?? e;
        if (m.role !== "assistant") continue;
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c && c.type === "toolCall" && String(c.name || "").includes("subagent")) {
            const args = (c.arguments ?? c.input ?? {}) as Record<string, unknown>;
            const agent = String(args.agent ?? "");
            const task = String(args.task ?? args.prompt ?? "").replace(/\s+/g, " ").trim();
            if (agent && task) calls.push({ agent, task });
          }
        }
      } catch { /* 行损坏跳过 */ }
    }
    parentSubagentCallsCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, calls });
    return calls;
  } catch { return []; }
}

function requestSteerInline(runId, message) {
  const text = String(message || "").trim();
  if (!text) return { ok: false, error: "消息内容不能为空" };
  const asyncDir = findAsyncDirInline(runId);
  if (!asyncDir) return { ok: false, error: `找不到 run ${runId} 的上游 async 目录` };
  if (fs.existsSync(path.join(asyncDir, "control", "steer-inbox-closed.json"))) {
    return { ok: false, error: "该 run 已结束，不再接受新消息" };
  }
  const ts = Date.now();
  const requestId = randomUUID();
  const inbox = path.join(asyncDir, "control", "steer-requests");
  fs.mkdirSync(inbox, { recursive: true });
  const file = path.join(inbox, `${String(ts).padStart(13, "0")}-${Buffer.from(requestId).toString("base64url")}.json`);
  fs.writeFileSync(file, JSON.stringify({ type: "steer", id: requestId, ts, message: text, source: "aiti-subagents-fleet" }));
  return { ok: true, file };
}

// ── /web 桥客户端（aiti-attach-agent 的 headless 桥 socket，双向 RPC）──────────
// 子代理运行中时 bridge-registry 登记其 socket；pi-web 进程直接连上发命令
//（get_state/get_messages/steer/prompt/abort），即回执。比 control inbox 文件投递
// 快且有回执；文件协议保留为回退。
function readBridgeSocket(runId) {
  const reg = readRegistryInline();
  const sessionFile = sessionFileForRunInline(reg, runId);
  if (!sessionFile) return null;
  const entry = reg[sessionFile];
  return entry && entry.socket ? { socket: entry.socket, sessionFile } : null;
}

/** 短连接桥请求：发一帧命令，收首个匹配 id 的 response（默认 1.5s 超时）。 */
function bridgeRequest(socketPath, type, params = {}, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const id = randomUUID();
    let buf = "";
    let done = false;
    const s = createConnection({ path: socketPath });
    const finish = (result) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    s.setTimeout(timeoutMs);
    s.on("connect", () => {
      s.write(JSON.stringify({ id, type, ...params }) + "\n");
    });
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.id === id && frame.type === "response") {
            finish(frame.success ? { ok: true, data: frame.data } : { ok: false, error: String(frame.error || "bridge command failed") });
            return;
          }
          // 其它帧（广播事件/他人响应）忽略
        } catch { /* 非完整/非 JSON 行忽略 */ }
      }
    });
    s.on("timeout", () => finish({ ok: false, error: "bridge 超时" }));
    s.on("error", (e) => finish({ ok: false, error: `bridge 连接失败: ${e.message}` }));
    s.on("close", () => finish({ ok: false, error: "bridge 连接关闭" }));
  });
}

/** 桥优先控制：bridge 即时命令（带回执），失败回退 control inbox 文件投递（错误透传）。 */
async function controlRun(runId, action, message) {
  const target = readBridgeSocket(runId);
  let bridgeError = null;
  if (target) {
    const cmd = action === "prompt" ? "prompt" : action === "steer" ? "steer" : action;
    if (cmd === "abort" || cmd === "steer" || cmd === "prompt") {
      const r = await bridgeRequest(target.socket, cmd, cmd === "abort" ? {} : { text: String(message || "") }, action === "abort" ? 2500 : 1800);
      if (r.ok) return { ...r, via: "bridge" };
      bridgeError = r.error;
      // abort 后子代理进程可能立即退出导致 socket close 先于回执——验证 registry 清理即视为已生效
      if (cmd === "abort" && !readBridgeSocket(runId)) {
        return { ok: true, via: "bridge", assumed: true, note: "abort 后子代理退出（socket 已清理），视为已生效" };
      }
    }
  }
  // 回退：文件投递。asyncDir 解析顺序：async id 直查 → 经 registry sessionFile 反查
  let asyncDir = findAsyncDirInline(runId);
  if (!asyncDir && target) {
    const tmp = require("node:os").tmpdir();
    try {
      for (const scope of fs.readdirSync(tmp)) {
        if (!scope.startsWith("pi-subagents-")) continue;
        const cand = path.join(tmp, scope, "async-subagent-runs");
        for (const rid of fs.readdirSync(cand)) {
          try {
            const st = JSON.parse(fs.readFileSync(path.join(cand, rid, "status.json"), "utf8"));
            if (st.sessionFile === target.sessionFile) { asyncDir = path.join(cand, rid); break; }
          } catch { /* 下一 run */ }
        }
        if (asyncDir) break;
      }
    } catch { /* ignore */ }
  }
  if (!asyncDir) {
    return { ok: false, via: "none", error: `无可用控制通道${bridgeError ? `（bridge: ${bridgeError}）` : "（bridge 未登记且 async 目录未找到）"}` };
  }
  const inbox = path.join(asyncDir, "control", action === "abort" ? "stop-requests" : "steer-requests");
  fs.mkdirSync(inbox, { recursive: true });
  const ts = Date.now();
  const payload = action === "abort"
    ? { type: "stop", ts, source: "aiti-subagents-fleet", reason: "fleet panel abort（bridge 不可达，回退 control inbox）" }
    : { type: "steer", id: randomUUID(), ts, message: String(message || "").trim(), source: "aiti-subagents-fleet" };
  const file = path.join(inbox, action === "abort"
    ? `${String(ts).padStart(13, "0")}-${randomUUID()}.json`
    : `${String(ts).padStart(13, "0")}-${Buffer.from(payload.id).toString("base64url")}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return { ok: true, via: "inbox", file };
}

/** live 增强：bridge 实时状态 + 最近消息尾部（短连接、超时保护，失败不阻塞详情）。 */
async function bridgeLiveView(runId) {
  const target = readBridgeSocket(runId);
  if (!target) return { attached: false };
  const state = await bridgeRequest(target.socket, "get_state", {}, 1200);
  if (!state.ok) return { attached: false, error: state.error };
  const view = { attached: true, state: state.data };
  const msgs = await bridgeRequest(target.socket, "get_messages", {}, 1500);
  if (msgs.ok && Array.isArray(msgs.data?.messages)) {
    view.recentMessages = msgs.data.messages.slice(-4).map((m) => ({
      role: String(m.role ?? "?"),
      text: Array.isArray(m.content)
        ? m.content.filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join(" ").slice(0, 240)
        : String(m.content ?? "").slice(0, 240),
    })).filter((m) => m.text);
  }
  return view;
}

function getRunDetailInline(runId, knownArtifactDir) {
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) return null;
  const asyncDir = findAsyncDirInline(runId);
  const registry = readRegistryInline();
  const sessionFile = sessionFileForRunInline(registry, runId);
  let status = null;
  if (asyncDir) {
    try { status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")); } catch { /* 无 status */ }
  }
  // 工件（完成态补充：task/output；运行中 fallback：input/transcript 已实时可读）
  let task = "", output = "", metaAgent = "", inputPath = null;
  let runningTranscript = ""; // 运行中 meta 未落盘时的 transcript 兜底（工具调用列表不空窗）
  let artDirKnown = typeof knownArtifactDir === "string" ? knownArtifactDir : "";
  try {
    const sessionsRoot = path.join(agentDirInline(), "sessions");
    for (const cwdDir of fs.readdirSync(knownArtifactDir ? path.dirname(knownArtifactDir) : sessionsRoot)) {
      const artDir = knownArtifactDir || path.join(sessionsRoot, cwdDir, "subagent-artifacts");
      let files = [];
      try { files = fs.readdirSync(artDir); } catch { continue; }
      const metaF = files.find((f) => f.startsWith(runId) && f.endsWith("_meta.json"));
      if (!metaF) {
        // 运行中：input/transcript 先于 meta 落盘 —— 任务文本与工具调用可实时取
        const rInput = files.find((f) => f.startsWith(runId) && f.endsWith("_input.md"));
        const rTrans = files.find((f) => f.startsWith(runId) && f.endsWith("_transcript.jsonl"));
        if (rInput || rTrans) {
          artDirKnown = artDir;
          if (!task && rInput) task = readFirstInline(path.join(artDir, rInput), 2000);
          if (!inputPath && rInput) inputPath = path.join(artDir, rInput);
          if (!runningTranscript && rTrans) runningTranscript = path.join(artDir, rTrans);
        }
        continue;
      }
      artDirKnown = artDir;
      const base = metaF.replace(/_meta\.json$/, "");
      try { metaAgent = String(JSON.parse(fs.readFileSync(path.join(artDir, metaF), "utf8")).agent || ""); } catch {}
      task = readFirstInline(path.join(artDir, `${base}_input.md`), 2000);
      inputPath = path.join(artDir, `${base}_input.md`);
      try { output = fs.readFileSync(path.join(artDir, `${base}_output.md`), "utf8").slice(0, 8000); } catch {}
      break;
    }
  } catch { /* 工件扫描失败不阻断 */ }
  // 工具级调用列表：优先 meta.transcriptPath（runId 精确对应），回退 status.sessionFile
  let toolCalls = [];
  let toolCallSource = "";
  try {
    let transcriptPath = "";
    if (artDirKnown) {
      // 复用工件扫描结果，不再二次全扫
      let metaF2 = null;
      try { metaF2 = fs.readdirSync(artDirKnown).find((f) => f.startsWith(runId) && f.endsWith("_meta.json")); } catch {}
      if (metaF2) {
        try { transcriptPath = String(JSON.parse(fs.readFileSync(path.join(artDirKnown, metaF2), "utf8")).transcriptPath || ""); } catch {}
        if (!transcriptPath) transcriptPath = path.join(artDirKnown, metaF2.replace("_meta.json", "_transcript.jsonl"));
      }
    }
    if (!transcriptPath && status?.sessionFile) transcriptPath = String(status.sessionFile);
    if (!transcriptPath && runningTranscript) transcriptPath = runningTranscript; // 运行中兜底（status.sessionFile 完成时才回填）
    if (!transcriptPath && sessionFile) transcriptPath = sessionFile;
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      toolCallSource = transcriptPath;
      // 解析缓存（mtime+size 失效）：大 transcript 逐行 parse 阻塞事件循环，
      // 详情反复打开命中缓存；运行中文件增长自动失效重析。
      const st = fs.statSync(transcriptPath);
      const cached = fleetCache.toolCalls.get(transcriptPath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        toolCalls = cached.calls;
      } else {
        const content = fs.readFileSync(transcriptPath, "utf8");
        const capped = content.length > 4 * 1024 * 1024 ? content.slice(0, 4 * 1024 * 1024) : content;
        const calls = [];
        for (const line of capped.split("\n")) {
          if (!line.includes("toolCall")) continue;
          try {
            const e = JSON.parse(line);
            const m = e.message ?? e;
            if (m.role !== "assistant") continue;
            for (const c of Array.isArray(m.content) ? m.content : []) {
              if (c && c.type === "toolCall") {
                calls.push({
                  tool: String(c.name ?? c.toolName ?? "unknown"),
                  args: String(JSON.stringify(c.arguments ?? {})).slice(0, 200),
                  timestamp: Number(e.ts ?? 0) || undefined,
                });
              }
            }
          } catch { /* 行损坏忽略 */ }
        }
        fleetCache.toolCalls.set(transcriptPath, { mtimeMs: st.mtimeMs, size: st.size, calls });
        if (fleetCache.toolCalls.size > 200) {
          const firstKey = fleetCache.toolCalls.keys().next().value;
          if (firstKey) fleetCache.toolCalls.delete(firstKey);
        }
        toolCalls = calls;
      }
    }
  } catch { /* 工具提取失败不阻断详情 */ }
  // 工件任务文本被上游设计性脱敏 → ①父会话 subagent tool_call 原始 task ②子会话文件首条 user 消息
  if (!task || task.includes("[prompt redacted]")) {
    const selfAgent = metaAgent || String(status?.steps?.[0]?.agent || "");
    if (status?.sessionId && selfAgent) {
      const calls = parentSubagentCalls(String(status.sessionId));
      const match = [...calls].reverse().find((c) => c.agent === selfAgent);
      if (match) task = match.task.slice(0, 400);
    }
    if ((!task || task.includes("[prompt redacted]")) && status?.sessionFile) {
      const t = firstUserTextInline(String(status.sessionFile), 400);
      if (t) task = t;
    }
  }

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
    parentSessionFile: String(status?.sessionId ?? ""),
    childSessionFile: String(status?.sessionFile ?? "") || (status?.sessionId ? findChildSessionFileInline(String(status.sessionId), Number(status?.startedAt) || 0) : ""), // 子代理自己的会话文件（单模式可靠；fanout root 特例可能指向已清理路径；运行中从父目录 glob 发现）
    cwd: String(status?.cwd ?? ""),
    durationMs: (() => {
      if (!status?.startedAt) return undefined;
      const start = Number(status.startedAt);
      const end = Number(status.endedAt || 0);
      if (end > start) return end - start;
      return live ? Date.now() - start : undefined;
    })(),
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
    toolCalls,
    toolCallSource,
    task,
    output,
    logMarkdown,
    sessionFile,
    asyncDir: asyncDir || undefined,
    engine: "fork",
  };
}




export default {
  id: "aiti-subagents",
  name: "子代理（ai 委托 · 多 agent 协作）",
  icon: "icon.svg",
  client: "dist/aiti-subagents-client.mjs",

  // 引擎：上游 @aiti-ai/pi-subagents spawn 子代理（subagent 工具由 pi packages 提供，
  // 扩展只做 Fleet 观测与 agent/执行器管理）；旧自研进程内引擎已退役（57d62a7）。
  // 冲突插件声明：用户手工安装的原版 pi-subagents 与本扩展承载的 fork 引擎
  // 注册同名 subagent 工具（双注册冲突）——平台加载时禁用原版包。
  // fork（@aiti-ai/pi-subagents，scoped 名）不受此声明影响。
  conflicts: ["pi-subagents"],
  features: [],
  ui: {
    clientImmediately: false, // [懒加载 v2] M1 已同步生产，懒化重启用
    // aiti-float dock v0.5.1：左栏「任务」区（宿主折叠容器；无子代理活动时区仍渲染，内容自显空态）
    sidebarTasks: [{ id: "tasks", label: "子代理任务" }],
    // 懒加载 v2 M3批②：icon 与 client 注册 meta.icon 同源；侧栏「任务」区块物化前不显示（计划已接受）
    toolbar: [{ id: "aiti-subagents", label: "子代理", title: "子代理舰队监控面板", icon: "icons/users.svg" }],
    // aiti-float dock v3：停靠槽静态声明（懒扩展物化触发 + 静态入口；id 与 client 注册一致）
    sidebarExplorerDock: [{ id: "fleet", label: "子代理舰队" }],
    rightFileDock: [{ id: "fleet", label: "舰队" }],
    dialogs: [{ id: "aiti-subagents-fleet", label: "子代理舰队" },
              { id: "aiti-subagents-inspector", label: "子代理检查器" },
              { id: "aiti-subagents-concurrency", label: "并发配置" }],
  },

  server: {
    startup(ctx) {
      console.log(`[aiti-subagents] 就绪（fork 引擎：subagent 工具由 pi packages 的 @aiti-ai/pi-subagents 提供）`);
    },

    shutdown() {
      // 无进程内状态（fork 子代理独立于本扩展进程）
    },

    shutdown() {
    },

    // /api/extensions/aiti-subagents/<path>
    async api(req, ctx) {
      const p = ctx.path || [];
      const uf = () => require("./upstream-fleet.js");

      // 列表行父链/终态富化（内联：upstream-fleet.js 受 jiti 子模块缓存限制，改动不随 reload 生效；
      // fork 语义 status.json：sessionId=父会话文件、sessionFile=子会话文件）
      const enrichListRowsInline = (runs: Array<Record<string, unknown>>): void => {
        const tmp = require("node:os").tmpdir() as string;
        const asyncMap = new Map<string, string>();
        try {
          for (const scope of fs.readdirSync(tmp).filter((n) => n.startsWith("pi-subagents-"))) {
            const runsRoot = path.join(tmp, scope, "async-subagent-runs");
            let entries: string[] = [];
            try { entries = fs.readdirSync(runsRoot); } catch { continue; }
            for (const rid of entries) {
              if (!/^[0-9a-f-]{36}$/i.test(rid) || asyncMap.has(rid)) continue;
              const dir = path.join(runsRoot, rid);
              try { if (fs.statSync(path.join(dir, "status.json")).isFile()) asyncMap.set(rid, dir); } catch { /* 无 status */ }
            }
          }
        } catch { /* tmp 不可读 */ }
        for (const r of runs) {
          const rid = String(r.id || "");
          const dir = asyncMap.get(rid);
          if (!dir) continue;
          let as: { sessionId?: string; sessionFile?: string; state?: string; endedAt?: number; cwd?: string; startedAt?: number } | null = null;
          try { as = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")); } catch { continue; }
          if (!as) continue;
          if (!r.parentSessionFile && as.sessionId) r.parentSessionFile = String(as.sessionId);
          if (!r.sessionFile && as.sessionFile) r.sessionFile = String(as.sessionFile);
          // 运行中：子会话文件从父目录 glob 发现（status.sessionFile 完成时才回填）——
          // 行「会话」按钮与检查器「打开子代理消息窗口」运行中即可用
          if (!r.sessionFile && as.sessionId) {
            const child = findChildSessionFileInline(String(as.sessionId), Number(as.startedAt) || 0);
            if (child) { r.sessionFile = child; r.childSessionFile = child; }
          }
          if (as.cwd) r.cwd = String(as.cwd);
          if (as.startedAt) r.startedAt = Number(as.startedAt);
          // 工件任务文本被上游设计性脱敏（[prompt redacted]）→ ①父会话 subagent tool_call 原始 task（运行中可用）②子会话文件首条 user 消息
          if (!r.task || String(r.task).includes("[prompt redacted]")) {
            let t = "";
            if (as.sessionId) {
              const calls = parentSubagentCalls(String(as.sessionId));
              const match = [...calls].reverse().find((c) => c.agent === String(r.agent));
              if (match) t = match.task;
            }
            if (!t && as.sessionFile) t = firstUserTextInline(String(as.sessionFile), 160);
            if (t) r.task = t.slice(0, 160);
          }
          if (r.status === "running" && ["complete", "failed", "stopped"].includes(String(as.state))) {
            r.status = as.state === "complete" ? "completed" : String(as.state);
            if (as.endedAt) r.completedAt = Number(as.endedAt);
          }
        }
      };
      // 父会话标题（fork 引擎 Fleet 状态用；文本提取用顶层 firstUserTextInline）
      const parentTitleCacheInline = new Map<string, string>();
      const parentTitleInline = (file: string): string => {
        const hit = parentTitleCacheInline.get(file);
        if (hit !== undefined) return hit;
        const title = firstUserTextInline(file, 80) || file.split("/").pop()?.replace(/\.jsonl$/, "") || "";
        parentTitleCacheInline.set(file, title);
        return title;
      };

      // Fleet 状态（fork：扫上游工件 + registry；行级父链富化见上）
      if (p[0] === "fleet" && p[1] === "status") {
        const state = uf().getFleetState() as { running: Array<Record<string, unknown>>; recent: Array<Record<string, unknown>> };
        enrichListRowsInline([...state.running, ...state.recent]);
        for (const r of [...state.running, ...state.recent]) {
          const pf = r.parentSessionFile as string | undefined;
          if (pf) r.parentTitle = parentTitleInline(pf);
        }
        return new Response(JSON.stringify(state), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      // 诊断：external-job providers 注册表 + pi-web-rpc 实测（进程内验证 provider 契约）
      if (p[0] === "fleet" && p[1] === "probe" && (req.method === "GET" || req.method === undefined)) {
        const probe = await (async () => {
          const out: { providers: string[]; job?: unknown; error?: string } = { providers: [] };
          try {
            // 直接读 Symbol.for 全局注册表（external-job-provider.ts 同 store，无需 import 模块）
            const reg = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-subagents.external-job-providers.v1")] as
              { providers?: Map<string, { name: string; start(input: unknown): unknown; status(id: string): unknown }> } | undefined;
            const providers = reg?.providers;
            out.providers = providers ? [...providers.keys()] : [];
            const provider = providers?.get("pi-web-rpc");
            if (provider) {
              // 实测：pi 后端 start 一条最小 job（进程内走 startPiBackend→startRpcSession→落盘）
              const h = provider.start({ prompt: "Reply with exactly: PING", cwd: process.cwd(), options: { backend: "pi" } }) as { providerJobId: string };
              await new Promise((r) => setTimeout(r, 2500)); // 诊断专用（非常规轮询）：等 pi 会话完成首轮
              out.job = { providerJobId: h.providerJobId, status: provider.status(h.providerJobId) };
            }
          } catch (e) {
            out.error = e instanceof Error ? e.message : String(e);
          }
          return out;
        })();
        return new Response(JSON.stringify(probe), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      // Fleet 事件流：fork 无进程内事件源，204（面板靠打开拉取 + ⟳ + 生命周期信号）
      if (p[0] === "fleet" && p[1] === "events") {
        return new Response(null, { status: 204 });
      }
      // 子代理并发配置（上游 <agentDir>/extensions/subagent/config.json；保存即生效——
      // 上游 loadConfig 每次 spawn 实时读文件，无需 reload/重启）。UI 入口 = 自家 Fleet 底栏
      // 「⚙ 并发」→ ConcurrencyDialog（架构拍板：配置归扩展自己，不写死到 extman 等宿主面板。
      // 纯函数层见 subagent-config.js；⚠ 该文件受 jiti 子模块缓存限制，改动不随 reload 生效，
      // 同 upstream-fleet.js——首次部署生效，后续改动需重启实例）
      if (p[0] === "config") {
        const sc = require("./subagent-config.js");
        const file = sc.configFilePath();
        const JSONH = { "content-type": "application/json" };
        if (req.method === "PUT" || req.method === "POST") {
          try {
            const body = await req.json();
            const cur = sc.readConfig(file);
            if (!cur.readable) {
              return new Response(JSON.stringify({ ok: false, error: `配置文件损坏，拒绝覆盖（先手工修复 ${file}: ${cur.error}）` }), { status: 500, headers: JSONH });
            }
            const r = sc.validateAndMerge(cur.config, body && typeof body === "object" ? (body.config ?? body) : {});
            if (!r.ok) return new Response(JSON.stringify({ ok: false, error: r.errors.join("；") }), { status: 400, headers: JSONH });
            sc.writeConfigAtomic(file, r.config);
            return new Response(JSON.stringify({ ok: true, path: file, config: r.config }), { headers: JSONH });
          } catch (e) {
            return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: JSONH });
          }
        }
        if (req.method === "GET" || req.method === undefined) {
          const cur = sc.readConfig(file);
          return new Response(JSON.stringify({ path: file, readable: cur.readable, error: cur.error, config: cur.config, meta: sc.meta(), defaults: sc.defaults() }), { headers: { ...JSONH, "cache-control": "no-store" } });
        }
        return new Response("method not allowed", { status: 405 });
      }
      // pi-web 启动类后端清单（子代理执行器选项：rpc/ACP 会话，前端可 attach）
      if (p[0] === "agents" && p[1] === "backends" && (req.method === "GET" || req.method === undefined)) {
        const backends: { key: string; label: string; source: string }[] = [{ key: "pi", label: "pi（内置 RPC 会话）", source: "local" }];
        // 直接读 globalThis 注册表（lib/session/providers.ts 的 providerMap——扩展 jiti
        // 环境不可用 @/ 别名 import，globalThis 是唯一跨 bundle 共享点）
        try {
          const map = (globalThis as { __sessionProviders?: Map<string, { agentKey?: string; label?: string; type?: string }> }).__sessionProviders;
          if (map) {
            const seen = new Set(["pi"]);
            for (const p of map.values()) {
              const key = p.agentKey;
              if (!key || seen.has(key)) continue;
              seen.add(key);
              backends.push({ key, label: p.label || key, source: p.type || "" });
            }
          }
        } catch { /* session 层不可用 → 仅内置 pi */ }
        return new Response(JSON.stringify(backends), { headers: { "content-type": "application/json", "cache-control": "max-age=30" } });
      }
      // Agent 定义 CRUD（fork：读上游 agent 体系文件——builtin=包内 agents/，
      // user 覆盖/自定义=<agentDir>/agents/*.md，上游 discoverAgents 的 user scope 优先级更高）
      if (p[0] === "agents") {
        try {
          const os = require("node:os");
          const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
          // builtin agents 目录多候选：pi packages 布局 → env 覆盖 → 全局 node_modules
          const builtinDirs = [
            ...(process.env.PI_SUBAGENTS_PACKAGE_DIR ? [path.join(process.env.PI_SUBAGENTS_PACKAGE_DIR, "agents")] : []),
            path.join(agentDir, "npm", "node_modules", "@aiti-ai", "pi-subagents", "agents"),
          ];
          const builtinDir = builtinDirs.find((dir) => fs.existsSync(dir)) ?? builtinDirs[0];
          const userDir = path.join(agentDir, "agents");
          // frontmatter 行级 merge：updates 里的顶层键按行替换（块整体替换），
          // runnerBlock null=原样保留 / []=删除 / 行数组=替换为该块；其余行原样保留。
          const mergeFrontmatterLines = (oldLines, updates, runnerBlock) => {
            const out = [];
            const seen = new Set();
            let i = 0;
            while (i < oldLines.length) {
              const line = oldLines[i];
              const m = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
              if (!m) { out.push(line); i += 1; continue; }
              const key = m[1];
              let j = i + 1;
              while (j < oldLines.length && /^\s/.test(oldLines[j])) j += 1; // 块延续（缩进子行）
              const block = oldLines.slice(i, j);
              if (key === "runner") {
                seen.add("runner");
                if (runnerBlock === null) out.push(...block);
                else if (runnerBlock.length > 0) out.push(...runnerBlock);
              } else if (key in updates) {
                seen.add(key);
                const v = updates[key];
                if (v !== null && v !== undefined && v !== "") out.push(`${key}: ${v}`);
              } else {
                out.push(...block);
              }
              i = j;
            }
            for (const [k, v] of Object.entries(updates)) {
              if (!seen.has(k) && v !== null && v !== undefined && v !== "") out.push(`${k}: ${v}`);
            }
            // 原文无 runner 键而新块非空（pi → external-cli 切换）→ 追加
            if (!seen.has("runner") && runnerBlock && runnerBlock.length > 0) out.push(...runnerBlock);
            return out;
          };
          const parseAgentMd = (file) => {
            const raw = fs.readFileSync(file, "utf8");
            const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
            // fmLines = frontmatter 原始行序列（含嵌套块/数组/注释）——保存时行级 merge，
            // 编辑器管理的字段之外一律原样保留（runner 嵌套块绝不丢）。
            const fmLines = m ? m[1].split("\n") : [];
            const rawFm = {};
            let currentKey = null;
            for (const line of fmLines) {
              const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
              if (kv) { currentKey = kv[1]; rawFm[kv[1]] = kv[2].trim(); continue; }
              if (!currentKey) continue;
              if (/^\s+-\s/.test(line)) {
                rawFm[currentKey] = `${rawFm[currentKey]}${rawFm[currentKey] ? "," : ""}${line.trim().replace(/^\s*-\s*/, "")}`;
              } else if (/^\s+[A-Za-z_-]+:\s*/.test(line) && rawFm[currentKey] === "") {
                // 嵌套块首子键：标记为块形态（值为块标记 <block>）
                rawFm[currentKey] = "<block>";
              }
            }
            // runner 嵌套块摘要（从原始行解析 type/adapter/command/promptDelivery）
            const runner = (() => {
              let inBlock = false;
              const r = {};
              for (const line of fmLines) {
                if (/^runner:\s*$/.test(line)) { inBlock = true; continue; }
                if (inBlock) {
                  if (/^\s/.test(line)) {
                    const kv = line.trim().match(/^([A-Za-z_-]+):\s*(.*)$/);
                    if (kv) r[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
                  } else break;
                }
              }
              return Object.keys(r).length ? r : null;
            })();
            const strip = (v) => String(v ?? "").trim().replace(/^["']|["']$/g, "");
            const list = (v) => String(v || "").split(",").map((x) => strip(x)).filter(Boolean);
            return {
              name: strip(rawFm.name),
              description: strip(rawFm.description),
              model: rawFm.model ?? "",
              tools: list(rawFm.tools),
              excludeTools: list(rawFm.excludeTools),
              thinking: rawFm.thinking || "",
              runner,
              systemPrompt: (m ? m[2] : raw).trim(),
              rawFm,
              fmLines,
            };
          };
          const scanDir = (dir, isUser) => {
            const out = [];
            try {
              for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith(".md")) continue;
                try {
                  const a = parseAgentMd(path.join(dir, f));
                  if (a.name) out.push({ ...a, isUserDefined: isUser, file: path.join(dir, f) });
                } catch { /* 单文件损坏跳过 */ }
              }
            } catch { /* 目录不存在 */ }
            return out;
          };

          if (p[1] === undefined && (req.method === "GET" || req.method === undefined)) {
            const user = scanDir(userDir, true);
            const builtin = scanDir(builtinDir, false);
            const seen = new Set(user.map((a) => a.name));
            const merged = [...user, ...builtin.filter((b) => !seen.has(b.name))];
            return new Response(JSON.stringify(merged.map((a) => ({ name: a.name, description: a.description, model: a.model, tools: a.tools, excludeTools: a.excludeTools, runner: a.runner, isUserDefined: a.isUserDefined }))), { headers: { "content-type": "application/json", "cache-control": "max-age=5" } });
          }
          if (p[1] !== undefined && (req.method === "GET" || req.method === undefined)) {
            const all = [...scanDir(userDir, true), ...scanDir(builtinDir, false)];
            const hit = all.find((a) => a.name === p[1]);
            if (!hit) return new Response("not found: " + p[1], { status: 404 });
            return new Response(JSON.stringify(hit), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
          }
          // 接管：把 fork 内置外部 CLI agent 的执行替换为 pi-web 后端（同名 user 覆盖，
          // fork 合并序 user > builtin；删除覆盖即恢复 fork 直启）。adapter→agentKey 映射：
          //   claude-code(-writer)→claude；codex-exec(-writer)→codex；cursor 系无 pi-web 后端。
          if (p[1] === "takeover" && req.method === "POST") {
            const ADAPTER_TO_BACKEND: Record<string, string> = {
              "claude-code": "claude", "claude-code-writer": "claude",
              "codex-exec": "codex", "codex-exec-writer": "codex",
              "cursor-agent": "cursor", "cursor-agent-writer": "cursor",
            };
            const body = await req.json();
            const name = String(body?.name || "").trim();
            if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("agent 名仅允许字母数字_-");
            // fork 保留名守卫（external-cli-contract.ts RESERVED_READ_ONLY_ADAPTERS）：这三个选择名只允许
            // runner=external-cli+同名 adapter，user 覆盖成其它 runner 会被 fork 校验拒绝（0.59 起实测）。
            // 接管请用 -writer 变体或自定义名。
            const RESERVED_READ_ONLY = ["claude-code", "codex-exec", "cursor-agent"];
            if (RESERVED_READ_ONLY.includes(name)) {
              return new Response(JSON.stringify({ ok: false, error: `"${name}" 是 fork 保留的只读 adapter 名，接管会被校验拒绝；请接管对应的 -writer 变体（如 ${name}-writer）或创建自定义名 agent` }), { status: 400, headers: { "content-type": "application/json" } });
            }
            // 定位当前生效定义（builtin 优先，其次 user 已覆盖）
            let baseFile: string | null = null;
            for (const dir of [builtinDir, userDir]) {
              const f = path.join(dir, `${name}.md`);
              if (fs.existsSync(f)) { baseFile = f; break; }
            }
            if (!baseFile) return new Response(JSON.stringify({ ok: false, error: `未找到内置 agent "${name}"` }), { status: 400, headers: { "content-type": "application/json" } });
            const parsed = parseAgentMd(baseFile);
            const adapter = parsed.runner?.adapter || "";
            const backend = ADAPTER_TO_BACKEND[adapter];
            if (!backend) return new Response(JSON.stringify({ ok: false, error: `"${name}" 不是可接管的外部 CLI agent（adapter=${adapter || "无"}）` }), { status: 400, headers: { "content-type": "application/json" } });
            // 目标后端必须在位（对应扩展安装且 CLI 可用才会注册）
            const providers = (globalThis as { __sessionProviders?: Map<string, { agentKey?: string }> }).__sessionProviders;
            const alive = providers ? [...providers.values()].some((p) => p.agentKey === backend) : false;
            if (!alive) return new Response(JSON.stringify({ ok: false, error: `pi-web 后端 "${backend}" 未就绪（扩展未安装或 CLI 不在 PATH）` }), { status: 400, headers: { "content-type": "application/json" } });
            // 行级 merge：只换 runner 块为 pi-web 执行器，其余 frontmatter 行原样保留
            const outLines = mergeFrontmatterLines(parsed.fmLines, {}, [
              "runner:", "  type: external-job", "  provider: pi-web-rpc", "  options:", `    backend: ${backend}`,
            ]);
            fs.mkdirSync(userDir, { recursive: true });
            const target = path.join(userDir, `${name}.md`);
            fs.writeFileSync(target, ["---", ...outLines, "---", "", parsed.systemPrompt].join("\n") + "\n");
            return new Response(JSON.stringify({ ok: true, backend, file: target }), { headers: { "content-type": "application/json" } });
          }
          if (p[1] !== undefined && req.method === "DELETE") {
            // 按 frontmatter name 定位文件（文件名可能与 agent 名不同）
            let target = null;
            try {
              for (const f of fs.readdirSync(userDir)) {
                if (!f.endsWith(".md")) continue;
                try { if (parseAgentMd(path.join(userDir, f)).name === p[1]) { target = path.join(userDir, f); break; } } catch {}
              }
            } catch { /* 无 user 目录 */ }
            if (!target) return new Response(JSON.stringify({ ok: false, error: "非用户自定义（内置 agent 不可删除）" }), { status: 400, headers: { "content-type": "application/json" } });
            fs.rmSync(target);
            return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
          }
          if (req.method === "POST" || req.method === "PUT") {
            const body = await req.json();
            const name = String(body.name || "").trim();
            if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("agent 名仅允许字母数字_-");
            fs.mkdirSync(userDir, { recursive: true });
            const file = path.join(userDir, `${name}.md`);
            const tools = Array.isArray(body.tools) ? body.tools : String(body.tools || "").split(",").map((x) => x.trim()).filter(Boolean);
            const excludeTools = Array.isArray(body.excludeTools) ? body.excludeTools : String(body.excludeTools || "").split(",").map((x) => x.trim()).filter(Boolean);
            // frontmatter 行级 merge：编辑器管理的字段（name/description/model/tools/
            // excludeTools + runner）按行替换，其余行（thinking/systemPromptMode/嵌套块/
            // 数组/注释…）原样保留——编辑保存绝不造成 agent 配置退化或执行器身份丢失。
            // merge 基底 = 当前生效定义（user 覆盖优先，其次 builtin）的原始行；结果写
            // user 目录（上游 user scope 优先级更高，覆盖生效）。
            let baseLines = null;
            for (const dir of [builtinDir, userDir]) {
              const f = path.join(dir, `${name}.md`);
              if (fs.existsSync(f)) { baseLines = parseAgentMd(f).fmLines; break; }
            }
            const updates = {
              name,
              ...(body.description !== undefined ? { description: String(body.description).replace(/\n/g, " ") } : {}),
              ...(body.model !== undefined ? { model: String(body.model) } : {}),
              ...(body.tools !== undefined ? { tools: tools.join(", ") } : {}),
              ...(body.excludeTools !== undefined ? { excludeTools: excludeTools.join(", ") } : {}),
            };
            // runner：undefined=不动；null=删除（回退内置 pi）；对象=重建块
            const runnerBlock = (() => {
              const r = body.runner;
              if (r === undefined) return null; // 原样保留
              if (r === null || r === "" || (r && r.type === "pi")) return []; // 删除 runner → 内置 pi
              if (r.type === "external-job") {
                // pi-web 启动类后端（rpc/ACP 会话）：provider 固定 pi-web-rpc，options.backend 指定后端
                const backend = String((r as { options?: { backend?: string } }).options?.backend || "pi").trim();
                if (!/^[A-Za-z0-9_-]+$/.test(backend)) throw new Error("runner.options.backend 仅允许字母数字_-");
                return ["runner:", `  type: external-job`, `  provider: pi-web-rpc`, `  options:`, `    backend: ${backend}`];
              }
              if (r.type !== "external-cli" || !r.adapter) throw new Error("runner 仅支持 type:pi / {type:external-cli,...} / {type:external-job, options:{backend}}");
              const defaultCommand = { "claude-code": "claude", "claude-code-writer": "claude", "codex-exec": "codex", "codex-exec-writer": "codex", "cursor-agent": "cursor-agent", "cursor-agent-writer": "cursor-agent" }[r.adapter] || r.adapter;
              const lines = ["runner:", `  type: external-cli`, `  adapter: ${r.adapter}`, `  command: ${String(r.command || defaultCommand)}`];
              // promptDelivery：cursor 系无此行（fork 强制 prompt-file）；其余缺省 stdin——
              // 落盘显式写出，不依赖上游缺省（文件自描述）。
              const wantsStdin = !String(r.adapter).startsWith("cursor");
              const pd = r.promptDelivery || (wantsStdin ? "stdin" : "");
              if (pd) lines.push(`  promptDelivery: ${pd}`);
              return lines;
            })();
            const outLines = mergeFrontmatterLines(baseLines ?? [], updates, runnerBlock);
            fs.writeFileSync(file, ["---", ...outLines, "---", "", String(body.systemPrompt ?? "").replace(/\r\n/g, "\n")].join("\n") + "\n");
            return new Response(JSON.stringify({ ok: true, file }), { headers: { "content-type": "application/json" } });
          }
          return new Response("method not allowed", { status: 405 });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { "content-type": "application/json" } });
        }
      }
      // 运行记录（fork：上游工件）
      if (p[0] === "runs") {
        const all = uf().listUpstreamRuns().runs;
        const id = p[1];
        if (id) {
          const run = all.find((r) => r.id === id);
          if (!run) return new Response("not found", { status: 404 });
          return new Response(JSON.stringify(run), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
        }
        return new Response(JSON.stringify(all), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      // 自检（fork）
      if (p[0] === "doctor") {
        return new Response(JSON.stringify(uf().doctor()), {
          headers: { "content-type": "application/json" },
        });
      }
      // fork 引擎：单 run 详情（status/steps/usage/cost + 上游 run 报告 markdown + 工件；
      // live 时附 /web 桥实时状态与最近消息）
      if (p[0] === "fleet" && p[1] === "run" && p[2] && req.method !== "POST") {
        // 轻量定位工件目录（readdir 找 meta 文件名，不读内容），详情内各段共享
        const knownArtifactDir = (() => {
          try {
            const sessionsRoot = path.join(agentDirInline(), "sessions");
            for (const cwdDir of fs.readdirSync(sessionsRoot)) {
              const artDir = path.join(sessionsRoot, cwdDir, "subagent-artifacts");
              try { if (fs.readdirSync(artDir).some((f) => f.startsWith(p[2]))) return artDir; } catch { continue; }
            }
          } catch { /* ignore */ }
          return "";
        })();
        const detail = getRunDetailInline(p[2], knownArtifactDir);
        if (!detail) return new Response("not found", { status: 404 });
        if (detail.live) {
          // bridge 实时增强：get_state + 最近消息尾部（超时保护，失败不阻塞详情）
          detail.bridge = await bridgeLiveView(p[2]).catch((e) => ({ attached: false, error: String(e?.message || e) }));
        }
        return new Response(JSON.stringify(detail), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      // fork 引擎：桥优先即时控制（abort/steer/prompt），回退 control inbox 文件投递
      if (p[0] === "fleet" && p[1] === "bridge" && req.method === "POST") {
        try {
          const body = await req.json();
          const action = String(body.action || "");
          if (!"abort,steer,prompt".includes(action) || !action) return new Response(JSON.stringify({ ok: false, error: "action 必须是 abort/steer/prompt" }), { status: 400, headers: { "content-type": "application/json" } });
          const r = await controlRun(String(body.id || ""), action, body.message);
          return new Response(JSON.stringify(r), { status: r.ok ? 200 : 400, headers: { "content-type": "application/json" } });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), { status: 400, headers: { "content-type": "application/json" } });
        }
      }
      return new Response("not found: " + p.join("/"), { status: 404 });
    },

    // ---- 方案 M：agent 扩展点 ----
    // fork 引擎不注入任何工具（subagent 工具由 pi packages 的上游扩展提供）；
    // 生命周期钩子亦无进程内状态需要维护。
    agent: {},
  },
};