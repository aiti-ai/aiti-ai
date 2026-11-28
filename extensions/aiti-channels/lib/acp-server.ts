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
import * as bridge from "./acp-bridge.ts";

export const ACP_PROTOCOL_VERSION = 1;
export const ACP_AGENT_INFO = { name: "aiti-piweb", title: "AITI Agent (pi-web)", version: bridge.ACP_BRIDGE_VERSION };

const IS_WIN = platform() === "win32";

/** dataDir channel of our own: pi-web hot reload can leave index.ts and this
 *  module holding DIFFERENT lib/manager.ts evaluations (module-level
 *  _dataDir state invisible across copies), which silently sent path and
 *  registry resolution to fallbacks. index.ts calls setDataDir() at load;
 *  before that the conventional cache layout applies. */
let _dataDir = "";
export function setDataDir(d: string) { _dataDir = d || ""; }
function dataDir(): string {
  return _dataDir || path.join(homedir(), ".pi", "web", "data", "aiti-channels", "cache");
}

/** Per-cwd session model/thinking preferences (same defaults as the wizard model picker).
 *  state-layer file (user intent — survives cache clears); index.ts injects the
 *  real stateDir path via setPrefsPath() at load. Read failures degrade silently
 *  to the pi-web default model. */
let _prefsPath = "";
export function setPrefsPath(p: string) { _prefsPath = p || ""; }
export type SessionModelPref = { provider: string; modelId: string; thinkingLevel?: string };
export function writeSessionModelPref(entry: { cwd: string; provider: string; modelId: string; thinkingLevel?: string }): void {
  if (!_prefsPath || !entry.cwd) throw new Error("prefs path not configured");
  let map: Array<Record<string, unknown>> = [];
  try { map = JSON.parse(fs.readFileSync(_prefsPath, "utf8")); } catch { /* fresh */ }
  if (!Array.isArray(map)) map = [];
  map = map.filter((e) => e?.cwd !== entry.cwd);
  map.push({ cwd: entry.cwd, provider: entry.provider, modelId: entry.modelId, ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}), updatedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(_prefsPath), { recursive: true });
  fs.writeFileSync(_prefsPath, JSON.stringify(map, null, 2));
}

export function clearSessionModelPref(cwd: string): void {
  if (!_prefsPath || !cwd) return;
  let map: Array<Record<string, unknown>> = [];
  try { map = JSON.parse(fs.readFileSync(_prefsPath, "utf8")); } catch { return; }
  if (!Array.isArray(map)) return;
  const next = map.filter((e) => e?.cwd !== cwd);
  if (next.length !== map.length) {
    fs.mkdirSync(path.dirname(_prefsPath), { recursive: true });
    fs.writeFileSync(_prefsPath, JSON.stringify(next, null, 2));
  }
}

export function readSessionModelPref(cwd: string): SessionModelPref | null {
  if (!_prefsPath || !cwd) return null;
  try {
    const map = JSON.parse(fs.readFileSync(_prefsPath, "utf8"));
    const pref = (Array.isArray(map) ? map : []).find((e: { cwd?: string }) => e?.cwd === cwd);
    if (pref && pref.provider && pref.modelId) {
      return { provider: String(pref.provider), modelId: String(pref.modelId), thinkingLevel: pref.thinkingLevel ? String(pref.thinkingLevel) : undefined };
    }
  } catch { /* missing/corrupt → no pref */ }
  return null;
}

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
    const tag = createHash("sha1").update(dataDir().toLowerCase()).digest("hex").slice(0, 8);
    return `\\\\.\\pipe\\aiti-channels-acp-${tag}-${instanceId}`;
  }
  return path.join(dataDir(), "acp", `${instanceId}.sock`);
}

function isNamedPipe(p: string): boolean {
  return p.startsWith("\\\\.\\pipe\\");
}

// ---------------------------------------------------------------------------
// Transport endpoints: legacy pipe/unix plus TCP (Windows native piweb chain)
// ---------------------------------------------------------------------------

/** One ACP transport endpoint. `socket` is what a client dials: a filesystem
 *  path (unix), a `\\.\pipe\...` name (pipe), or `tcp://host:port` (tcp). */
