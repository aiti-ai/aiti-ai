/**
 * aiti-devtools-pi · pi 扩展（agent 端连接器，无状态）
 *
 * 桥独立常驻（bin/aiti-bridge.mjs，默认 http://127.0.0.1:8777）；本扩展做三件事：
 *   0. 激活门禁：桥连通性预检（GET /bridge/sessions）——桥没连上则暂不注册 aiti_* 工具（模型看不到，
 *      避免一调用就报「桥不可达」），但会话事件照挂：session_start 无条件尝试连 agent SSE（自带指数
 *      退避重试），桥恢复即自动补注册工具 + 建 P3 推送，无需 /reload；桥没联通时 agent 完成不把回答发回桥。
 *   1. registerTool 注册桥的 TOOLS（page_exec/user_x/aiti_x 等）——execute 经桥的 agent REST
 *      （POST /bridge/agent/tools/call）直连执行，不走 MCP 协议、无配置、无会话协商。
 *   2. session_start 自动注册本会话（agentId=pi + sessionId=pi 会话 id + name + subEvents）——消息定向到本会话。
 *   3. P3 推送：agent SSE 持久流（/bridge/agent/sse）→ 页面事件/人发消息/异步作答 → sendUserMessage
 *      注入 agent 会话（模型立即看到并行动，MCP 做不到）。
 *
 * 桥地址：AITI_BRIDGE_URL 环境变量 → settings.json 的 settings.aitiDevtools.bridgeUrl → 默认 127.0.0.1:8777。
 * 桥常驻的优势：页面连接不随 pi 生命周期；多 pi 实例各自连同一桥（agentKey=agentId/sessionId 区分）；
 * pi 重启后扩展重连桥，工具无状态即恢复。
 */
import { join, resolve, dirname } from "node:path";
import { readFileSync, existsSync, writeFileSync, openSync, appendFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createBridge, autoRegisterAitiShim } from "../../aiti-devtools-core/src/index.ts";
import { AgentBridgeClient, wrapToolResult } from "../../aiti-devtools-agent/src/index.ts";
import { jsonSchemaToTypeBox } from "../../aiti-devtools-agent/src/schema.ts";
import { normalizeBridgeBase, PI_WEB_EXT_PATH_SIG } from "./bridge-url.ts";

function logFile(msg: string) {
  try {
    // 日志目录跟随 pi agent 根（getAgentDir 内部读 PI_CODING_AGENT_DIR；未设 = ~/.pi/agent 原行为）
    const logDir = join(getAgentDir(), "logs");
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, "aiti-devtools-pi.log"), `[aiti-devtools-pi] ${new Date().toISOString().slice(11,19)} ${msg}\n`);
  } catch {}
}

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8777/aiti"; // 仅作最后兜底；桥端口不是固定值——由 env/配置注入（见 resolveBridgeUrl）

// 桥地址解析（端口可配置，非固定）：
//   AITI_BRIDGE_URL（完整，含路径，权威优先）→ AITI_BRIDGE_PORT/AITI_BRIDGE_HOST（env 单独注入，仅在无完整 URL 时生效）
//   → settings.aitiDevtools.bridgeUrl（bootstrap 引导时写入）→ DEFAULT_BRIDGE_URL 兜底。
// 所有出口统一走 normalizeBridgeBase（pi-web 扩展路径签名 → 补 /mcp；见 bridge-url.ts）。
// 冲突约定：AITI_BRIDGE_URL 与 AITI_BRIDGE_PORT 同时设置且端口不一致 → 以 URL 为准并打警告（不静默忽略）。
function resolveBridgeUrl(): string {
  if (process.env.AITI_BRIDGE_URL) {
    const url = process.env.AITI_BRIDGE_URL.replace(/\/+$/, "");
    if (process.env.AITI_BRIDGE_PORT) { // 冲突检测：两个变量端口不一致 → 提示以 URL 为准
      try {
        const uPort = new URL(url).port || (url.startsWith("https:") ? "443" : "80");
        if (uPort !== process.env.AITI_BRIDGE_PORT) {
          logFile("[aiti-devtools-pi] AITI_BRIDGE_URL（端口 " + uPort + "）与 AITI_BRIDGE_PORT=" + process.env.AITI_BRIDGE_PORT + " 不一致 → 以 URL 为准（PORT 被忽略）");
        }
      } catch {}
    }
    return normalizeBridgeBase(url);
  }
  const port = process.env.AITI_BRIDGE_PORT;
  if (port) {
    const host = process.env.AITI_BRIDGE_HOST || "127.0.0.1";
    return normalizeBridgeBase("http://" + host + ":" + port + "/aiti");
  }
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (existsSync(settingsPath)) {
      const cfg = JSON.parse(readFileSync(settingsPath, "utf8"));
      const u = cfg?.settings?.aitiDevtools?.bridgeUrl;
      if (typeof u === "string" && u) return normalizeBridgeBase(u.replace(/\/+$/, ""));
    }
  } catch {}
  return DEFAULT_BRIDGE_URL;
}

