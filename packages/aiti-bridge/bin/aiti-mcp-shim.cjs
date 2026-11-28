#!/usr/bin/env node
/**
 * aiti-mcp-shim — 通用 stdio ⇄ HTTP(streamable) MCP 转发器（零依赖，CJS）
 *
 * 目标：任何支持挂 stdio MCP 的 agent（zcode/pi/claude/cursor/vscode/zed…）注册**同一个**
 * 固定条目（名字 `aiti`，command node + 本文件路径），URL 永不写进配置——启动 agent 的
 * shell 里带 `AITI_BRIDGE_URL` 环境变量，shim 进程继承后自行协商出 MCP 端点。
 * dev / prod / 独立桥共享同一份配置条目，只差环境变量。
 *
 * 端点协商（AITI_BRIDGE_URL 智能归一，多写少写路径都兼容）：
 *   - 显式 pi-web 扩展路径（含 /api/extensions/aiti-devtools）→ 截到 aiti-devtools 补 /mcp/mcp
 *   - 其余：剥尾部 /mcp /mcp/mcp /bridge /aiti（整段精确匹配，不吃 aiti-devtools）得 base，候选取
 *     base+/aiti/mcp（独立桥/nginx）→ base+/api/extensions/aiti-devtools/mcp/mcp（pi-web 带 basePath）
 *   - base 是裸 origin 时追加已知 basePath 变体（/dev /win /mac /wdev /mdev）再试 pi-web 端点
 *   - 逐候选 POST initialize 探测（1.5s 超时，404/HTML 快速失败），首个 JSON-RPC 响应胜出
 *   - `--url <端点>` 参数直接指定（跳过协商，最高优先）
 *
 * 未设环境变量 / 全部候选不可达：不挂死——initialize 正常应答，tools/list 只给
 * `aiti_shim_status` 自检工具（说明原因），其余调用返回明确错误。
 *
 * 注册（幂等，版本守卫）：node ../bin/aiti-mcp-register.mjs  —— 版本走条目 env map（AITI_SHIM_VERSION，
 * 零顶层私有键——zcode/opencode 严格 schema 拒收未知顶层键），已注册版本 >= 本文件 SHIM_VERSION 且路径未变时不改写配置。升级 shim 改下面的 SHIM_VERSION。
 */
"use strict";

const SHIM_VERSION = 1;
const ENV_VAR = "AITI_BRIDGE_URL";
// 探测超时可按机器负载调整（默认 1.5s；重负载机器可设 AITI_PROBE_TIMEOUT_MS 放宽）
const PROBE_TIMEOUT_MS = Math.max(500, parseInt(process.env.AITI_PROBE_TIMEOUT_MS || "1500", 10) || 1500);
/** 裸 origin 时追加尝试的 pi-web basePath 变体（48/155/23 三台机器的实例布局） */
const KNOWN_BASE_PATHS = ["/dev", "/win", "/mac", "/wdev", "/mdev"];
const EXT_PATH_SIG = "/api/extensions/aiti-devtools";

const log = (...a) => process.stderr.write("[aiti-shim] " + a.join(" ") + "\n");

// ---------------- 端点协商（纯函数，可单测） ----------------

/** 剥尾部已知段：/mcp/mcp /mcp /bridge /aiti（整段精确；不剥 aiti-devtools 里的 aiti） */
function stripKnownSuffix(path) {
  let p = path.replace(/\/+$/, "");
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of ["/mcp/mcp", "/mcp", "/bridge", "/aiti"]) {
      if (p.endsWith(suf)) {
        p = p.slice(0, -suf.length);
        changed = true;
        break;
      }
    }
  }
  return p;
}

/**
 * 归一用户输入 → { raw, base, origin, extBase, notes }
 *   extBase：URL 含 pi-web 扩展路径时，截到 .../aiti-devtools 的前缀（显式端点线索）
 */
