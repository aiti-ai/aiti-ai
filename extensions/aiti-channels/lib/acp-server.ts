/**
 * aiti-channels · ACP server（P3 核心）——pi-web 作为 agent provider
 *
 * Agent Client Protocol（agentclientprotocol.com）JSON-RPC 2.0，newline-delimited，
 * 监听 Unix socket：<extDataDir>/acp/<instanceId>.sock。
 *
 * 链路：钉钉/飞书 → cc-connect（type=acp 项目）→ spawn 薄连接器
 *       bin/aiti-acp-connector.mjs（stdio ⇄ 本 socket 字节双向转发）→ 这里
 *       → lib/acp-bridge.ts → pi-web 真会话（方案 M 进程内）。
 *
 * agent 归属：ACP server 在 pi-web 进程内常驻（扩展 server 生命周期），
 * cc-connect 只 spawn 几 KB 连接器——pi 进程全部归 aiti 管（用户核心诉求，
 * docs/aiti-channels-extension-plan.md §3.5.5 方式二）。
 *
 * 实现的方法面（对照 cc-connect agent/acp client 源码逐一核对）：
 *   initialize        → protocolVersion 1 + loadSession 能力声明
 *   session/new       → 建桥接会话 {sessionId}
 *   session/load      → 按 sessionId 重挂（pi-web 重启后按 sessionFile 复原）
 *   session/prompt    → 文本入会话，流式经 session/update 回，轮末回 {stopReason}
 *   session/set_mode  → 未声明 modes，容错回成功
 *   session/cancel    → 通知：打断当前轮
 * 反向请求（server → client）：session/request_permission 人闸管道——桥在收到
 *   会话的 permission_request 事件时向客户端（cc-connect）发起，IM 弹批准卡，
 *   响应经本连接回灌。pi 会话目前无审批事件（pi SDK 无审批闸），管道先行就位。
 * 客户端能力声明 fs/terminal 均 false（cc-connect 实测如此），不涉及 fs/terminal 反向请求。
 */
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir, platform } from "node:os";
import { createHash } from "node:crypto";
import { getDataDir } from "./manager.ts";
import * as bridge from "./acp-bridge.ts";

export const ACP_PROTOCOL_VERSION = 1;
export const ACP_AGENT_INFO = { name: "aiti-piweb", title: "AITI Agent (pi-web)", version: bridge.ACP_BRIDGE_VERSION };

const IS_WIN = platform() === "win32";

/** 连接器稳定路径：部署后固定在 prod 扩展目录（config.toml cmd 用；cc-connect 与 dev/prod 共享） */
export function connectorBin(): string {
  return path.join(homedir(), ".pi", "web", "extensions", "aiti-channels", "bin", "aiti-acp-connector.mjs");
}

/**
 * ACP 传输端点。Windows 走命名管（`\\.\pipe\aiti-channels-acp-<dataDir摘要>-<id>`——Node/libuv
 * 的 listen/connect 在 win 只认命名管语义，文件路径 UDS 实测 EACCES；样板
 * _shared/aiti-attach-agent/bridge-registry.ts:104）；POSIX 走 UDS 文件。
 * 管名必须掺 dataDir 摘要：同一机器 dev/prod 双 pi-web 实例各有独立 dataDir → 各自独立管。
 * （第一版用裸 instanceId，双实例同名管互踩——prod 启动探活探到 dev 持有的管就静默跳过，
 * 面板 listening:false 且日志零输出，2026-09-19 真机踩坑。）
 * 连接器（node net.connect）与 config-gen 的 TOML 转义（JSON.stringify）对管路径原样兼容。
 */
export function acpSocketPath(instanceId: string): string {
  if (IS_WIN) {
    const dataDir = getDataDir() || path.join(homedir(), ".pi", "web", "data", "aiti-channels", "cache");
    const tag = createHash("sha1").update(dataDir.toLowerCase()).digest("hex").slice(0, 8);
    return `\\\\.\\pipe\\aiti-channels-acp-${tag}-${instanceId}`;
  }
  return path.join(getDataDir() || path.join(homedir(), ".pi", "web", "data", "aiti-channels", "config"), "acp", `${instanceId}.sock`);
}