// ==================== 桥引导（bootstrap：确保配置 + 检查端口 + 自动拉起独立桥） ====================
// 独立 pi（非 pi-web 场景）启动本扩展时：
//   1. 确保 settings.json 里有 settings.aitiDevtools.bridgeUrl（本扩展自身读桥地址用）；
//   2. 确保 ~/.config/mcp/mcp.json 里有 aiti-devtools MCP server（type:http → <base>/aiti/mcp，供标准 MCP client 连）；
//   3. 检查桥端口是否正常（probeBridge）；不正常 → 按该端口 spawn 一个独立桥进程（detached 常驻）并等待就绪。
// 覆盖口：AITI_PI_EXT_NO_BOOTSTRAP=1 跳过自动拉起（仅写配置）；pi-web 场景在上方守卫直接 return，不会走到这里。

// 定位可运行的桥脚本（仓库内 packages/aiti-bridge/bin/aiti-bridge.mjs；bundle 部署时从源码/产物目录上推）
function bridgeScriptPath(): string | null {
  if (process.env.AITI_BRIDGE_SCRIPT && existsSync(process.env.AITI_BRIDGE_SCRIPT)) return process.env.AITI_BRIDGE_SCRIPT;
  const here = dirname(fileURLToPath(import.meta.url)); // 运行时文件目录（dist/ 或源码目录）
  const candidates = [
    resolve(here, "../../aiti-bridge/bin/aiti-bridge.mjs"), // 源码/产物目录 → packages/aiti-bridge/bin
    resolve(homedir(), "workspace/aiti-ai/packages/aiti-bridge/bin/aiti-bridge.mjs"), // 开发环境绝对兜底
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

// 确保 settings.json 里有 settings.aitiDevtools.bridgeUrl（幂等：已一致不写）
// 安全：原文件无法解析（损坏/非 JSON）→ 不写，绝不覆盖用户配置
function ensureBridgeSetting(url: string): boolean {
  try {
    const p = join(getAgentDir(), "settings.json");
    let cfg: any = null;
    if (existsSync(p)) {
      try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { return false; }
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
    const cur = cfg?.settings?.aitiDevtools?.bridgeUrl;
    if (typeof cur === "string" && cur.replace(/\/+$/, "") === url) return false;
    cfg = { ...cfg, settings: { ...(cfg.settings || {}), aitiDevtools: { ...(cfg.settings?.aitiDevtools || {}), bridgeUrl: url } } };
    writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    return true;
  } catch (e) { return false; }
}

// 确保 ~/.config/mcp/mcp.json 里有 aiti-devtools MCP server（type:http → <origin>/aiti/mcp），幂等
// 安全：原文件无法解析 → 不写；只改 mcpServers 字段，保留其它字段（$schema 等）与其他 server
function ensureMcpConfig(url: string): boolean {
  try {
    const p = join(homedir(), ".config", "mcp", "mcp.json");
    let cfg: any = null;
    if (existsSync(p)) {
      try { cfg = JSON.parse(readFileSync(p, "utf8")); } catch { return false; }
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
    if (!cfg.mcpServers) cfg.mcpServers = {};
    const uu = new URL(url);
    const sigIdx = uu.pathname.indexOf(PI_WEB_EXT_PATH_SIG);
    // pi-web 托管桥（扩展路径签名）→ MCP 端点在 <extBase>/mcp/mcp；独立桥/裸地址 → <origin>/aiti/mcp
    const target = sigIdx >= 0
      ? uu.origin + uu.pathname.slice(0, sigIdx + PI_WEB_EXT_PATH_SIG.length) + "/mcp/mcp"
      : uu.origin + "/aiti/mcp";
    const cur = cfg.mcpServers?.["aiti-devtools"];
    if (cur && cur.type === "http" && cur.url === target) return false;
    cfg.mcpServers = { ...(cfg.mcpServers || {}), "aiti-devtools": { type: "http", url: target } };
    writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    return true;
  } catch (e) { return false; }
}

// 按目标端口拉起独立桥（detached 常驻，日志到 agent 目录 aiti-bridge.log）
function spawnBridge(script: string, host: string, port: number): boolean {
  try {
    const log = openSync(join(getAgentDir(), "aiti-bridge.log"), "a");
    const child = spawn(process.execPath, [script, "--host", host, "--port", String(port)], {
      detached: true, stdio: ["ignore", log, log],
      env: { ...process.env, AITI_BRIDGE_HOST: host, AITI_BRIDGE_PORT: String(port) },
    });
    child.unref();
    return true;
  } catch (e) { return false; }
}

// 引导主流程：确保配置 → 检查端口 → 不可连则按该端口拉起桥并等待就绪
async function bootstrapBridge(base: string): Promise<boolean> {
  ensureBridgeSetting(base);
  ensureMcpConfig(base);
  if (await probeBridge(base, 1500)) return true; // 端口正常，桥已在跑
  if (process.env.AITI_PI_EXT_NO_BOOTSTRAP) {
    logFile("[aiti-devtools-pi] 桥不可达且已跳过自动拉起（AITI_PI_EXT_NO_BOOTSTRAP=1）");
    return false;
  }
  const script = bridgeScriptPath();
  if (!script) {
    logFile("[aiti-devtools-pi] 桥不可达且找不到桥脚本，无法自动拉起（" + base + "）——可设 AITI_BRIDGE_SCRIPT 指定");
    return false;
  }
  const u = new URL(base);
  if (!u.port) {
    // 托管桥（URL 无端口，如 pi-web 的 /api/extensions/aiti-devtools/mcp）：
    // 不在本地乱拉独立桥——宿主不可达时保持重试，等宿主恢复
    logFile("[aiti-devtools-pi] 托管桥（URL 无端口）不可达 → 不自动拉起，等待宿主恢复：" + base);
    return false;
  }
  const port = parseInt(u.port || "8777", 10) || 8777;
  const host = u.hostname || "127.0.0.1";
  logFile("[aiti-devtools-pi] 桥不可达 → 按端口 " + port + " 拉起独立桥：" + script);
  spawnBridge(script, host, port);
  for (let i = 0; i < 15; i++) { // 等待就绪（最多 ~3s）
    await new Promise((r) => setTimeout(r, 200));
    if (await probeBridge(base, 500)) { logFile("[aiti-devtools-pi] 桥已拉起并就绪（" + base + "）"); return true; }
  }
  logFile("[aiti-devtools-pi] 桥拉起超时（" + base + "）——查看日志 " + join(getAgentDir(), "aiti-bridge.log"));
  return false;
}

const agentId = () => process.env.AITI_AGENT_ID || "pi";
// agent 显示名（CWD . name (id) 的 name）：env AITI_AGENT_NAME → settings aitiDevtools.agentName → "pi"
function agentDisplayName(): string {
  if (process.env.AITI_AGENT_NAME) return process.env.AITI_AGENT_NAME;
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (existsSync(settingsPath)) {
      const cfg = JSON.parse(readFileSync(settingsPath, "utf8"));
      const n = cfg?.settings?.aitiDevtools?.agentName;
      if (typeof n === "string" && n) return n;
    }
  } catch {}
  return "pi";
}

// 桥的工具定义（createBridge 无副作用，仅取 TOOLS 清单；HTTP 由独立桥进程提供）
const bridge = createBridge(join(getAgentDir(), "aiti-bridge"));

// 桥 HTTP 客户端（agent 层，宿主无关）：probe/register/callTool/answer 复用 —— URL 变化时重建
let _bridgeClient: AgentBridgeClient | null = null;
function getBridgeClient(base: string): AgentBridgeClient {
  if (!_bridgeClient || _bridgeClient.base !== base) _bridgeClient = new AgentBridgeClient(base);
  return _bridgeClient;
}

// 当前 pi 会话标识（session_start 时从 ctx.sessionManager 取；execute 带它 → 消息定向到本会话）
let currentSessionId: string | null = null;
let currentAgentKey: string | null = null;
let currentCwd = ""; // 会话工作目录（注册/工具调用携带 → 桥显示 CWD . name (id)）
let streamCtrl: AbortController | null = null;
// 未注册前（session_start 尚未执行）的工具调用：用稳定 fallback session（按 pid），避免桥为每次调用生成随机 session（历史 agent 垃圾）
const FALLBACK_SESSION = "s_p" + process.pid.toString(36);

// 桥连通性状态：探测/register 成功置 true、失败置 false——驱动「桥没联通时不注册工具 / 不发总结回桥」
let bridgeUp = false;
let toolsRegistered = false; // aiti_* 工具是否已注册（幂等；桥恢复后 connectAgentStream 补注册）

async function callBridgeTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal, cancelId?: string) {
  // ① 合二为一优先路：/web 激活的 socket 转发（不经 HTTP/鉴权/端口连通，
  //    与本次 attach 的 pi-web 进程内桥同实例；帧协议见 aiti-attach-agent/index.ts）。
  //    /web 未激活或无已附着的 pi-web 客户端 → 回退 ② 直连桥 REST。
  const relay = (globalThis as { __aitiTuiRelay?: { active(): boolean; call(tool: string, args: Record<string, unknown>, cancelId?: string, signal?: AbortSignal): Promise<unknown> } | null }).__aitiTuiRelay;
  if (relay && relay.active()) {
    try {
      logFile("[aiti-devtools-pi] transport=socket →", tool);
      const r = await relay.call(tool, args || {}, cancelId, signal);
      return r;
    } catch (e) {
      logFile("[aiti-devtools-pi] socket 转发失败 → 回退直连桥：", e instanceof Error ? e.message : e);
    }
  } else {
    logFile("[aiti-devtools-pi] transport=http(relay未激活) →", tool);
  }
  return getBridgeClient(resolveBridgeUrl()).callTool(
    tool, args || {},
    { agentId: agentId(), sessionId: currentSessionId || FALLBACK_SESSION, cwd: currentCwd || undefined, cancelId },
    signal,
  );
}

/** agent 启动时注册自己（带 agentId/sessionId/name/cwd/subEvents）——bridge 里消息按 agentKey=agentId/sessionId 定向 */
async function registerAgent(base: string, sessionId: string, name: string, cwd: string) {
  return getBridgeClient(base).register({ agentId: agentId(), sessionId, name, cwd: cwd || undefined, source: "extension", subEvents: ["page_error"] });
}

/** 桥连通性预检（GET /bridge/sessions；超时参数化：加载预检 2.5s / 会话内 800ms；本地拒绝连接即时返回） */
async function probeBridge(base: string, timeoutMs = 2500): Promise<boolean> {
  const ok = await getBridgeClient(base).probe(timeoutMs);
  bridgeUp = ok;
  return ok;
}

// ---- P3：agent SSE 持久流（桥 → 扩展 → sendUserMessage 注入会话）----
// Node 无全局 EventSource → fetch + ReadableStream 手动解析 SSE（零依赖；断线指数退避重连）
// 每次重连前重新 register（幂等）：桥重启后 agents 表从 JSONL 恢复会丢 registered/subEvents
// 空闲 watchdog：STREAM_IDLE_MS 内无任何数据 → 视为断线（TCP 半开/桥进程残留死连接的兜底）→ abort 触发重连，避免 read() 永久挂起
const STREAM_IDLE_MS = 60000;
async function connectAgentStream(pi: ExtensionAPI, base: string, sessionId: string, name: string, cwd: string, onMessage: (m: any) => void) {
  if (streamCtrl) { try { streamCtrl.abort(); } catch {} }
  let retry = 2000;
  let respawned = false; // 会话内桥失联 → 只自动重拉一次（启动 bootstrap 已拉过；此处兜底桥中途崩溃）
  const run = async () => {
    // 每次尝试新建 controller：空闲超时 abort 后允许下次重连（abort 状态不残留）
    const ctrl = new AbortController();
    streamCtrl = ctrl;
    const reg = await registerAgent(base, sessionId, name, cwd).catch(() => null);
    if (!reg || !reg.agentKey) {
      bridgeUp = false; // register 失败 = 桥不可达 → 不发总结
      // 自愈：桥会话中崩溃/失联 → 尝试按解析端口重新拉起一次（与 bootstrap 同款；失败静默，继续指数退避重连）
      if (!respawned && !process.env.AITI_PI_EXT_NO_BOOTSTRAP) {
        const script = bridgeScriptPath();
        const u = (() => { try { return new URL(base); } catch { return null; } })();
        // 仅自托管（URL 带端口）才重拉；托管桥（无端口）等宿主恢复
        if (script && u?.port) {
          try {
            respawned = true;
            spawnBridge(script, u.hostname || "127.0.0.1", parseInt(u.port, 10) || 8777);
            logFile("[aiti-devtools-pi] 桥会话内失联 → 尝试重新拉起：" + script + "（" + base + "）");
          } catch (e) {}
        }
      }
      if (streamCtrl === ctrl && !ctrl.signal.aborted) { setTimeout(() => { if (streamCtrl === ctrl && !ctrl.signal.aborted) run(); }, retry); retry = Math.min(30000, retry * 2); } return;
    }
    bridgeUp = true; // 桥可达 → 之后 agent 完成可以把回答发回桥
    currentAgentKey = reg.agentKey;
    registerBridgeTools(pi); // 桥恢复 → 补注册 aiti_* 工具（幂等；加载时已注册则跳过）
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const poke = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { try { ctrl.abort(); } catch {} }, STREAM_IDLE_MS); // 空闲超时 → 断开 → 走重连分支
    };
    try {
      const resp = await fetch(base + "/bridge/agent/sse?agentKey=" + encodeURIComponent(reg.agentKey), {
        signal: ctrl.signal,
        headers: { Accept: "text/event-stream" },
      });
      if (!resp.ok || !resp.body) throw new Error("SSE HTTP " + resp.status);
      retry = 2000;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      poke(); // 连上即开始计空闲
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        poke(); // 有数据 → 重置空闲计时
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (line) { try { onMessage(JSON.parse(line.slice(5).trim())); } catch {} }
        }
      }
    } catch (e) {
      // 仅 session_shutdown 主动断开（streamCtrl 被置空/替换）不重连；其余（断线/空闲超时）一律重连
      if (streamCtrl !== ctrl) return;
    }
    if (idleTimer) clearTimeout(idleTimer);
    // 断线重连（桥重启、TCP 半开空闲超时等）——注意：不检查 ctrl.signal.aborted（空闲超时已 abort 但必须重连）
    setTimeout(() => { if (streamCtrl === ctrl) run(); }, retry);
    retry = Math.min(30000, retry * 2);
  };
  run();
}