function normalizeInput(rawUrl) {
  const notes = [];
  const raw = String(rawUrl || "").trim().replace(/\/+$/, "");
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { raw, base: raw, origin: raw, extBase: null, notes: ["地址无法解析为 URL，按原样尝试"] };
  }
  const idx = u.pathname.indexOf(EXT_PATH_SIG);
  let extBase = null;
  if (idx >= 0) {
    extBase = u.origin + u.pathname.slice(0, idx + EXT_PATH_SIG.length);
    notes.push("识别出 pi-web 扩展路径 → " + extBase + "/mcp/mcp");
  }
  const base = u.origin + stripKnownSuffix(u.pathname);
  return { raw, base, origin: u.origin, extBase, notes };
}

/** 候选端点列表（探测顺序即数组顺序） */
function buildCandidates(norm) {
  const out = [];
  if (norm.extBase) out.push(norm.extBase + "/mcp/mcp"); // 显式扩展路径优先
  out.push(norm.base + "/aiti/mcp"); // 独立桥 / nginx /aiti/
  if (norm.extBase) {
    out.push(norm.extBase + "/mcp"); // 少写一个 /mcp 的兜底（显式路径下 base 不可靠）
  } else if (!norm.base.includes(EXT_PATH_SIG)) {
    out.push(norm.base + EXT_PATH_SIG + "/mcp/mcp"); // pi-web（base 已含 basePath）
    const bare = norm.base === norm.origin;
    if (bare) {
      for (const bp of KNOWN_BASE_PATHS) out.push(norm.origin + bp + EXT_PATH_SIG + "/mcp/mcp");
    }
  }
  return [...new Set(out)];
}

// ---------------- HTTP 侧 ----------------

let endpoint = null; // 协商成功的 MCP 端点
let sessionId = null; // 桥返回的 mcp-session-id（有则回带）
let resolveNotes = []; // 协商过程记录（status 工具 / 日志展示）
let resolvePromise = null; // 首次请求前保证已协商（含失败）

async function probe(url) {
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 0, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "aiti-shim-probe", version: String(SHIM_VERSION) } },
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST", signal: ctrl.signal, body,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    });
    const ct = res.headers.get("content-type") || "";
    const text = await res.text();
    const json = parseFirstJson(ct, text);
    return !!json && (json.jsonrpc === "2.0" || json.result !== undefined || json.error !== undefined);
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** 从响应体解析首个 JSON-RPC 消息（json 直读 / SSE 取首个 data 事件） */
function parseFirstJson(contentType, text) {
  try {
    if (contentType.includes("text/event-stream")) return parseSseMessages(text)[0] || null;
    if (!text.trim()) return null;
    const v = JSON.parse(text);
    return Array.isArray(v) ? v[0] : v;
  } catch {
    return null;
  }
}

/** 解析 SSE 文本为消息数组（data: 行累积到空行成事件；MCP 每事件单行 JSON） */
function parseSseMessages(text) {
  const out = [];
  let buf = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line === "") {
      if (buf.length) {
        try { out.push(JSON.parse(buf.join("\n"))); } catch {}
        buf = [];
      }
      continue;
    }
    if (line.startsWith("data:")) buf.push(line.slice(5).replace(/^ /, ""));
  }
  if (buf.length) { try { out.push(JSON.parse(buf.join("\n"))); } catch {} }
  return out;
}

/** 合法 JSON-RPC 消息：响应必有 id，通知必有 method（method+id 皆无 = 协议破损，丢弃不透传） */
function isValidRpc(m) {
  return !!m && m.jsonrpc === "2.0" && (m.id !== undefined || typeof m.method === "string");
}

/** 解析 --url 参数（命令行 > 环境变量） */
function readCliUrl() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1]) return argv[i + 1];
    const m = argv[i] && argv[i].match && argv[i].match(/^--url=(.+)$/);
    if (m) return m[1];
  }
  return null;
}