function isNamedPipe(p: string): boolean {
  return p.startsWith("\\\\.\\pipe\\");
}

// ---------------------------------------------------------------------------
// JSON-RPC 连接
// ---------------------------------------------------------------------------

type JsonRpcMsg = { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code: number; message: string } };

/** 反向请求（request_permission 等人闸）等 IM 用户的耐心上限；超时按取消处理。
 *  env 覆盖仅供测试演练/运维调参（如 AITI_ACP_CALL_TIMEOUT_MS=3000 做超时注入）。 */
const CLIENT_CALL_TIMEOUT_MS = Number(process.env.AITI_ACP_CALL_TIMEOUT_MS) || 10 * 60 * 1000;

class AcpConnection {
  private buf = "";
  private closed = false;
  private nextReqId = 1;
  /** 我们发出去的反向请求（session/request_permission）；连接断开/超时统一拒绝 */
  private pendingCalls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private instanceId: string, private conn: net.Socket) {
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => this.onData(chunk));
    conn.on("error", () => { this.closed = true; this.rejectAllPending(new Error("connection error")); });
    conn.on("close", () => { this.closed = true; this.rejectAllPending(new Error("connection closed")); });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) this.handleLine(line);
    }
  }

  private write(obj: unknown) {
    if (this.closed) return;
    try { this.conn.write(JSON.stringify(obj) + "\n"); } catch { this.closed = true; }
  }

  private respond(id: unknown, result: unknown) { this.write({ jsonrpc: "2.0", id, result }); }
  private respondError(id: unknown, code: number, message: string) { this.write({ jsonrpc: "2.0", id, error: { code, message } }); }

  /** 桥接事件出口：ACP update → session/update 通知 */
  private emitFor(acpSessionId: string) {
    return (update: Record<string, unknown>) => {
      this.write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: acpSessionId, update } });
    };
  }

  /**
   * 反向调用：server → client 的 JSON-RPC 请求（当前仅 session/request_permission）。
   * cc-connect 收到后弹 IM 批准卡，用户点击后回 {outcome:{outcome,optionId?}}。
   * 超时/连接断开 reject——调用方（桥）把异常当「无人批准」处理。
   */
  callClient(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const id = this.nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new Error(`${method} timeout（${CLIENT_CALL_TIMEOUT_MS / 1000}s 无响应）`));
      }, CLIENT_CALL_TIMEOUT_MS);
      this.pendingCalls.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private rejectAllPending(err: Error) {
    for (const [, p] of this.pendingCalls) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pendingCalls.clear();
  }

  /** 路由客户端对我们反向请求的响应（result/error 皆可能） */
  private resolvePending(id: unknown, msg: JsonRpcMsg) {
    const key = typeof id === "number" ? id : Number(id);
    const pending = this.pendingCalls.get(key);
    if (!pending) return;
    this.pendingCalls.delete(key);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new Error(`client error ${msg.error.code}: ${msg.error.message}`));
    else pending.resolve(msg.result);
  }

  /**
   * 人闸：向客户端发 session/request_permission（IM 弹批准卡）。
   * 选项固定 allow/reject 各一（allow_once/reject_once），optionId 与桥侧约定：
   * "allow" = 放行，其余（reject/cancelled）= 拒绝。连接断开/超时/响应不识别
   * 都返回 null，调用方按「无人批准」回退。
   */
  private async requestPermission(acpSessionId: string, toolCall: bridge.PermissionToolCall): Promise<bridge.PermissionOutcome | null> {
    const options = [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ];
    try {
      const raw = await this.callClient("session/request_permission", { sessionId: acpSessionId, toolCall, options });
      const out = (raw as { outcome?: { outcome?: string; optionId?: string } } | null)?.outcome;
      if (!out || typeof out.outcome !== "string") return null;
      return { outcome: out.outcome === "selected" && out.optionId ? "selected" : "cancelled", optionId: out.optionId };
    } catch {
      return null;
    }
  }

  private async handleLine(line: string) {
    let msg: JsonRpcMsg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    if (!method) {
      // 客户端响应（我们反向请求的 result/error）
      if (id !== undefined && id !== null) this.resolvePending(id, msg);
      return;
    }
    const p = params || {};

    if (id === undefined || id === null) {
      // 通知
      if (method === "session/cancel" && typeof p.sessionId === "string") {
        try { await bridge.cancel(p.sessionId); } catch { /* 尽力 */ }
      }
      return;
    }

    try {
      switch (method) {
        case "initialize": {
          this.respond(id, {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: { loadSession: true, sessionCapabilities: {} },
            agentInfo: ACP_AGENT_INFO,
          });
          break;
        }
        case "session/new": {
          const cwd = String(p.cwd || "");
          const runtime = await bridge.createSession(cwd);
          console.log(`[aiti-channels][acp] session/new ${this.instanceId}: acp=${runtime.info.acpSessionId.slice(0, 8)} pi=${runtime.info.piSessionId.slice(0, 12)} cwd=${cwd}`);
          this.respond(id, { sessionId: runtime.info.acpSessionId });
          break;
        }
        case "session/load": {
          const sid = String(p.sessionId || "");
          const runtime = await bridge.reattach(sid);
          console.log(`[aiti-channels][acp] session/load ${this.instanceId}: acp=${sid.slice(0, 8)} pi=${runtime.info.piSessionId.slice(0, 12)}`);
          this.respond(id, { sessionId: runtime.info.acpSessionId });
          break;
        }
        case "session/prompt": {
          const sid = String(p.sessionId || "");
          const text = promptText(p.prompt);
          console.log(`[aiti-channels][acp] session/prompt ${sid.slice(0, 8)} len=${text.length}`);
          if (!text) { this.respondError(id, -32602, "empty prompt"); break; }
          const r = await bridge.prompt(sid, text, this.emitFor(sid), (toolCall) => this.requestPermission(sid, toolCall));
          this.respond(id, { stopReason: r.stopReason });
          break;
        }
        case "session/set_mode": {
          // 未声明 modes；容错回成功（cc-connect 仅在声明过 modes 时才调）
          this.respond(id, {});
          break;
        }
        default:
          console.log(`[aiti-channels][acp] 未支持方法：${method}`);
          this.respondError(id, -32601, `method not implemented: ${method}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[aiti-channels][acp] ${method} 失败:`, message);
      this.respondError(id, -32000, message);
    }
  }
}