/** 桥推送 → sendUserMessage 注入 agent 会话（模型立即看到并行动；steer=当前 turn 完成后注入） */
// 最近一条用户消息的结构化来源（桥 pushToAgents 已按 agent 接入类型补 pageId/url/source/sourceLabel）
// → agent 回答回桥时拼 [发自: <pageId>（<sourceLabel>：pageId 参数用它）] 展示标注（传输走结构，展示拼文本）
let lastUserSrc: { pageId: string | null; url: string | null; sourceLabel: string | null } = { pageId: null, url: null, sourceLabel: null };
function injectAgentEvent(pi: ExtensionAPI, m: any) {
  if (!m || typeof m !== "object") return;
  let text = "";
  if (m.type === "page_event") {
    // 页面事件（订阅后实时推；text 已在桥格式化：⚠ 页面报错 [pageId · url] ...）
    text = (m.text || "");
  } else if (m.type === "agent_push") {
    if (m.kind === "user_answer") text = "💬 你的交互请求有人作答（来自 aiti-devtools）：" + (m.text || "");
    else text = "💬 人发来消息（来自 aiti-devtools）：" + (m.text || "");
    // 记录结构化来源（桥已补 pageId/url/sourceLabel）→ 回答时拼展示标注
    const p = m.payload || {};
    if (p.pageId || p.sourceLabel) lastUserSrc = { pageId: p.pageId || null, url: p.url || null, sourceLabel: p.sourceLabel || null };
  }
  if (!text) return;
  logFile("[aiti-devtools-pi] 收到推送 → 注入会话：" + text.slice(0, 120));
  try { pi.sendUserMessage(text, { deliverAs: "steer" }); } catch (e) { console.error("[aiti-devtools-pi] 注入失败", e); }
}