export type AcpTransport = "unix" | "pipe" | "tcp";
export type AcpEndpoint = { transport: AcpTransport; socket: string; port?: number };

/** TCP listen port resolution order (see cc-connect-acp-tcp-transport-plan.md §3):
 *  1. instance config `acpTcpPort` (instances.json, set via the instance save API)
 *  2. env AITI_ACP_TCP_PORT (test/ops override for this pi-web process)
 *  3. derived: stable hash of the instance id into 29000-29999
 * On POSIX the derived port does NOT enable TCP by itself (unix stays the
 * default there); on Windows TCP is always on — it is the native piweb
 * transport, listening alongside the named pipe. */
/** Explicit sources only (instance config + env) — used to distinguish "the
 *  user chose this port" (conflict = hard error) from the derived default
 *  (conflict = increment retry). */
export function acpTcpPortConfigured(instanceId: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(dataDir(), "instances.json"), "utf8");
    const list = JSON.parse(raw);
    const inst = (Array.isArray(list) ? list : []).find((i: { id?: string; acpTcpPort?: number }) => i?.id === instanceId);
    if (inst && Number.isFinite(inst.acpTcpPort) && Number(inst.acpTcpPort) > 0) return Number(inst.acpTcpPort);
  } catch { /* registry unreadable → fall through */ }
  const env = Number(process.env.AITI_ACP_TCP_PORT);
  if (Number.isFinite(env) && env > 0) return env;
  return null;
}

export function acpTcpPort(instanceId: string): number | null {
  const configured = acpTcpPortConfigured(instanceId);
  if (configured) return configured;
  if (!IS_WIN) return null;
  return 29000 + (createHash("sha1").update(instanceId).digest().readUInt32BE(0) % 10000);
}

function tcpEndpoint(instanceId: string, port: number): AcpEndpoint {
  return { transport: "tcp", socket: `tcp://127.0.0.1:${port}`, port };
}

/** All endpoints this instance should serve. The legacy pipe/unix endpoint
 *  always stays (connector fallback + type=acp chain keep working); TCP is
 *  added on Windows (native chain) and wherever a port is explicitly set. */
export function acpEndpoints(instanceId: string): AcpEndpoint[] {
  const eps: AcpEndpoint[] = [{ transport: IS_WIN ? "pipe" : "unix", socket: acpSocketPath(instanceId) }];
  const port = acpTcpPort(instanceId);
  if (port) eps.push(tcpEndpoint(instanceId, port));
  return eps;
}

/** Primary endpoint: what config-gen hands to the native piweb chain. TCP when
 *  present (Windows / explicitly configured), else the legacy path. */
export function primaryEndpoint(instanceId: string): AcpEndpoint {
  const eps = acpEndpoints(instanceId);
  return eps.find((e) => e.transport === "tcp") ?? eps[0];
}