/** prompt blocks → 纯文本（cc-connect 只发 text；图片已落盘成路径拼进文本） */
function promptText(blocks: unknown): string {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const b of blocks) {
    if (b && typeof b === "object") {
      const o = b as { type?: string; text?: string };
      if (o.type === "text" && typeof o.text === "string") parts.push(o.text);
    } else if (typeof b === "string") {
      parts.push(b);
    }
  }
  return parts.join("\n").trim();
}

// ---------------------------------------------------------------------------
// server 生命周期（globalThis 单例——reload 复用，socket 不中断）
// ---------------------------------------------------------------------------

const RT_KEY = "__aitiChannelsAcpServers";

type ServerState = { servers: Map<string, net.Server> };

function servers(): ServerState {
  const g = globalThis as Record<string, unknown>;
  if (!g[RT_KEY]) g[RT_KEY] = { servers: new Map<string, net.Server>() };
  return g[RT_KEY] as ServerState;
}

export async function startAcpServer(instanceId: string): Promise<{ ok: boolean; socket: string; already?: boolean; error?: string }> {
  const sockPath = acpSocketPath(instanceId);
  const pipe = isNamedPipe(sockPath);
  const existing = servers().servers.get(instanceId);
  if (existing && existing.listening) return { ok: true, socket: sockPath, already: true };

  // 残留端点：试连一次，活的（理论上不可能——同进程 map 已查）才复用，死文件清掉。
  // 命名管无「残留文件」概念（server 关即消失）：管仍活着 = 被其他进程占用（同 dataDir
  // 双启动），**显式报错**而非静默 already——静默会让面板 listening:false 且日志零输出，
  // 正是 dataDir 摘要引入前双实例互踩的表象。
  const alive = await new Promise<boolean>((resolve) => {
    const c = net.connect(sockPath, () => { c.destroy(); resolve(true); });
    c.on("error", () => resolve(false));
    setTimeout(() => { c.destroy(); resolve(false); }, 500);
  });
  if (alive) {
    if (pipe) throw new Error(`ACP 端点已被其他进程占用：${sockPath}（同实例双 pi-web 进程在跑？先停另一个）`);
    return { ok: true, socket: sockPath, already: true };
  }
  if (!pipe) {
    fs.mkdirSync(path.dirname(sockPath), { recursive: true });
    try { fs.unlinkSync(sockPath); } catch { /* 不存在/非文件——忽略 */ }
  }

  const server = net.createServer((conn) => new AcpConnection(instanceId, conn));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => resolve());
  });
  servers().servers.set(instanceId, server);
  console.log(`[aiti-channels][acp] server 监听 ${sockPath}（实例 ${instanceId}${pipe ? "，命名管" : ""}）`);
  return { ok: true, socket: sockPath };
}