// ---- agent 执行完 → 回答/summary 回桥（消息流 from agent → 窗口实时显示） ----
let lastAssistantText = "";
function extractAssistantText(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((p) => (p && p.type === "text" ? String(p.text || "") : "")).join("\n").trim();
  }
  if (content && content.type === "text") return String(content.text || "").trim();
  return "";
}
async function postAgentAnswer(text: string) {
  if (!text || !currentAgentKey || !bridgeUp) return; // 桥没联通 → 不发（避免无谓 fetch / 窗口展示失真的总结）
  await getBridgeClient(resolveBridgeUrl()).answer(currentAgentKey, text);
}

// ---- 工具注册（桥 TOOLS 一一对应；execute 无状态直连独立桥）----
// 前缀 aiti_：与 aiti-devtools MCP server 的同名工具（bridge_status/page_exec…）区分，避免模型调用歧义/冲突
// 幂等：加载时桥可达即注册；桥恢复时 connectAgentStream register 成功后补注册（模型下次请求即可用）
function registerBridgeTools(pi: ExtensionAPI) {
  if (toolsRegistered) return;
  toolsRegistered = true;
  for (const t of bridge.tools()) {
    const prefixed = "aiti_" + t.name;
    pi.registerTool({
      name: prefixed,
      description: t.description + "（aiti-devtools-pi 扩展直连独立桥——如与 MCP 同名工具冲突，用本前缀版）",
      parameters: jsonSchemaToTypeBox(t.inputSchema || { type: "object", properties: {} }),
      async execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
        const r = await callBridgeTool(t.name, params || {}, signal, toolCallId);
        return wrapToolResult(r);
      },
    });
  }
}