/** Dial an endpoint for the liveness probe (transport-aware). */
function probeConnect(ep: AcpEndpoint): Promise<boolean> {
  return new Promise((resolve) => {
    const c = ep.transport === "tcp"
      ? net.connect({ host: "127.0.0.1", port: ep.port })
      : net.connect(ep.socket);
    const done = (v: boolean) => { try { c.destroy(); } catch { /* ignore */ } resolve(v); };
    c.once("connect", () => done(true));
    c.once("error", () => done(false));
    setTimeout(() => done(false), 500);
  });
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
          // per-cwd model preference (wizard picker, state file) → session options
          const runtime = await bridge.createSession(cwd, (() => {
            const pref = readSessionModelPref(cwd);
            return pref ? { initialModel: { provider: pref.provider, modelId: pref.modelId }, thinkingLevel: pref.thinkingLevel } : undefined;
          })());
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

/** One live listener: the endpoint it serves plus its net.Server. */
type ListenerHandle = { ep: AcpEndpoint; server: net.Server };
type ServerState = { servers: Map<string, ListenerHandle[]>; __migrated?: boolean };

function servers(): ServerState {
  const g = globalThis as Record<string, unknown>;
  if (!g[RT_KEY]) g[RT_KEY] = { servers: new Map<string, ListenerHandle[]>() };
  const st = g[RT_KEY] as ServerState & { servers: Map<string, unknown> };
  // One-time migration of pre-TCP-batch shapes: the old code stored a bare
  // net.Server per instance. Adopting it as a proper legacy handle keeps the
  // live listener serving across hot reloads — dropping it would strand the
  // endpoint (probe sees "alive elsewhere" while nobody new can bind).
  if (!st.__migrated) {
    st.__migrated = true;
    for (const [k, v] of Array.from(st.servers.entries())) {
      if (Array.isArray(v)) continue;
      const legacy = v as { listening?: boolean } | null;
      if (legacy && typeof legacy.listening === "boolean") {
        const listening = !!legacy.listening;
        st.servers.set(k, listening
          ? [{ ep: { transport: IS_WIN ? "pipe" : "unix", socket: acpSocketPath(k) }, server: v as net.Server }]
          : []);
      } else {
        st.servers.delete(k);
      }
    }
  }
  return st as ServerState;
}

/** Legacy (pipe/unix) listener: same liveness semantics as before — a live
 *  pipe held by another process is a hard double-start error; a stale unix
 *  file is removed. Reuses the in-memory server for the reload race. */
async function listenLegacy(instanceId: string, ep: AcpEndpoint): Promise<ListenerHandle> {
  const sockPath = ep.socket;
  const pipe = isNamedPipe(sockPath);
  const alive = await probeConnect(ep);
  if (alive) {
    if (pipe) throw new Error(`ACP endpoint already held by another process: ${sockPath} (another pi-web process serving the same instance? stop it first)`);
    // unix: alive but not owned in-process — another pi-web on a shared dataDir
    return { ep, server: null as unknown as net.Server };
  }
  if (!pipe) {
    fs.mkdirSync(path.dirname(sockPath), { recursive: true });
    try { fs.unlinkSync(sockPath); } catch { /* absent or not a file */ }
  }
  const server = net.createServer((conn) => new AcpConnection(instanceId, conn));
  // Reload race: shutdown's server.close() releases the pipe/file name asynchronously,
  // so an immediate listen() hits EADDRINUSE while the old handle is still draining —
  // and ensureAll only logs, leaving the endpoint dead until the next reload.
  // Retry the same in-memory server a few times; the name frees within ~1-2s.
  await new Promise<void>((resolve, reject) => {
    const attempts = 5;
    const tryListen = (n: number) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && n < attempts) setTimeout(() => tryListen(n + 1), 500);
        else reject(e);
      });
      server.listen(sockPath, () => resolve());
    };
    tryListen(1);
  });
  return { ep, server };
}

/** TCP listener on 127.0.0.1 only — the ACP protocol surface has no auth, so
 *  the port must never be exposed beyond loopback (same constraint as the
 *  cc-connect api_addr patch). An explicitly configured port that is taken is
 *  a hard error; a derived port colliding with anything increments up to 10
 *  times (probe says alive, or bind hits EADDRINUSE). */
async function listenTcp(instanceId: string, want: AcpEndpoint, explicit: boolean): Promise<ListenerHandle> {
  let port = want.port!;
  for (let attempt = 0; attempt <= (explicit ? 5 : 10); attempt++) {
    const ep = tcpEndpoint(instanceId, port);
    if (await probeConnect(ep)) {
      if (explicit) throw new Error(`ACP TCP port ${port} already served by another process (acpTcpPort explicit — pick another port)`);
      port += 1;
      continue;
    }
    const server = net.createServer((conn) => new AcpConnection(instanceId, conn));
    const bound = await new Promise<string | null>((resolve) => {
      server.once("error", (e: NodeJS.ErrnoException) => resolve(e.code || "error"));
      server.listen({ host: "127.0.0.1", port }, () => resolve(null));
    });
    if (!bound) return { ep, server };
    if (explicit && attempt >= 5) throw new Error(`ACP TCP port ${port} unavailable: ${bound} (acpTcpPort explicit — pick another port)`);
    try { server.close(); } catch { /* not open */ }
    port += 1;
  }
  throw new Error(`ACP TCP: no free port near ${want.port} (tried +${explicit ? 5 : 10})`);
}

