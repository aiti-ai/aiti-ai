// src/index.ts
import { tool } from "@opencode-ai/plugin";

// node_modules/@aiti-ai/aiti-devtools-agent/dist/index.js
var AgentBridgeClient = class {
  _bridgeUp = false;
  /** 桥地址（已剥尾部斜杠，含 /aiti 路径前缀等） */
  base;
  constructor(base) {
    this.base = base.replace(/\/+$/, "");
  }
  /** 桥当前连通状态（probe/register 成功置 true，失败置 false） */
  get isUp() {
    return this._bridgeUp;
  }
  /** 桥连通性预检（GET /bridge/sessions；本地拒绝连接即时返回） */
  async probe(timeoutMs = 2500) {
    try {
      const res = await fetch(this.base + "/bridge/sessions", { signal: AbortSignal.timeout(timeoutMs) });
      this._bridgeUp = res.ok;
      return res.ok;
    } catch {
      this._bridgeUp = false;
      return false;
    }
  }
  /** agent 启动注册（POST /bridge/agent/register）→ agentKey；失败返回 null */
  async register(opts) {
    try {
      const res = await fetch(this.base + "/bridge/agent/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5e3),
        body: JSON.stringify({
          agentId: opts.agentId,
          sessionId: opts.sessionId,
          name: opts.name,
          cwd: opts.cwd || void 0,
          source: opts.source || "extension",
          subEvents: opts.subEvents ?? ["page_error"]
        })
      });
      const b = await res.json().catch(() => null);
      return b && b.ok ? b : null;
    } catch {
      return null;
    }
  }
  /** 工具执行（POST /bridge/agent/tools/call）——支持宿主 signal 取消 + cancelId 通知桥中断挂起请求 */
  async callTool(tool2, args, opts, signal) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 65e3);
    const onAbort = () => {
      clearTimeout(t);
      try {
        ctrl.abort();
      } catch {
      }
      if (opts.cancelId) {
        void fetch(this.base + "/bridge/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cancelId: opts.cancelId }),
          signal: AbortSignal.timeout(3e3)
        }).catch(() => {
        });
      }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return { ok: false, error: "\u5DF2\u53D6\u6D88\uFF08agent \u505C\u6B62\uFF09" };
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const res = await fetch(this.base + "/bridge/agent/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        tool: tool2,
        args: args || {},
        agentId: opts.agentId,
        sessionId: opts.sessionId,
        cwd: opts.cwd || void 0,
        source: "extension",
        cancelId: opts.cancelId
      })
    }).catch(() => null);
    if (signal) {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
      }
    }
    clearTimeout(t);
    if (!res) return { ok: false, error: "\u6865\u4E0D\u53EF\u8FBE\uFF1A" + this.base };
    const body = await res.json().catch(() => null);
    if (!body) return { ok: false, error: "\u6865\u54CD\u5E94\u5F02\u5E38\uFF08HTTP " + res.status + "\uFF09" };
    return body;
  }
  /** agent 完成 → 回答回桥（POST /bridge/agent/answer）——消息流落盘供窗口展示 */
  async answer(agentKey, text) {
    try {
      await fetch(this.base + "/bridge/agent/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5e3),
        body: JSON.stringify({ agentKey, text })
      });
    } catch {
    }
  }
  /**
   * agent SSE 持久流（桥 → 宿主注入模型）。断线指数退避重连 + 空闲兜底。
   *
   * @param registerFn 每次（重）连前调用以（重新）注册并取 agentKey——桥重启后 agents 表会丢，
   *   必须在 connect 前重新 register；返回 null 表示本轮不连（宿主要求，不重试）。
   * @param onMessage 每条 SSE 消息回调（含 type/text/payload）
   * @param opts idleMs（空闲超时，默认 60000）；retryBase（退避基数，默认 2000）
   * @returns 停止函数（置停 + abort 当前流；不再重连）
   */
  connectAgentStream(registerFn, onMessage, opts = {}) {
    const idleMs = opts.idleMs ?? 6e4;
    let retry = opts.retryBase ?? 2e3;
    let ctrl = null;
    let stopped = false;
    const run = async () => {
      if (stopped) return;
      const c = new AbortController();
      ctrl = c;
      const agentKey = await registerFn();
      if (!agentKey || stopped) {
        if (ctrl === c) ctrl = null;
        return;
      }
      this._bridgeUp = true;
      let idleTimer = null;
      const poke = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          try {
            c.abort();
          } catch {
          }
        }, idleMs);
      };
      try {
        const resp = await fetch(this.base + "/bridge/agent/sse?agentKey=" + encodeURIComponent(agentKey), {
          signal: c.signal,
          headers: { Accept: "text/event-stream" }
        });
        if (!resp.ok || !resp.body) throw new Error("SSE HTTP " + resp.status);
        retry = opts.retryBase ?? 2e3;
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        poke();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          poke();
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data:"));
            if (line) {
              try {
                onMessage(JSON.parse(line.slice(5).trim()));
              } catch {
              }
            }
          }
        }
      } catch {
      }
      if (idleTimer) clearTimeout(idleTimer);
      if (stopped) return;
      if (ctrl === c) {
        setTimeout(() => {
          if (ctrl === c && !stopped) run();
        }, retry);
        retry = Math.min(3e4, retry * 2);
      }
    };
    run();
    return () => {
      stopped = true;
      try {
        ctrl?.abort();
      } catch {
      }
      ctrl = null;
    };
  }
};
function wrapToolResult(r) {
  if (!r.ok) {
    return { content: [{ type: "text", text: r.error || "\u672A\u77E5\u9519\u8BEF" }], details: {}, isError: true };
  }
  return {
    content: [{ type: "text", text: r.result ?? "" }],
    details: {},
    ...r.isError ? { isError: true } : {}
  };
}