export default async function (pi: ExtensionAPI) {
  // ---- 重复注册守卫：优先查已注册工具表，fallback PI_WEB_* env ----
  // pi-web 场景 aiti_* 工具已由 pi-web 扩展（server.agent → SDK customTools）进程内注入；
  // 本扩展再注册会重复（工具重名 + 多余的独立桥 agent 连接）。
  // 检测链：① pi.getAllTools() 里已有 aiti_ 前缀工具（准确——同会话内先注入即可见）；
  // ② 进程带 PI_WEB_* env（pi-web 服务进程必有；兜底，防 getAllTools 不含 customTools 场景）。
  // 覆盖口：AITI_PI_EXT_FORCE=1 强制注册。
  //   ⚠ PI_WEB_BRIDGE_* 排除在宿主判定外：这是 /web 桥扩展的用户配置命名空间
  //   （shell 里合法导出，如 CLI 全自动桥 PI_WEB_BRIDGE_AUTO=1），不是宿主标记——
  //   否则普通 CLI 会话被误判为 pi-web 内嵌，aiti_* 工具集体失效。
  //   pi-web 进程仍有 CHILD_MARKER 等真实宿主标记，判定不受影响。
  const BRIDGE_CFG_ENVS = new Set([
    "PI_WEB_BRIDGE_AUTO", "PI_WEB_BRIDGE_BASE", "PI_WEB_BRIDGE_PORT", "PI_WEB_BRIDGE_LANG",
    // TUI 自动桥空闲超时（与 pi-web inprocess 会话同名的用户级配置；设了它不得被误判为宿主）
    "PI_WEB_IDLE_TIMEOUT_MS",
  ]);
  if (!process.env.AITI_PI_EXT_FORCE) {
    let dup = false;
    try {
      const all = (pi as any).getAllTools?.();
      if (Array.isArray(all)) dup = all.some((t) => t && typeof t.name === "string" && t.name.startsWith("aiti_"));
    } catch {}
    const piWebEnv = Object.keys(process.env).some((k) => k.startsWith("PI_WEB_") && !BRIDGE_CFG_ENVS.has(k));
    if (dup || piWebEnv) {
      logFile(`[aiti-devtools-pi] 跳过注册（${dup ? "工具表已有 aiti_*" : "pi-web 进程（PI_WEB_* env）——已由 pi-web 扩展注册"}）`);
      return;
    }
  }

  // ---- 桥引导：确保配置 + 检查端口，不可达则自动按该端口拉起独立桥（pi-web 场景已在上方守卫跳过）----
  // 独立 pi 启动时：①写 settings.aitiDevtools.bridgeUrl + mcp.json 的 aiti-devtools server（确保配置里有这个配置）；
  // ②探测桥端口，正常则直接用；不正常 → spawn 独立桥进程（该端口）并等待就绪，保证能工作。
  const bridgeBase = resolveBridgeUrl();
  await bootstrapBridge(bridgeBase);
  if (bridgeUp) {
    registerBridgeTools(pi);
  } else {
    logFile(`[aiti-devtools-pi] 桥不可达（${bridgeBase}）→ 暂不注册 aiti_* 工具（会话中持续尝试连接桥，恢复后自动补注册 + 建 SSE；先起独立桥：node packages/aiti-bridge/bin/aiti-bridge.mjs）`);
  }

  // ---- 生命周期：session_start 注册 + 连 agent SSE；session_shutdown 断开 ----
  pi.on("session_start", async (_e, ctx) => {
    const base = resolveBridgeUrl();
    // 统一行为：启动自注册 aiti stdio shim 到 pi 的 MCP 配置（幂等+版本守卫，最佳努力不抛错；
    // env AITI_BRIDGE_URL 决定 shim 连哪个桥；AITI_SHIM_PATH 可覆盖 shim 文件位置）。
    // 配置路径优先 $PI_CODING_AGENT_DIR/mcp.json（pi 实际读取的全局位置），fallback ~/.config/mcp/mcp.json。
    let piMcpCfg: string | null = null;
    try { piMcpCfg = join(getAgentDir(), "mcp.json"); } catch {}
    autoRegisterAitiShim({ targets: ["pi"], configPaths: piMcpCfg ? [piMcpCfg] : undefined, log: logFile });
    // 会话标识：优先 session id，fallback 文件名/时间戳（多 pi 实例/多会话可区分）
    let sid: string | null = null;
    try { sid = ctx.sessionManager.getSessionId() || null; } catch {}
    if (!sid) { try { const f = ctx.sessionManager.getSessionFile(); if (f) sid = f.split(/[/\\]/).pop()?.replace(/\.jsonl$/, "") || null; } catch {} }
    if (!sid) sid = "s_" + Date.now().toString(36);
    currentSessionId = sid;
    currentCwd = ctx.cwd || "";
    const name = agentDisplayName();
    // 快速探测更新桥状态（本地拒绝连接即 1ms）：可达则立刻补注册工具；桥状态也决定 notify 文案
    await probeBridge(base, 800);
    if (bridgeUp) registerBridgeTools(pi);
    // 无条件连 agent SSE（自带 register + 指数退避重试）：桥没连上也持续尝试，恢复后页面消息/人发消息自动注入
    connectAgentStream(pi, base, sid, name, currentCwd, (m) => injectAgentEvent(pi, m));
    logFile(`[aiti-devtools-pi] session_start · 桥${bridgeUp ? "已连接" : "不可达（后台重试中）"} · session=${sid}`);
    ctx.ui.notify(
      bridgeUp
        ? `🧰 aiti-devtools 已注册：${currentAgentKey || "…"}（桥 ${base}；页面注入 <script src="${base}/aiti-launcher.js">）`
        : `🧰 aiti-devtools 桥不可达：${base}（后台持续尝试连接，桥恢复后页面消息自动注入；先起独立桥：node packages/aiti-bridge/bin/aiti-bridge.mjs）`,
      bridgeUp ? "info" : "warning",
    );
  });
  pi.on("session_shutdown", () => {
    // 兜底：若 agent_settled 未触发（单轮模式可能直接 shutdown）且还有未发回答 → 补发（幂等：发了即清空）
    if (lastAssistantText) {
      const t = lastAssistantText;
      lastAssistantText = "";
      logFile("[aiti-devtools-pi] session_shutdown 补发回答 → ", t.slice(0, 60));
      void postAgentAnswer(t);
    }
    currentSessionId = null;
    currentAgentKey = null;
    currentCwd = "";
    lastAssistantText = "";
    if (streamCtrl) { try { streamCtrl.abort(); } catch {} streamCtrl = null; }
  });

  // ---- agent 执行完（agent_settled）→ 最后一条 assistant 回复回桥（窗口显示 summary） ----
  pi.on("message_end", async (event) => {
    if (!event || event.message?.role !== "assistant") return;
    const t = extractAssistantText(event.message.content);
    if (t) lastAssistantText = t; // 累积最后一条 assistant 文本（含中间过程消息，最终回复覆盖）
  });
  pi.on("agent_settled", async () => {
    if (!lastAssistantText) return;
    const t = lastAssistantText;
    lastAssistantText = "";
    if (!bridgeUp) { logFile("[aiti-devtools-pi] 桥未联通 → 跳过回答回桥（不发总结）"); return; }
    await postAgentAnswer(t);
  });
}