/** Start (or reconcile) all endpoints for one instance. Safe to call again
 *  after a config change: already-listening transports are left untouched,
 *  missing ones (e.g. TCP enabled later without a pi-web restart) start here. */
export async function startAcpServer(instanceId: string): Promise<{ ok: boolean; socket: string; already?: boolean; error?: string }> {
  const eps = acpEndpoints(instanceId);
  const primary = eps.find((e) => e.transport === "tcp") ?? eps[0];
  const existing = (servers().servers.get(instanceId) ?? []).filter((h) => h.server && h.server.listening);
  const have = new Set(existing.map((h) => h.ep.transport));
  const wasComplete = eps.every((e) => have.has(e.transport));
  if (wasComplete) return { ok: true, socket: primary.socket, already: true };

  const handles: ListenerHandle[] = [...existing];
  const errors: string[] = [];
  for (const ep of eps) {
    if (have.has(ep.transport)) continue;
    try {
      const h = ep.transport === "tcp"
        ? await listenTcp(instanceId, ep, acpTcpPortConfigured(instanceId) !== null)
        : await listenLegacy(instanceId, ep);
      if (h.server) handles.push(h);
    } catch (e) {
      errors.push(`${ep.transport}: ${e instanceof Error ? e.message : e}`);
    }
  }
  servers().servers.set(instanceId, handles);
  const served = handles.map((h) => h.ep.socket).join(" + ");
  const primaryServed = handles.find((h) => h.ep.transport === primary.transport) ?? handles[0];
  if (errors.length) {
    console.error(`[aiti-channels][acp] server partial start (instance ${instanceId}): ${errors.join("; ")}`);
    if (!handles.length) throw new Error(errors.join("; "));
    return { ok: true, socket: primaryServed?.ep.socket ?? primary.socket, already: wasComplete, error: errors.join("; ") };
  }
  console.log(`[aiti-channels][acp] server listening ${served} (instance ${instanceId})`);
  return { ok: true, socket: primary.socket, already: wasComplete };
}

export function stopAcpServer(instanceId: string): boolean {
  const handles = servers().servers.get(instanceId);
  if (!handles) return false;
  servers().servers.delete(instanceId);
  for (const h of handles) {
    try { h.server.close(); } catch { /* best effort */ }
  }
  if (!isNamedPipe(acpSocketPath(instanceId))) {
    try { fs.unlinkSync(acpSocketPath(instanceId)); } catch { /* best effort */ }
  }
  return true;
}

export function stopAllAcpServers() {
  for (const id of [...servers().servers.keys()]) stopAcpServer(id);
}

/** Cross-process endpoint probe for status: alive while this process is not
 *  listening = another pi-web instance serves the same shared dataDir (the
 *  155-box PI_WEB_DATA_DIR dual-instance shape). */
function endpointAlive(ep: AcpEndpoint): Promise<boolean> {
  return probeConnect(ep);
}

export async function acpStatus(instanceId: string) {
  const handles = servers().servers.get(instanceId) ?? [];
  const eps = acpEndpoints(instanceId);
  const primary = eps.find((e) => e.transport === "tcp") ?? eps[0];
  const endpoints = [];
  for (const ep of eps) {
    const h = handles.find((x) => x.ep.transport === ep.transport);
    const shown = h ? h.ep : ep; // actual bound endpoint (port may have shifted on derived collision)
    const listening = !!(h && h.server && h.server.listening);
    const alive = listening ? true : await endpointAlive(ep);
    endpoints.push({
      transport: shown.transport,
      socket: shown.socket,
      port: shown.port,
      listening,
      endpointAlive: alive,
      ownedByOther: !listening && alive,
    });
  }
  const primaryEntry = endpoints.find((e) => e.transport === primary.transport)!;
  return {
    listening: primaryEntry.listening,
    /** this process not listening but endpoint alive (held by another instance) */
    endpointAlive: primaryEntry.endpointAlive,
    ownedByOther: primaryEntry.ownedByOther,
    /** primary endpoint — tcp://127.0.0.1:<port> when TCP is on, else the legacy path */
    socket: primary.socket,
    transport: primary.transport,
    port: primary.port ?? null,
    endpoints,
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