// node_modules/@aiti-ai/aiti-devtools-core/dist/index.js
import { homedir } from "node:os";
import { join as join2, dirname as dirname2 } from "node:path";
import { existsSync as existsSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2, renameSync as renameSync2, mkdirSync as mkdirSync2, rmSync as rmSync2 } from "node:fs";
var ID_TTL = parseInt(process.env.AITI_BRIDGE_TTL || "600000", 10);
var AGENT_TTL = parseInt(process.env.AITI_AGENT_TTL || "3600000", 10);
var BROADCAST_TTL = parseInt(process.env.AITI_BROADCAST_TTL || "600000", 10);
var AGENT_GRACE_TTL = parseInt(process.env.AITI_AGENT_GRACE_TTL || "120000", 10);
var AGENT_HISTORY_TTL = parseInt(process.env.AITI_AGENT_HISTORY_TTL || String(7 * 24 * 3600 * 1e3), 10);
var SWEEP_MS = parseInt(process.env.AITI_SWEEP_MS || "60000", 10);
var ORPHAN_RE = /\[(?:元素|回答|错误)\d+\]/g;
var LEGACY_TAG_RE = /\[选择\d+\]/g;
var SRC_TAG_RE = /\[发自:[^\]]*\]\s*/g;
var ORPHAN_NOTICE = "[\u26A0 \u5019\u9009\u5DF2\u5931\u6548\uFF0C\u5360\u4F4D\u7B26\u5DF2\u79FB\u9664\uFF08\u91CD\u65B0\u9009\u5143\u7D20/\u5237\u65B0\u9875\u9762\u91CD\u91C7\uFF09]";
function clipUrl(u, max = 120) {
  if (!u) return "";
  try {
    const p = new URL(u);
    p.hash = "";
    let out = p.origin + p.pathname;
    if (p.search) {
      const q = p.search.slice(1).split("&").filter(Boolean).slice(0, 2);
      if (q.length) out += "?" + q.join("&");
    }
    return out.length > max ? out.slice(0, max) + "\u2026" : out;
  } catch {
    return u.length > max ? u.slice(0, max) + "\u2026" : u;
  }
}
function withSourceTag(text, opts) {
  const pid = opts.pid || "";
  if (!pid) return text;
  const note = opts.srcNote ?? "aiti-*\uFF1ApageId \u53C2\u6570\u7528\u5B83";
  const tag = "[\u53D1\u81EA: " + pid + (opts.pageUrl ? " \xB7 " + clipUrl(opts.pageUrl) : "") + "\uFF08" + note + "\uFF09]";
  const cleaned = String(text || "").replace(SRC_TAG_RE, "").replace(/\s+$/, "");
  return (cleaned ? cleaned + "\n" : "") + tag;
}
function stripOrphanTags(text) {
  return String(text || "").replace(ORPHAN_RE, ORPHAN_NOTICE);
}
function replaceTag(text, tag, desc) {
  const i = text.indexOf(tag);
  if (i < 0) return text;
  const rest = text.slice(i + tag.length);
  return text.slice(0, i) + desc + (rest.trim() ? "\n" + rest : rest);
}
function rewriteMessage(text, picked, opts = {}) {
  let out = String(text || "");
  const usedTags = [];
  out = out.replace(LEGACY_TAG_RE, "");
  if (picked.length) {
    for (const c of picked) {
      if (c.tag && out.includes(c.tag)) {
        out = replaceTag(out, c.tag, c.describe || c.tag);
        usedTags.push(c.tag);
      }
    }
  }
  if (ORPHAN_RE.test(out)) {
    ORPHAN_RE.lastIndex = 0;
    out = stripOrphanTags(out);
  } else ORPHAN_RE.lastIndex = 0;
  const usedAny = usedTags.length > 0;
  const finalText = withSourceTag(out, opts);
  return { text: finalText, usedTags, usedAny };
}
var homeDir = () => homedir();
var MCP_TARGETS = {
  // pi 实际读取 getAgentDir()/mcp.json（getAgentDir = $PI_CODING_AGENT_DIR，默认 ~/.pi/agent）；
  // ~/.config/mcp/mcp.json 是历史误记——默认 pi 不读它（探针实证 2026-09-10，见执行记录 P17）
  pi: [{ path: () => join2(process.env.PI_CODING_AGENT_DIR || join2(homeDir(), ".pi", "agent"), "mcp.json"), key: "mcpServers" }],
  zcode: [{ path: () => join2(homeDir(), ".zcode", "cli", "config.json"), key: "mcpServers", keyPath: ["mcp", "servers"] }],
  opencode: [{
    path: () => join2(homeDir(), ".config", "opencode", "opencode.json"),
    key: "mcpServers",
    keyPath: ["mcp"],
    shimEntry: (shimPath) => ({ type: "local", command: ["node", shimPath], enabled: true }),
    envKey: "environment",
    // opencode 的 env map 字段名异构；条目零顶层私有键（schema 严格拒未知键）
    httpEntry: (url) => ({ type: "remote", url, enabled: true })
    // D23：http 类型对 opencode 非法
  }],
  claude: [
    { path: () => join2(homeDir(), ".claude.json"), key: "mcpServers" },
    { path: (p) => join2(p, ".mcp.json"), key: "mcpServers", project: true }
  ],
  // CodeBuddy Code（腾讯 cbc）：用户级 ~/.codebuddy/.mcp.json（官方 mcp.md：.mcp.json 推荐 /
  // mcp.json 已废弃；条目形状 mcpServers+stdio 与 claude 同构，2026-09-11 cbc mcp add 实测钉死）。
  // 项目级 .mcp.json 与 claude 同文件（claude 目标已覆盖），不重复注册。
  codebuddy: [{ path: () => join2(homeDir(), ".codebuddy", ".mcp.json"), key: "mcpServers" }],
  cursor: [{ path: () => join2(homeDir(), ".cursor", "mcp.json"), key: "mcpServers" }],
  windsurf: [{ path: () => join2(homeDir(), ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" }],
  vscode: [{ path: (p) => join2(p, ".vscode", "mcp.json"), key: "servers", project: true }],
  zed: [
    { path: () => join2(homeDir(), ".config", "zed", "settings.json"), key: "mcp" },
    { path: (p) => join2(p, ".zed", "settings.json"), key: "mcp", project: true }
  ]
};
function detectStructureKey(cfg) {
  if (cfg && typeof cfg === "object") {
    const c = cfg;
    if (c.mcpServers && typeof c.mcpServers === "object") return { key: "mcpServers", inferred: false };
    if (c.servers && typeof c.servers === "object") return { key: "servers", inferred: false };
    if (c.mcp && typeof c.mcp === "object") return { key: "mcp", inferred: false };
  }
  return { key: "mcpServers", inferred: true };
}
function readJson(path) {
  try {
    return { cfg: JSON.parse(stripBom(readFileSync2(path, "utf8"))) };
  } catch {
    try {
      const clean = stripJsonComments(stripBom(readFileSync2(path, "utf8"))).replace(/,\s*([}\]])/g, "$1");
      return { cfg: JSON.parse(clean) };
    } catch (e) {
      return { cfg: null, error: "JSON \u89E3\u6790\u5931\u8D25\uFF1A" + String(e?.message || e) };
    }
  }
}
function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}
function isPlainContainer(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function stripJsonComments(text) {
  let out = "";
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      out += " ";
      continue;
    }
    out += c;
  }
  return out;
}
function resolveContainer(cfg, keyPath) {
  let cur = cfg;
  for (const k of keyPath) {
    if (!isPlainContainer(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}
function writeAtomic(path, cfg) {
  const tmp = path + ".tmp";
  const bak = path + ".bak";
  mkdirSync2(dirname2(path), { recursive: true });
  writeFileSync2(tmp, JSON.stringify(cfg, null, 2) + "\n");
  if (existsSync2(path)) {
    try {
      renameSync2(path, bak);
    } catch {
    }
  }
  try {
    renameSync2(tmp, path);
  } catch (e) {
    if (existsSync2(bak) && !existsSync2(path)) {
      try {
        renameSync2(bak, path);
      } catch {
      }
    }
    try {
      rmSync2(tmp, { force: true });
    } catch {
    }
    throw e;
  }
}
function listPlannedWrites(opts) {
  const projectDir = opts.projectDir || process.cwd();
  const out = [];
  const hasConfigPaths = !!(opts.configPaths && opts.configPaths.length);
  const auto = (opts.targets === "auto" || !opts.targets) && !hasConfigPaths;
  if (!hasConfigPaths) {
    const targets = auto ? Object.keys(MCP_TARGETS) : opts.targets;
    for (const t of targets) {
      const files = MCP_TARGETS[t];
      if (!files) continue;
      for (const f of files) {
        const p = f.path(projectDir);
        if (auto && !existsSync2(p)) continue;
        out.push({ target: t, path: p, key: f.key, exists: existsSync2(p), keyPath: f.keyPath, shimEntry: f.shimEntry, envKey: f.envKey, httpEntry: f.httpEntry });
      }
    }
  }
  for (const p of opts.configPaths || []) {
    const abs = p.replace(/^~(?=\/|$)/, homeDir());
    let matched = null;
    for (const [t, files] of Object.entries(MCP_TARGETS)) {
      for (const f of files) {
        if (f.path(projectDir) === abs) {
          matched = { target: t, path: abs, key: f.key, exists: existsSync2(abs), keyPath: f.keyPath, shimEntry: f.shimEntry, envKey: f.envKey, httpEntry: f.httpEntry };
          break;
        }
      }
      if (matched) break;
    }
    out.push(matched ?? { target: abs, path: abs, key: "mcpServers", exists: existsSync2(abs) });
  }
  return out;
}
function assertKnownTargets(targets) {
  if (!targets || targets === "auto") return null;
  const unknown = targets.filter((t) => !MCP_TARGETS[t]);
  return unknown.length ? `\u672A\u77E5\u6CE8\u518C\u76EE\u6807\uFF1A${unknown.join("\u3001")}\uFF08\u53EF\u7528\uFF1A${Object.keys(MCP_TARGETS).join("\u3001")}\uFF09` : null;
}
var LEGACY_VERSION_FIELD = "_aitiShimVersion";
var SHIM_VERSION_ENV = "AITI_SHIM_VERSION";
function readShimEntryVersion(entry, envKey) {
  const env = entry[envKey];
  if (!isPlainContainer(env)) return 0;
  return parseInt(String(env[SHIM_VERSION_ENV] ?? ""), 10) || 0;
}
function entryReferencesShimPath(entry, shimPath) {
  return JSON.stringify(entry).includes(JSON.stringify(shimPath));
}
function registerAitiShim(opts) {
  const unknownErr = assertKnownTargets(opts.targets);
  if (unknownErr) return { ok: false, changed: false, results: [], summary: unknownErr };
  const serverName = opts.serverName || "aiti";
  const dryRun = !!opts.dryRun;
  const log = opts.log || ((l) => console.log(l));
  const results = [];
  let changed = false;
  for (const w of listPlannedWrites(opts)) {
    const outcome = (() => {
      let cfg;
      if (!existsSync2(w.path)) {
        cfg = {};
      } else {
        const r = readJson(w.path);
        if (r.error) return { changed: false, error: "JSON \u89E3\u6790\u5931\u8D25\uFF1A" + r.error };
        cfg = r.cfg;
      }
      if (!isPlainContainer(cfg)) return { changed: false, error: "\u914D\u7F6E\u4E0D\u662F\u5BF9\u8C61" };
      const map = w.keyPath ? resolveContainer(cfg, w.keyPath) : (() => {
        const det = detectStructureKey(cfg);
        if (!isPlainContainer(cfg[det.key])) cfg[det.key] = {};
        return cfg[det.key];
      })();
      const existing = map[serverName] && typeof map[serverName] === "object" && !Array.isArray(map[serverName]) ? map[serverName] : null;
      const envKey = w.envKey || "env";
      const existingVer = existing ? readShimEntryVersion(existing, envKey) : 0;
      const hasLegacyField = !!existing && LEGACY_VERSION_FIELD in existing;
      const shimShapeBroken = !!w.shimEntry && !!existing && ("args" in existing || "env" in existing && envKey !== "env");
      if (existing && !hasLegacyField && !shimShapeBroken && existingVer >= opts.version && !opts.force && entryReferencesShimPath(existing, opts.shimPath)) {
        return { changed: false, note: `\u5DF2\u662F\u6700\u65B0\uFF08v${existingVer} >= v${opts.version}\uFF09` };
      }
      if (!dryRun) {
        const entry = { ...existing || {}, ...w.shimEntry ? w.shimEntry(opts.shimPath) : { type: "stdio", command: "node", args: [opts.shimPath] } };
        delete entry.url;
        delete entry[LEGACY_VERSION_FIELD];
        if (w.shimEntry) {
          delete entry.args;
          delete entry.env;
        }
        const prevEnv = isPlainContainer(entry[envKey]) ? entry[envKey] : {};
        entry[envKey] = { ...prevEnv, [SHIM_VERSION_ENV]: String(opts.version) };
        map[serverName] = entry;
        try {
          writeAtomic(w.path, cfg);
        } catch (e) {
          return { changed: false, error: "\u5199\u5165\u5931\u8D25\uFF1A" + String(e?.message || e) };
        }
      }
      return { changed: true, note: hasLegacyField ? `\u8FC1\u79FB\uFF08\u9876\u5C42\u7248\u672C\u952E \u2192 ${envKey}.${SHIM_VERSION_ENV}\uFF09` : existing ? `\u5347\u7EA7 v${existingVer} \u2192 v${opts.version}` : "\u65B0\u5EFA" };
    })();
    results.push({ target: w.target, path: w.path, changed: outcome.changed, error: outcome.error });
    if (outcome.error) log(`  \u2717 ${w.target} \u2192 ${w.path}\uFF1A${outcome.error}`);
    else {
      if (outcome.changed) changed = true;
      log(`  ${outcome.changed ? "\u2713" : "\xB7"} ${w.target} \u2192 ${w.path}${outcome.note ? "\uFF1A" + outcome.note : ""}`);
    }
  }
  const ok = results.every((r) => !r.error);
  const summary = `${dryRun ? "[dry-run] " : ""}shim ${serverName} v${opts.version}\uFF08${opts.shimPath}\uFF09${results.length ? "\uFF1B" + results.map((r) => r.error ? r.target + " \u2717" : r.changed ? r.target + " \u2713" : r.target + " \xB7").join(" ") : "\uFF08\u65E0\u76EE\u6807\u6587\u4EF6\uFF09"}`;
  return { ok, changed, results, summary };
}
function resolveShimPathAuto(cwdCandidates) {
  const installedCandidates = [
    process.env.AITI_WEB_ROOT && join2(process.env.AITI_WEB_ROOT, "node_modules"),
    join2(homeDir(), ".pi", "web", "node_modules"),
    join2(homeDir(), ".pi", "web-dev", "node_modules")
  ].filter((p) => !!p).map((nm) => join2(nm, "@aiti-ai", "aiti-bridge", "bin", "aiti-mcp-shim.cjs"));
  const candidates = [
    process.env.AITI_SHIM_PATH,
    ...installedCandidates,
    ...cwdCandidates || [],
    join2(homeDir(), "workspace", "pi-work", "packages", "aiti-bridge", "bin", "aiti-mcp-shim.cjs")
  ].filter((p) => !!p);
  for (const p of candidates) {
    try {
      const m = readFileSync2(p, "utf8").match(/SHIM_VERSION\s*=\s*(\d+)/);
      if (m) return { shimPath: p, version: parseInt(m[1], 10) };
    } catch {
    }
  }
  return null;
}

// src/index.ts
import { existsSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join } from "node:path";
var z = tool.schema;
var BRIDGE_BASE = (process.env.AITI_BRIDGE_URL || "http://127.0.0.1:8777").replace(/\/+$/, "") + "/aiti";
var AGENT_ID = "opencode";
var PREFIX = "aiti_";
var DESCRIPTION_SUFFIX = "\uFF08aiti-devtools \u76F4\u8FDE\uFF0COpenCode \u4F1A\u8BDD\uFF09";
function schemaToZod(s) {
  const sch = s || {};
  const d = (zod) => typeof sch.description === "string" && sch.description ? zod.describe(sch.description) : zod;
  switch (sch.type) {
    case "string":
      return d(z.string());
    case "number":
      return d(z.number());
    case "boolean":
      return d(z.boolean());
    case "object": {
      if (sch.properties && typeof sch.properties === "object") {
        const shape = {};
        const req = new Set(Array.isArray(sch.required) ? sch.required : []);
        for (const [k, v] of Object.entries(sch.properties)) {
          shape[k] = req.has(k) ? schemaToZod(v) : schemaToZod(v).optional();
        }
        return d(z.object(shape));
      }
      return d(z.record(z.string(), z.any()));
    }
    case "array":
      return d(z.array(schemaToZod(sch.items)));
    default:
      return z.any();
  }
}
function schemaToShape(schema) {
  const out = {};
  const props = schema?.properties || {};
  const req = new Set(Array.isArray(schema?.required) ? schema.required : []);
  for (const [k, v] of Object.entries(props)) {
    out[k] = req.has(k) ? schemaToZod(v) : schemaToZod(v).optional();
  }
  return out;
}
async function fetchBridgeTools(base) {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(5e3),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const body = await res.json().catch(() => null);
  const tools = body?.result?.tools;
  return Array.isArray(tools) ? tools : [];
}
function autoRegisterShimInline() {
  try {
    const found = resolveShimPathAuto();
    if (!found) return;
    const cfgPath = join(homedir2(), ".config", "opencode", "opencode.json");
    if (!existsSync(cfgPath)) return;
    registerAitiShim({ shimPath: found.shimPath, version: found.version, configPaths: [cfgPath], log: () => {
    } });
  } catch {
  }
}
var AitiDevtoolsPlugin = async (input) => {
  const { client, directory: ctxDirectory } = input;
  autoRegisterShimInline();
  const bridge = new AgentBridgeClient(BRIDGE_BASE);
  const log = (msg) => {
    void client.app.log({ body: { service: "aiti-devtools-opencode", level: "info", message: msg } }).catch(() => {
    });
  };
  const sessions = /* @__PURE__ */ new Map();
  async function registerAndStream(sessionID, directory) {
    const existing = sessions.get(sessionID);
    if (existing) return existing;
    const reg = await bridge.register({
      agentId: AGENT_ID,
      sessionId: sessionID,
      name: "OpenCode",
      cwd: directory,
      source: "plugin",
      subEvents: ["page_error"]
    });
    if (!reg || !reg.agentKey) return null;
    const sess = { agentKey: reg.agentKey, cwd: directory, stopStream: () => {
    } };
    sessions.set(sessionID, sess);
    sess.stopStream = bridge.connectAgentStream(
      async () => {
        const r = await bridge.register({ agentId: AGENT_ID, sessionId: sessionID, name: "OpenCode", cwd: directory, source: "plugin", subEvents: ["page_error"] });
        return r?.agentKey ?? null;
      },
      (m) => {
        const text = typeof m.text === "string" && m.text || (m.payload && typeof m.payload.text === "string" ? m.payload.text : "") || JSON.stringify(m);
        log("push \u2192 session.prompt: " + text.slice(0, 80));
        void client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } }).catch((e) => {
          log("session.prompt failed: " + (e instanceof Error ? e.message : String(e)));
        });
      }
    );
    log("session registered: " + sessionID + " (cwd " + directory + ")");
    return sess;
  }
  const bridgeTools = await fetchBridgeTools(BRIDGE_BASE);
  const hooks = { event: void 0, tool: {} };
  if (!bridgeTools.length) {
    log("bridge not reachable at " + BRIDGE_BASE + " \u2014 placeholder tools registered");
    const errText = "\u6865\u4E0D\u53EF\u8FBE\uFF1A" + BRIDGE_BASE + "\u3002\u8BF7\u5148\u542F\u52A8\u72EC\u7ACB\u6865\uFF1Anode ~/workspace/pi-work/packages/aiti-bridge/bin/aiti-bridge.mjs\uFF08\u9ED8\u8BA4 127.0.0.1:8777\uFF09\uFF0C\u7136\u540E\u91CD\u542F opencode\u3002";
    hooks.tool = {
      [PREFIX + "bridge_status"]: tool({
        description: "\u67E5\u8BE2 aiti-devtools \u5DF2\u8FDE\u63A5\u9875\u9762\uFF08sessions/pageId/url/title\uFF09\u3002\u5F53\u524D\u6865\u672A\u542F\u52A8\u3002" + DESCRIPTION_SUFFIX,
        args: {},
        async execute() {
          return errText;
        }
      }),
      [PREFIX + "page_exec"]: tool({
        description: "\u5728\u5DF2\u8FDE\u63A5\u9875\u9762\u6267\u884C\u7C7B CDP \u547D\u4EE4\u3002\u5F53\u524D\u6865\u672A\u542F\u52A8\u3002" + DESCRIPTION_SUFFIX,
        args: { cmd: z.string().describe("CDP \u547D\u4EE4\uFF0C\u5982 Runtime.evaluate"), args: z.record(z.string(), z.any()).optional() },
        async execute() {
          return errText;
        }
      })
    };
    return hooks;
  }
  for (const t of bridgeTools) {
    hooks.tool[PREFIX + t.name] = tool({
      description: (t.description || t.name) + DESCRIPTION_SUFFIX,
      args: schemaToShape(t.inputSchema || { type: "object", properties: {} }),
      async execute(args, ctx) {
        const sess = await registerAndStream(ctx.sessionID, ctx.directory);
        if (!sess) return "\u6865\u6CE8\u518C\u5931\u8D25\uFF1A" + BRIDGE_BASE + "\uFF08\u6865\u53EF\u80FD\u521A\u91CD\u542F\uFF0C\u91CD\u8BD5\u5373\u53EF\uFF09";
        const r = await bridge.callTool(
          t.name,
          args || {},
          { agentId: AGENT_ID, sessionId: ctx.sessionID, cwd: ctx.directory, cancelId: ctx.callID },
          ctx.abort
        );
        const wrapped = wrapToolResult(r);
        return wrapped.content[0]?.text ?? JSON.stringify(wrapped);
      }
    });
  }
  log("registered " + bridgeTools.length + " aiti_* tools from " + BRIDGE_BASE);
  hooks.event = async ({ event }) => {
    if (event.type === "session.idle") {
      const sessionID = event.properties?.sessionID;
      const sess = sessionID ? sessions.get(sessionID) : null;
      if (!sess) return;
      try {
        const res = await client.session.messages({ path: { id: sessionID } });
        const msgs = res.data ?? [];
        const last = [...msgs].reverse().find((m) => m.info.role === "assistant");
        const text = (last?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();
        if (text) await bridge.answer(sess.agentKey, text);
      } catch {
      }
    }
  };
  hooks["chat.message"] = async (input2) => {
    const sessionID = input2.sessionID;
    if (sessionID && !sessions.has(sessionID)) {
      void registerAndStream(sessionID, input2.directory || ctxDirectory).catch(() => {
      });
    }
  };
  const PLACEHOLDER_EXISTS = /\[(?:元素|回答|错误|选择)\d+\]/;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function fetchPicked() {
    try {
      const res = await fetch(BRIDGE_BASE + "/bridge/picked", { signal: AbortSignal.timeout(4e3) });
      if (!res.ok) return [];
      const b = await res.json().catch(() => null);
      return Array.isArray(b?.candidates) ? b.candidates : [];
    } catch {
      return [];
    }
  }
  hooks["experimental.chat.messages.transform"] = async (_input, output) => {
    const msgs = output.messages || [];
    if (!msgs.length) return;
    const hasTag = msgs.some((m) => m?.info?.role === "user" && (m.parts || []).some((p) => p?.type === "text" && PLACEHOLDER_EXISTS.test(String(p.text || ""))));
    if (!hasTag) return;
    let picked = [];
    for (let i = 0; i < 9; i++) {
      picked = await fetchPicked();
      if (picked.length) break;
      await sleep(100);
    }
    const pid = picked.find((c) => c.pageId)?.pageId || null;
    let pageUrl = null;
    if (pid) {
      try {
        const res = await fetch(BRIDGE_BASE + "/bridge/sessions", { signal: AbortSignal.timeout(4e3) });
        if (res.ok) {
          const rows = await res.json().catch(() => []);
          pageUrl = (Array.isArray(rows) ? rows : []).find((r) => r?.pageId === pid)?.url || null;
        }
      } catch {
      }
    }
    const cands = picked.map((c) => ({ tag: c.tag, describe: c.describe, pageId: c.pageId }));
    const rwOpts = { pid, pageUrl };
    const usedTagsAll = [];
    let lastUser = null;
    for (const m of msgs) {
      if (m && m.info?.role === "user" && Array.isArray(m.parts)) lastUser = m;
    }
    if (!lastUser) return;
    for (const p of lastUser.parts) {
      if (!p || p.type !== "text" || typeof p.text !== "string" || !p.text) continue;
      if (!PLACEHOLDER_EXISTS.test(p.text)) continue;
      const r = rewriteMessage(p.text, cands, rwOpts);
      if (r.text === p.text) continue;
      p.text = r.text;
      if (r.usedAny) usedTagsAll.push(...r.usedTags);
    }
    const used = [...new Set(usedTagsAll)];
    if (used.length) {
      log("placeholder consumed: " + used.join(","));
      void fetch(BRIDGE_BASE + "/bridge/ai/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(4e3),
        body: JSON.stringify({ event: "aiti_consumed", payload: { tags: used, pid, at: Date.now() } })
      }).catch(() => {
      });
    }
  };
  return hooks;
};
var index_default = AitiDevtoolsPlugin;
export {
  AitiDevtoolsPlugin,
  index_default as default
};