/** 协商端点（一次进程一次；结果缓存于 endpoint/resolveNotes） */
async function resolveEndpoint() {
  const cliUrl = readCliUrl();
  const envUrl = process.env[ENV_VAR];
  const src = cliUrl || envUrl;
  if (!src) {
    resolveNotes = ["未设置 " + ENV_VAR + " 环境变量（也没有 --url 参数）——只提供 aiti_shim_status 自检工具"];
    return null;
  }
  log("来源：" + (cliUrl ? "--url 参数" : "env " + ENV_VAR) + " = " + src);
  const norm = normalizeInput(src);
  resolveNotes = [...norm.notes];
  const cands = buildCandidates(norm);
  log("协商候选：" + cands.join("  |  "));
  for (const c of cands) {
    const ok = await probe(c);
    if (ok) {
      endpoint = c;
      resolveNotes.push("探测命中：" + c);
      log("端点（探测命中）：" + c);
      return endpoint;
    }
    resolveNotes.push("探测未命中：" + c);
  }
  if (cliUrl) {
    // --url 显式指定且全部探测未命中：仍信任首候选（尊重用户显式意图，如带鉴权/非标准端点）
    endpoint = cands[0];
    resolveNotes.push("全部探测未命中，按 --url 显式指定信任首候选：" + endpoint);
    log("端点（显式兜底）：" + endpoint);
    return endpoint;
  }
  log("全部候选不可达（" + cands.length + " 个）——降级为仅自检模式");
  return null;
}

function ensureResolved() {
  if (!resolvePromise) {
    resolvePromise = resolveEndpoint().catch((e) => {
      resolveNotes.push("协商异常：" + (e && e.message));
      return null;
    });
  }
  return resolvePromise;
}

/** 转发一条 JSON-RPC 消息到桥；返回应写回 stdout 的消息数组（通知/空响应 → []）；depth=会话重握手次数护栏 */
async function forward(msg, depth = 0) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  let res;
  try {
    res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(msg) });
  } catch (e) {
    // 网络失败：端点可能后来才起——重置协商，下次请求重新探测
    resolvePromise = null;
    endpoint = null;
    if (msg.id !== undefined) {
      return [{ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "aiti shim 转发失败（端点不可达）：" + (e && e.message) + "；已重置协商，下次调用将重新探测" } }];
    }
    return [];
  }
  if ((res.status === 404 || res.status === 400) && sessionId && depth === 0) {
    // 严格服务端（符合 MCP 规范）对失效会话回 404/400（典型：桥/网关重启）——
    // 丢弃旧会话 → 重新协商端点 → 重做 initialize 握手取新会话 → 原消息重试一次
    log("HTTP " + res.status + "（会话可能已失效）——丢弃 mcp-session-id，重新握手后重试");
    sessionId = null;
    resolvePromise = null;
    endpoint = null;
    await ensureResolved();
    if (endpoint) {
      await forward({ jsonrpc: "2.0", id: "__aiti_reshake", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "aiti-shim", version: String(SHIM_VERSION) } } }, 1); // 应答仅用于取新 sid，不透传
      await forward({ jsonrpc: "2.0", method: "notifications/initialized" }, 1);
      return forward(msg, 1);
    }
  }
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  const ct = res.headers.get("content-type") || "";
  const text = await res.text().catch(() => "");
  if (ct.includes("text/event-stream")) return parseSseMessages(text).filter(isValidRpc);
  if (!text.trim()) return []; // 202 Accepted（通知）
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    if (msg.id !== undefined) return [{ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "aiti shim 收到非 JSON 响应（" + ct + "）" } }];
    return [];
  }
  return Array.isArray(v) ? v.filter(isValidRpc) : (isValidRpc(v) ? [v] : []);
}

// ---------------- 本地自检工具（无论是否连上都可用） ----------------

const STATUS_TOOL = {
  name: "aiti_shim_status",
  description: "aiti MCP shim 自检：端点协商结果 / " + ENV_VAR + " 环境变量 / shim 版本。桥连不上时先看这里。",
  inputSchema: { type: "object", properties: {} },
};