export function stopAcpServer(instanceId: string): boolean {
  const server = servers().servers.get(instanceId);
  if (!server) return false;
  servers().servers.delete(instanceId);
  try { server.close(); } catch { /* 尽力 */ }
  if (!isNamedPipe(acpSocketPath(instanceId))) {
    try { fs.unlinkSync(acpSocketPath(instanceId)); } catch { /* 尽力 */ }
  }
  return true;
}

export function stopAllAcpServers() {
  for (const id of [...servers().servers.keys()]) stopAcpServer(id);
}

/** 端点试连（跨进程可见）：本进程没监听但端点活着 = 另一 pi-web 实例在服务同一共享
 *  dataDir 的实例（155 机 PI_WEB_DATA_DIR 双实例共享是既定部署形态）。 */
function endpointAlive(sockPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(sockPath, () => { c.destroy(); resolve(true); });
    c.on("error", () => resolve(false));
    setTimeout(() => { c.destroy(); resolve(false); }, 500);
  });
}

export async function acpStatus(instanceId: string) {
  const server = servers().servers.get(instanceId);
  const listening = !!(server && server.listening);
  const socket = acpSocketPath(instanceId);
  const endpointAliveOk = listening ? true : await endpointAlive(socket);
  return {
    listening,
    /** 本进程未监听但端点存活（另一实例持有）——共享 dataDir 双实例部署的正常形态 */
    endpointAlive: endpointAliveOk,
    ownedByOther: !listening && endpointAliveOk,
    socket,
    connector: connectorBin(),
    connectorExists: fs.existsSync(connectorBin()),
    sessions: bridge.listSessions().map((s) => ({
      acpSessionId: s.acpSessionId,
      piSessionId: s.piSessionId,
      cwd: s.cwd,
      createdAt: s.createdAt,
      live: !!bridge.getRuntime(s.acpSessionId)?.wrapper?.isAlive(),
    })),
  };
}

/** 启动全部实例的 server（startup 调；失败只记日志不阻塞扩展启动） */
export async function ensureAll(instanceIds: string[]) {
  for (const id of instanceIds) {
    try { await startAcpServer(id); } catch (e) {
      console.error(`[aiti-channels][acp] 实例 ${id} server 启动失败:`, e instanceof Error ? e.message : e);
    }
  }
}