function statusText() {
  const lines = [
    "aiti-mcp-shim v" + SHIM_VERSION,
    "env " + ENV_VAR + " = " + (process.env[ENV_VAR] || "（未设置）"),
    "--url 参数 = " + (readCliUrl() || "（无）"),
    "协商端点 = " + (endpoint || "（未解析）"),
    "",
    "协商过程：",
    ...(resolveNotes.length ? resolveNotes.map((n) => "  - " + n) : ["  - （尚未协商）"]),
    "",
    endpoint
      ? "桥已连接：aiti_* 工具由桥提供。"
      : "桥未连接。启动 agent 前请在 shell 设置 " + ENV_VAR + "，例如：",
    ...(endpoint ? [] : [
      "  AITI_BRIDGE_URL=http://127.0.0.1:8777            # 独立桥",
      "  AITI_BRIDGE_URL=http://127.0.0.1:3001/dev       # pi-web dev（basePath 可带可不带）",
      "  AITI_BRIDGE_URL=http://127.0.0.1:3002           # pi-web prod",
      "写完整 MCP 端点（…/mcp/mcp）也可以，shim 会识别。",
    ]),
  ];
  return lines.join("\n");
}

// ---------------- stdio 主循环 ----------------

const writeMsg = (m) => process.stdout.write(JSON.stringify(m) + "\n");

/** 本地应答（未连桥时的降级协议实现） */
function localRespond(msg) {
  if (msg.method === "initialize") {
    writeMsg({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "aiti-shim", version: String(SHIM_VERSION) + (endpoint ? "" : "-unresolved") },
        instructions: "aiti MCP shim：桥未连接，仅提供 aiti_shim_status 自检。请设置 " + ENV_VAR + " 后重启 agent。",
      },
    });
    return true;
  }
  if (msg.method === "tools/list") {
    writeMsg({ jsonrpc: "2.0", id: msg.id, result: { tools: [STATUS_TOOL] } });
    return true;
  }
  if (msg.method === "tools/call" && msg.params && msg.params.name === STATUS_TOOL.name) {
    writeMsg({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: statusText() }] } });
    return true;
  }
  if (msg.id !== undefined) {
    writeMsg({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "aiti shim 未连接桥（" + (resolveNotes[0] || "未知原因") + "）。详见 aiti_shim_status。" } });
    return true;
  }
  return false; // 通知：静默
}

async function handleMessage(msg) {
  await ensureResolved();
  // 自检工具永远本地应答（连上桥也如此——能看到协商细节）
  if (msg.method === "tools/call" && msg.params && msg.params.name === STATUS_TOOL.name && msg.id !== undefined) {
    writeMsg({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: statusText() }] } });
    return;
  }
  if (!endpoint) {
    localRespond(msg);
    return;
  }
  const replies = await forward(msg);
  for (const r of replies) {
    // tools/list 应答：合并自检工具（保持 agent 永远能看到 aiti_shim_status）
    if (msg.method === "tools/list" && r && r.result && Array.isArray(r.result.tools)) {
      if (!r.result.tools.some((t) => t && t.name === STATUS_TOOL.name)) r.result.tools.push(STATUS_TOOL);
    }
    writeMsg(r);
  }
}

function main() {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log("忽略非 JSON 行：" + line.slice(0, 120));
        continue;
      }
      handleMessage(msg).catch((e) => {
        if (msg && msg.id !== undefined) {
          writeMsg({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "aiti shim 内部错误：" + (e && e.message) } });
        }
        log("handleMessage 异常：" + (e && e.stack || e));
      });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (require.main === module) {
  main();
} else {
  // 被 require（单测）：导出纯函数
  module.exports = { SHIM_VERSION, ENV_VAR, stripKnownSuffix, normalizeInput, buildCandidates, parseSseMessages, parseFirstJson };
}
