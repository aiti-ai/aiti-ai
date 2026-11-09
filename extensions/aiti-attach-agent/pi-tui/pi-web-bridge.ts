/**
 * pi-web-bridge — pi TUI extension: the /web command bridges this session to a browser.
 *
 * This is the TUI-side endpoint of the multi-agent frontend link (paired with
 * pi-web-ext/aiti-attach-agent on the pi-web side):
 *
 *   /web command
 *     1. Starts a Unix-socket JSONL server (protocol = what aiti-attach-agent speaks).
 *        Commands: prompt/steer/follow_up/abort/get_state/get_messages/
 *                  set_model/set_thinking_level/compact/set_session_name/get_commands
 *        get_state additionally carries steering/followUp queued text (mirror);
 *        queue echo: queue_update never reaches the extension event channel (upstream pi
 *        limitation), so the bridge synthesizes and broadcasts it from a text mirror
 *        (enqueue = this bridge's prompt/steer/follow_up while busy; dequeue =
 *        message_start(user); see broadcastQueueUpdate)
 *     2. Forwards all agent events (message_* / tool_* / agent_* / turn_* / model_select…)
 *     3. Detached-spawns pi-web (PI_WEB_SOCKET=sockPath); it survives pi exiting
 *        (skipped when the user picks "don't spawn" on the last page, or CLI --no-spawn —
 *        reuse an already-running instance instead)
 *     4. Tells the user the browser URL to open
 *
 * Session ownership: the pi process remains the sole writer (this extension only reads
 * ctx/pi APIs and never touches files), so there is no session contention.
 * pi exits → socket drops → the pi-web side shows "disconnected".
 *
 * Auto-bridge (env PI_WEB_BRIDGE_AUTO=1, runs on session_start, no /web needed):
 *   - CLI full-auto: a plain terminal pi session (no pi-web host marker) auto-attaches
 *     the bridge on startup; any pi-web instance (dev/prod) can open the session
 *     (All Sessions shows the tui-bridge tag), live view + bidirectional IO.
 *     Optional PI_WEB_BRIDGE_BASE points at a running pi-web (used for aiti_* tool
 *     routing / URL derivation; the attach itself goes through bridge-registry.json and
 *     does not depend on that address).
 *   - Subagent auto (§5.4): pi-web host spawn injection + PI_SUBAGENT_CHILD=1, same behavior.
 *   - pi-web in-process agents (PI_WEB_CHILD_MARKER): never auto-bridge / never
 *     register /web (already inside the web).
 *
 * Install: cp this file to ~/.pi/agent/extensions/pi-web-bridge.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServer, type Server, type Socket } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
// Shared bridge registry module (same package ../bridge-registry.ts; deployed along
// with the directory when installed as a directory extension)
import { registerBridge, unregisterBridge, bridgeSocketName } from "../bridge-registry";

// ── Protocol constants (aligned with aiti-attach-agent) ────────────────────────────────
const FORWARDED_EVENTS = [
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "agent_start", "agent_end", "agent_settled",
  "turn_start", "turn_end",
  "model_select", "thinking_level_select",
  "session_info_changed",
];

// Shared bridge registry module (same package ../bridge-registry.ts): TUI writes, Web
// reads, single owner of the format

// ── Message i18n (the pi extension layer has no i18n mechanism; minimal string table) ──
// Language: env PI_WEB_BRIDGE_LANG=zh|en explicit > LC_ALL/LANG/LANGUAGE starting with
// "zh" → Chinese; otherwise English. Fixed at process start, never switches at runtime.
type BridgeLang = "zh" | "en";
function detectBridgeLang(): BridgeLang {
  const explicit = (process.env.PI_WEB_BRIDGE_LANG || "").trim().toLowerCase();
  if (explicit === "en" || explicit === "zh") return explicit;
  const lc = process.env.LC_ALL || process.env.LANG || process.env.LANGUAGE || "";
  return /^zh/i.test(lc.trim()) ? "zh" : "en";
}
const ZH_M = {
  customArgsTitle: "自定义参数（可留空直接回车；示例：--base https://pi.example.com:8443/dev ｜ --domain pi.example.com --scheme https）",
  modeTitle: "启动方式",
  modeTakeover: "接管（不起桥：pi-web 内部跑 pi SDK 接手本会话，TUI 不再输入）",
  modeAttach: "attach（起 rpc 桥：pi-web 经 attach 连本会话，IO 转发一起工作）",
  finalTitle: "pi-web 服务（最后一步）",
  finalSpawnOpen: "启动并打开浏览器",
  finalSpawnNoOpen: "只启动，不打开浏览器",
  finalNoSpawn: "不启动（连接已在运行的 pi-web）",
  addrInput: "已有 pi-web 地址（留空回车 = 按 --port/env 推导 http://127.0.0.1:<port>）",
  stopped: "pi-web bridge stopped（pi-web 与 rpc 已关闭）",
  notRunning: "pi-web bridge not running",
  runningTitle: (u: string) => `pi-web bridge 已运行 → ${u}`,
  openBrowser: "打开浏览器",
  noOpenBrowser: "不打开浏览器",
  showInfo: "显示连接信息（URL + 执行的参数）",
  stop: "停止（关闭 pi-web 与 rpc）",
  stillRunning: (u: string) => `桥仍运行中：${u}`,
  infoMsg: (u: string, c: string) => `pi-web bridge: ${u}\n执行的参数：${c}`,
  alreadyRunning: (p: string) => `pi-web bridge already running: ${p}`,
  noSession: "no persisted session to bridge (send a message first)",
  attached: (u: string) => `pi-web attached → ${u}（IO 沿桥转发，一起工作）`,
  takeoverDone: (u: string) => `pi-web 接管 → ${u}（本会话已移交浏览器操作；TUI 请退出本会话避免双写）`,
  lastCommandLabel: "\n执行的参数：",
  idleShutdown: (min: string) => `自动桥空闲超时（${min} 分钟无活动），退出本会话——PI_WEB_IDLE_TIMEOUT_MS 可调，0 禁用`,
};
const EN_M: typeof ZH_M = {
  customArgsTitle: "Custom args (Enter to skip; e.g. --base https://pi.example.com:8443/dev | --domain pi.example.com --scheme https)",
  modeTitle: "Start mode",
  modeTakeover: "Takeover (no bridge: pi-web runs pi SDK in-process; TUI stops accepting input)",
  modeAttach: "Attach (rpc bridge: pi-web attaches to this session; IO forwarded, work together)",
  finalTitle: "pi-web server (final step)",
  finalSpawnOpen: "Spawn new + open browser",
  finalSpawnNoOpen: "Spawn new, don't open browser",
  finalNoSpawn: "Don't spawn (connect to an already-running pi-web)",
  addrInput: "Existing pi-web URL (empty Enter = derive from --port/env as http://127.0.0.1:<port>)",
  stopped: "pi-web bridge stopped (pi-web & rpc closed)",
  notRunning: "pi-web bridge not running",
  runningTitle: (u: string) => `pi-web bridge already running → ${u}`,
  openBrowser: "Open browser",
  noOpenBrowser: "Don't open browser",
  showInfo: "Show connection info (URL + executed args)",
  stop: "Stop (close pi-web & rpc)",
  stillRunning: (u: string) => `Bridge still running: ${u}`,
  infoMsg: (u: string, c: string) => `pi-web bridge: ${u}\nExecuted as: ${c}`,
  alreadyRunning: (p: string) => `pi-web bridge already running: ${p}`,
  noSession: "no persisted session to bridge (send a message first)",
  attached: (u: string) => `pi-web attached → ${u} (IO forwarded over the bridge, work together)`,
  takeoverDone: (u: string) => `pi-web takeover → ${u} (session handed to the browser; exit this TUI session to avoid double writes)`,
  lastCommandLabel: "\nExecuted as: ",
  idleShutdown: (min: string) => `Auto-bridge idle timeout (${min} min), exiting this session — set PI_WEB_IDLE_TIMEOUT_MS to adjust, 0 to disable`,
};
const S = ({ zh: ZH_M, en: EN_M })[detectBridgeLang()];

/** Parse /web args: --port 3000 / --no-open / --open / --no-spawn / --spawn */
function parseWebArgs(raw: string): {
  hasArgs: boolean;
  open?: boolean;
  spawn?: boolean;
  port?: string;
  basePath?: string;
  base?: string;
  scheme?: string;
  domain?: string;
  webport?: string;
  takeover?: boolean;
} {
  const out: ReturnType<typeof parseWebArgs> = { hasArgs: false };
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return out;
  out.hasArgs = true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = () => {
      const v = tokens[i + 1];
      if (v && !v.startsWith("--")) { i++; return v; }
      return undefined;
    };
    if (t === "--port") { const v = next(); if (v) out.port = v; }
    else if (t === "--base") { const v = next(); if (v) out.base = v; }
    else if (t === "--basepath" || t === "--url") { const v = next(); if (v) out.basePath = v; }
    else if (t === "--scheme") { const v = next(); if (v) out.scheme = v; }
    else if (t === "--domain" || t === "--host") { const v = next(); if (v) out.domain = v; }
    else if (t === "--webport") { const v = next(); if (v) out.webport = v; }
    else if (t === "--takeover") out.takeover = true;
    else if (t === "--attach") out.takeover = false;
    else if (t === "--no-open") out.open = false;
    else if (t === "--open") out.open = true;
    else if (t === "--no-spawn") out.spawn = false;
    else if (t === "--spawn") out.spawn = true;
    // Unknown tokens are ignored (lenient: never blow up on user input)
  }
  return out;
}

/**
 * Resolve the public URL prefix. Priority:
 *   1) --base / --url / a --basepath containing "://" / env PI_WEB_BASE_PATH (whole prefix)
 *   2) --domain (+ --scheme / --webport / --basepath path) combination
 *   3) empty → caller falls back to local http://127.0.0.1:<port>/
 */
function resolveBridgeBase(flags: { base?: string; url?: string; basePath?: string; scheme?: string; domain?: string; webport?: string }): string {
  const whole = flags.base || flags.url
    || (flags.basePath && flags.basePath.includes("://") ? flags.basePath : undefined)
    || process.env.PI_WEB_BASE_PATH;
  if (whole) return whole.replace(/\/+$/, "");
  const scheme = flags.scheme || "http";
  if (flags.domain) {
    const host = flags.domain.includes(":") ? flags.domain : flags.domain + (flags.webport ? `:${flags.webport}` : "");
    const path = flags.basePath ? "/" + flags.basePath.replace(/^\/+|\/+$/g, "") : "";
    return `${scheme}://${host}${path}`;
  }
  return "";
}

/**
 * Plumb the URL-prefix config into the spawned pi-web process:
 *   - PI_WEB_BASE_DOMAIN / PI_WEB_ALLOWED_HOSTS ← public domain (guards against DNS
 *     rebinding 403s)
 *   - PI_WEB_BASE_PATH ← subpath (effective for next dev / built via PI_WEB_BUILD_BASEPATH)
 * Configuring the URL text alone does not take effect — without this layer the browser
 * reaches pi-web through a reverse proxy and gets rejected.
 */
function applyBridgeDomainEnv(flags: { base?: string; url?: string; basePath?: string; domain?: string }, env: Record<string, string>): void {
  try {
    const whole = flags.base || flags.url
      || (flags.basePath && flags.basePath.includes("://") ? flags.basePath : undefined);
    const u = whole ? new URL(whole) : flags.domain ? new URL(`http://${flags.domain}`) : null;
    if (u) {
      const host = u.host;
      const hostOnly = host.split(":")[0];
      env.PI_WEB_BASE_DOMAIN = host;
      // The proxied Host header may or may not carry a port — allow both (avoid DNS
      // rebinding false kills)
      env.PI_WEB_ALLOWED_HOSTS = host === hostOnly ? host : `${host},${hostOnly}`;
      if (u.pathname && u.pathname !== "/") env.PI_WEB_BASE_PATH = u.pathname.replace(/\/+$/, "");
    }
  } catch {
    /* Parse failure ignored: URL text still goes through the resolveBridgeBase fallback */
  }
}

function openBrowser(url: string): void {
  if (platform() === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  else if (platform() === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

export default function (pi: ExtensionAPI) {
  // ── Auto-bridge mode (aiti fork, §5.4 + CLI full-auto) ────────────────────────────────
  // Switch = PI_WEB_BRIDGE_AUTO=1; two kinds of automation depending on process identity:
  // ① HEADLESS_AUTO (subagents): injected by the pi-web host (instrumentation.ts, spawn
  //    env passthrough) + PI_SUBAGENT_CHILD=1 (the upstream pi-args marker stamped on
  //    every child agent process).
  //    Must bypass the host guard — subagent spawn env carries PI_WEB_SOCKET and other
  //    host markers.
  // ② CLI_AUTO (CLI full-auto): the user's shell profile exports PI_WEB_BRIDGE_AUTO=1;
  //    a plain terminal pi session (including -c/--resume) starts the bridge on boot.
  //    The key discriminator = PI_WEB_CHILD_MARKER (stamped by pi-web instrumentation on
  //    itself and all child processes): CLI sessions never carry it, pi-web in-process /
  //    its children always do.
  // Auto behavior = equivalent to "/web --attach --no-spawn --no-open": no wizard, no
  // browser; start bridge + write bridge-registry → opening the session in pi-web
  // attaches to it (non-exclusive, bidirectional IO).
  const AUTO_ENV = process.env.PI_WEB_BRIDGE_AUTO === "1";
  const SUBAGENT_CHILD = process.env.PI_SUBAGENT_CHILD === "1";
  const IN_PI_WEB_HOST = process.env.PI_WEB_CHILD_MARKER !== undefined;
  const HEADLESS_AUTO = AUTO_ENV && SUBAGENT_CHILD;                    // ① subagent
  const CLI_AUTO = AUTO_ENV && !SUBAGENT_CHILD && !IN_PI_WEB_HOST;     // ② CLI full-auto
  const AUTO_BRIDGE = HEADLESS_AUTO || CLI_AUTO;
  // pi-web in-process agents (plan M / spawn backend) also load this extension from
  // ~/.pi/agent/extensions — but there is no TUI there, and /web would leak into the
  // pi-web AI page command list (verified on dev/prod). Host detection = PI_WEB_CHILD_MARKER
  // or any other PI_WEB_* env. ⚠ PI_WEB_BRIDGE_* and PI_WEB_IDLE_TIMEOUT_MS are this
  // extension's user-config namespace (legitimately exported in the shell) and do NOT
  // count as host markers — otherwise CLI_AUTO would self-exclude (PI_WEB_IDLE_TIMEOUT_MS
  // bit us in production: with it set, the auto bridge never registered).
  const HOST_ENV = Object.keys(process.env).some(
    (k) => k.startsWith("PI_WEB_")
      && k !== "PI_WEB_BRIDGE_AUTO" && k !== "PI_WEB_BRIDGE_BASE"
      && k !== "PI_WEB_BRIDGE_PORT" && k !== "PI_WEB_BRIDGE_LANG"
      && k !== "PI_WEB_IDLE_TIMEOUT_MS",
  );
  if (!HEADLESS_AUTO && (IN_PI_WEB_HOST || HOST_ENV)) {
    console.log("[pi-web-bridge] skipping /web registration (in-process pi-web agent — this extension only registers in TUI sessions)");
    return;
  }
  let server: Server | null = null;
  let child: ChildProcess | null = null;
  let sockPath: string | null = null;
  let webPort: string | null = null;
  let bridgeUrl: string | null = null;   // remembered bridge URL (idempotent display; cleared by /web off)
  let registeredFile: string | null = null; // current registry key (follows in-process /new, /resume switches)
  let lastCommand: string | null = null;  // remembered "executed args" (next /web <args> skips the wizard)
  let lastTools: Array<{ name: string; description: string; active: boolean; parameters?: Record<string, unknown> }> = [];  // tools snapshot from the model request (get_tools data source)
  const clients = new Set<Socket>();
  // Page registry (merged single data stream): each attach connection pushes the set of
  // pageIds served by its own bridge; forwarding routes by args.pageId to the rpc that
  // registered it. Older instances that never push (e.g. production) simply never
  // participate.
  const relayPages = new Map<Socket, Set<string>>();
  let latestCtx: import("@earendil-works/pi-coding-agent").ExtensionContext | null = null;
  // Reverse-RPC facade (published to globalThis.__aitiTuiRelay when /web is active, so
  // the connector bundle can handshake across modules)
  let installTuiRelay: { active(): boolean; call(tool: string, args: Record<string, unknown>): Promise<unknown> } | null = null;

  // ── Auto-bridge idle timeout exit (CLI_AUTO only) ─────────────────────────────────────
  // Time control mirrors pi-web inprocess (rpc sessions) idle close: same env
  // PI_WEB_IDLE_TIMEOUT_MS (default 10 min, 0 = disabled, invalid falls back to default
  // with a warning; parse rules aligned with pi-web lib/rpc-manager.ts).
  // Purpose: when a TUI left running by the shell-profile full-auto bridge
  // (PI_WEB_BRIDGE_AUTO=1) sits unused for a long time, don't leave residue
  // (process + bridge socket + the connector's persistent registration retries).
  // Still active at expiry (pi working / a page attached) → re-arm; only truly idle
  // → ctx.shutdown() (Interactive mode already defers to idle when busy).
  // Manual /web (explicit user action) and HEADLESS_AUTO (subagents managed by their
  // parent flow) never auto-exit.
  const IDLE_TIMEOUT_MS = (() => {
    const raw = process.env.PI_WEB_IDLE_TIMEOUT_MS;
    if (raw !== undefined && String(raw).trim() !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2_147_483_647) return parsed;
      console.warn(`[pi-web-bridge] invalid PI_WEB_IDLE_TIMEOUT_MS "${raw}", falling back to 10 minutes`);
    }
    return 10 * 60 * 1000;
  })();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  function onIdleTimeout(): void {
    idleTimer = null;
    // Soft check at expiry (rpc-manager-style re-arm semantics): a page attached / pi
    // busy → re-arm instead of closing
    if (clients.size > 0) return idleArm();
    if (latestCtx && !latestCtx.isIdle()) return idleArm();
    try { latestCtx?.ui.notify(S.idleShutdown(String(Math.round(IDLE_TIMEOUT_MS / 60000))), "info"); } catch { /* notify unavailable: don't block */ }
    try { latestCtx?.shutdown(); } catch { /* shutdown failure: cleaned up on next start */ }
  }
  const idleArm = () => {
    if (!CLI_AUTO || IDLE_TIMEOUT_MS === 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdleTimeout, IDLE_TIMEOUT_MS);
  };
  const idlePoke = () => { if (CLI_AUTO && IDLE_TIMEOUT_MS !== 0) idleArm(); };

  // ── Queue mirror (synthesized queue_update echo) ──────────────────────────────────────
  // pi's queue_update never reaches the extension event channel (upstream
  // _emitExtensionEvent only forwards 8 event types, so pi.on("queue_update") never
  // fires) — followUp/steer messages queued while the TUI streams are completely
  // invisible on the pi-web side (empty queue panel, no chat bubble; retry throttling
  // can queue for minutes), i.e. "followUp sent from pi-web has no echo". The bridge
  // keeps its own text mirror and broadcasts synthesized queue_updates:
  //   enqueue = this bridge's prompt/steer/follow_up while the TUI is busy
  //     (!ctx.isIdle()) → text enters the mirror;
  //   dequeue = forwarded message_start(role=user) pops the matching text in pi's own
  //     order (steering first, then followUp);
  //   self-heal = get_state sees pendingMessageCount=0 while the mirror is non-empty
  //     (TUI cleared its local queue) → clear and rebroadcast.
  // Payload {type:"queue_update",steering:[],followUp:[]} matches pi's native shape
  // (no rev; the frontend applies local session semantics). Both enqueue sources are
  // covered: bridge commands (prompt/steer/follow_up while busy) + terminal-local
  // enqueues (input event with source==="interactive" and non-empty streamingBehavior,
  // see registerEventListeners).
  const queueMirror: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  const broadcastQueueUpdate = () => {
    broadcast({ type: "queue_update", steering: [...queueMirror.steering], followUp: [...queueMirror.followUp] });
  };
  const queueMirrorPush = (kind: "steering" | "followUp", text: string) => {
    queueMirror[kind].push(text);
    broadcastQueueUpdate();
  };
  const queueMirrorPopDelivered = (message: unknown): void => {
    const msg = message as { role?: unknown; content?: unknown } | undefined;
    if (!msg || msg.role !== "user") return;
    // Text extraction matches pi's contentText(content, ""): concat type==="text" blocks
    const text = Array.isArray(msg.content)
      ? (msg.content as Array<{ type?: unknown; text?: unknown }>)
          .filter((c) => c && c.type === "text")
          .map((c) => String(c.text ?? ""))
          .join("")
      : "";
    if (!text) return;
    let popped = false;
    const si = queueMirror.steering.indexOf(text);
    if (si !== -1) { queueMirror.steering.splice(si, 1); popped = true; }
    else {
      const fi = queueMirror.followUp.indexOf(text);
      if (fi !== -1) { queueMirror.followUp.splice(fi, 1); popped = true; }
    }
    if (popped) broadcastQueueUpdate();
  };
  const queueMirrorHeal = (ctx: NonNullable<typeof latestCtx>): void => {
    if (!ctx.hasPendingMessages() && (queueMirror.steering.length > 0 || queueMirror.followUp.length > 0)) {
      queueMirror.steering = [];
      queueMirror.followUp = [];
      broadcastQueueUpdate();
    }
  };
  // Image attachments sent from pi-web (same shape as validateAgentImages:
  // {type:"image",data,mimeType}) — strictly validated per item, then passed through to
  // sendUserMessage (previously dropped silently: queued/steered messages with images
  // lost their attachments). The mirror still records text only (queue_update payload
  // is text-only by design).
  const parseImages = (raw: unknown): Array<{ type: "image"; data: string; mimeType: string }> => {
    if (!Array.isArray(raw)) return [];
    const out: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const im of raw) {
      if (typeof im !== "object" || im === null) continue;
      const o = im as Record<string, unknown>;
      if (o.type !== "image" || typeof o.data !== "string" || typeof o.mimeType !== "string") continue;
      out.push({ type: "image", data: o.data, mimeType: o.mimeType });
    }
    return out;
  };

  const broadcast = (event: Record<string, unknown>) => {
    // Slimming (O(n²) serialization-storm fix): message_update carries the message
  // field plus assistantMessageEvent.partial (both the ever-growing full message
  // text); streaming fires message_update on every chunk — without stripping, every
  // broadcast re-stringifies the accumulated full text → O(n²) storm (measured 40-90%
  // CPU; long replies blocked >3s, looked like a hang). Consumers (pi-web
  // agent-event-wire.toClientAgentEvent / handle-adapter) only consume deltas and the
  // official implementation strips partial too; the full message arrives via the
  // low-frequency message_end, so broadcasting deltas only loses nothing.
  // Short-circuit: when /web was never run (clients empty) skip even stringify — this
  // extension is unconditionally loaded by pi-web in-process agents which register
  // event listeners; stringify-per-event just to write to 0 clients burns CPU on air
  // (measured 40-90% of the main thread).
    if (clients.size === 0) return;
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (typeof ae === "object" && ae !== null && !Array.isArray(ae)) {
        const { partial: _partial, ...delta } = ae;
        void _partial;
        let next: Record<string, unknown> = delta;
        // Matches the official toJsonAssistantMessageEvent: toolcall_start's
        // id/toolName live only in partial.content[contentIndex] — extract them before
        // stripping partial, otherwise the consumer's streaming reducer drops
        // toolcall_start for missing toolName and the tool block only renders at
        // toolcall_end.
        if (ae.type === "toolcall_start") {
          const p = (ae as { partial?: unknown }).partial;
          const content = (typeof p === "object" && p !== null ? (p as { content?: unknown }).content : undefined);
          const idx = typeof ae.contentIndex === "number" ? ae.contentIndex : -1;
          const block = (Array.isArray(content) ? content[idx] : undefined) as Record<string, unknown> | undefined;
          if (block && block.type === "toolCall") {
            next = { ...delta, id: block.id, toolName: block.name };
          }
        }
        event = { type: "message_update", assistantMessageEvent: next };
      }
    }
    const data = JSON.stringify(event) + "\n";
    for (const c of clients) { try { c.write(data); } catch { clients.delete(c); } } // EPIPE: evict the client, never crash the process
  };

  // ── ctx capture (needed by abort/state) + event forwarding ──
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    // Auto-start the bridge (headless subagent / CLI full-auto): equivalent to
    // /web --attach --no-spawn --no-open
    // (idempotent: skips when the server is already running; after /web off, a new
    // in-process session re-auto-bridges — off only affects the current state)
    if (AUTO_BRIDGE && !server) {
      try {
        const base = process.env.PI_WEB_BRIDGE_BASE || "";
        await runWeb(`--attach --no-spawn --no-open${base ? ` --base ${base}` : ""}`, ctx);
        console.log(`[pi-web-bridge] auto-bridge started (${HEADLESS_AUTO ? "headless subagent" : "CLI"} mode, registered in registry)`);
        idleArm(); // idle clock starts once the bridge is up (CLI_AUTO only; 0 disables / no-op otherwise)
      } catch (e) {
        console.error("[pi-web-bridge] auto-bridge failed:", e instanceof Error ? e.message : String(e));
      }
      return;
    }
    // In-process session switch (/new, /resume → session_start reason=new|resume):
    // re-register the registry against the current session file (socket reuse — event
    // broadcast is process-level anyway). Without re-registering, the registry still
    // points at the old file and opening the new session in the web takes the local
    // open path = double-writer risk (the registry exists precisely to prevent it).
    if (AUTO_BRIDGE && server) {
      try {
        const file = ctx.sessionManager.getSessionFile() ?? "";
        if (file && file !== registeredFile) {
          if (registeredFile) await unregisterBridge(registeredFile);
          await registerBridge(file);
          registeredFile = file;
          console.log("[pi-web-bridge] session switched → registry re-registered (socket reused)");
        }
        idlePoke(); // session switch (/new, /resume) = activity signal
      } catch (e) {
        console.error("[pi-web-bridge] registry re-register on session switch failed:", e instanceof Error ? e.message : String(e));
      }
    }
  });
  // Event-forwarding listeners are no longer registered unconditionally at the top
  // level (pi.on cannot be unsubscribed and lives for the host process):
  // pi-web in-process agents also load this extension, and registering before /web
  // means every streaming event calls broadcast pointlessly (even short-circuited,
  // that's an extra dispatch). Register only when /web activates (see
  // registerEventListeners); unbridged events never reach this extension at all.
  let eventsRegistered = false;
  const registerEventListeners = () => {
    if (eventsRegistered) return;
    for (const evt of FORWARDED_EVENTS) {
      // Event payloads differ in shape but are all spread and forwarded; route through
      // unknown to avoid per-event overloads
      const handler = (event: unknown) => {
        // Queue dequeue: a user message starting delivery = pi already removed it from
        // its own queue (same ordering as _handleAgentEvent; queue_update reaches the
        // consumer before message_start)
        if (evt === "message_start") queueMirrorPopDelivered((event as { message?: unknown }).message);
        broadcast({ type: evt, ...(event as Record<string, unknown>) }); idlePoke();
      };
      (pi.on as (e: string, h: (x: unknown) => void) => void)(evt, handler);
    }
    // Terminal enqueue awareness (blind-spot fix 2026-10-17): while the TUI streams,
    // Enter = prompt({streamingBehavior: "steer"}), Alt+Enter = "followUp"; pi fires
    // the input extension event before its queueing decision (a separate direct
    // channel that bypasses the _emitExtensionEvent whitelist, so pi.on("input")
    // receives it) with payload {text, source, streamingBehavior} — non-empty means it
    // will be queued. Only source==="interactive" counts (bridge-driven commands have
    // source==="extension" and were already pushed at the command entry; no double
    // count). undefined = idle submit (runs immediately; the bubble arrives via
    // message_end and never enters the mirror). If a push ends up not actually queued
    // (race: the run finishes inside the emitInput await gap), the text is popped
    // normally when the first user message of the new run arrives via
    // message_start/end — the mirror stays consistent.
    (pi.on as (e: string, h: (x: unknown) => void) => void)("input", (raw: unknown) => {
      const ev = raw as { source?: unknown; text?: unknown; streamingBehavior?: unknown };
      if (ev.source !== "interactive") return;
      if (ev.streamingBehavior !== "steer" && ev.streamingBehavior !== "followUp") return;
      const text = String(ev.text ?? "");
      if (!text) return;
      queueMirrorPush(ev.streamingBehavior === "followUp" ? "followUp" : "steering", text);
    });
    // Tools snapshot: before_provider_request's payload = the model request body
    // (including the tools array) — the real data source for get_tools (the extension
    // API has no tools read; without this listener there is no way to get it).
    (pi.on as (e: string, h: (x: unknown) => void) => void)("before_provider_request", (raw: unknown) => {
      idlePoke(); // a model request going out = activity signal
      const payload = (raw as { payload?: { tools?: unknown } } | undefined)?.payload;
      const list = payload?.tools;
      if (!Array.isArray(list)) return;
      lastTools = (list as Array<Record<string, unknown>>).map((t) => {
        const fn = (typeof t.function === "object" && t.function !== null ? t.function : t) as {
          name?: unknown; description?: unknown; parameters?: Record<string, unknown>;
        };
        return {
          name: String(fn.name ?? t.name ?? ""),
          description: String(fn.description ?? t.description ?? ""),
          active: true,
          ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
        };
      });
    });
    eventsRegistered = true;
  };

  const reply = (socket: Socket, id: string, success: boolean, data?: unknown, error?: string) => {
    // EPIPE (peer already gone) must never become an uncaught exception — that would
    // kill the whole TUI process (confirmed in the field, 06:58:38)
    try {
      socket.write(JSON.stringify({ id, type: "response", success, ...(success ? { data } : { error }) }) + "\n");
    } catch { try { clients.delete(socket); } catch { /* ignore */ } }
  };

  const handleCommand = async (socket: Socket, cmd: Record<string, unknown>) => {
    const id = String(cmd.id ?? "");
    const type = String(cmd.type ?? "");
    const ctx = latestCtx;
    try {
      switch (type) {
        case "prompt": {
          const text = String(cmd.text ?? "");
          const images = parseImages(cmd.images);
          const content = images.length ? [{ type: "text" as const, text }, ...images] : text;
          // TUI busy → pi will queue the message (prompt()'s streamingBehavior branch)
          // → push into the mirror for the synthesized echo; idle → runs immediately
          // and the user bubble echoes naturally via message_start/end (not mirrored).
          // The mirror records text only: dequeue matching uses contentText
          // (type==="text" blocks), so image-bearing messages are unaffected.
          if (ctx && !ctx.isIdle()) queueMirrorPush(cmd.streamingBehavior === "followUp" ? "followUp" : "steering", text);
          pi.sendUserMessage(content, { deliverAs: cmd.streamingBehavior === "followUp" ? "followUp" : "steer" });
          idlePoke(); // page-driven interaction = activity signal
          return reply(socket, id, true);
        }
        case "steer": {
          const text = String(cmd.text ?? "");
          const images = parseImages(cmd.images);
          if (ctx && !ctx.isIdle()) queueMirrorPush("steering", text);
          pi.sendUserMessage(images.length ? [{ type: "text" as const, text }, ...images] : text, { deliverAs: "steer" });
          idlePoke();
          return reply(socket, id, true);
        }
        case "follow_up": {
          const text = String(cmd.text ?? "");
          const images = parseImages(cmd.images);
          if (ctx && !ctx.isIdle()) queueMirrorPush("followUp", text);
          pi.sendUserMessage(images.length ? [{ type: "text" as const, text }, ...images] : text, { deliverAs: "followUp" });
          idlePoke();
          return reply(socket, id, true);
        }
        case "abort":
          if (!ctx) throw new Error("no active context");
          ctx.abort();
          return reply(socket, id, true);
        case "get_state": {
          if (!ctx) throw new Error("no active context");
          queueMirrorHeal(ctx); // self-heal after TUI-local queue clears (pendingMessageCount=0 with non-empty mirror → clear + rebroadcast)
          return reply(socket, id, true, {
            sessionId: ctx.sessionManager.getSessionId?.() ?? "",
            isStreaming: !ctx.isIdle(),
            model: ctx.model ? { id: ctx.model.id, provider: ctx.model.provider } : undefined,
            thinkingLevel: ctx.thinkingLevel,
            pendingMessageCount: ctx.hasPendingMessages() ? 1 : 0,
            // Queued text (mirror): data source for the pi-web attach backend's
            // queueManage(list) — the queue panel restores from it after page
            // refresh/reconnect (previously omitted → refresh lost the display)
            steering: [...queueMirror.steering],
            followUp: [...queueMirror.followUp],
          });
        }
        case "get_messages": {
          // Flatten to AgentMessage shape (entries are {type,message,...} wrappers)
          const entries = (ctx as NonNullable<typeof ctx>).sessionManager.getEntries() as unknown as Array<Record<string, unknown>>;
          const messages = entries
            .filter((e) => e.type === "message")
            .map((e) => (e.message ?? e) as Record<string, unknown>);
          return reply(socket, id, true, { messages });
        }
        case "get_commands": {
          const commands = pi.getCommands().map((c) => ({ name: c.name, description: c.description, source: c.source }));
          return reply(socket, id, true, { commands });
        }
        case "set_model": {
          if (!ctx) throw new Error("no active context");
          const registry = ctx.modelRegistry as unknown as {
            getAvailableSnapshot?: () => Array<{ provider: string; id: string }>;
            getAvailable?: () => Array<{ provider: string; id: string }>;
          };
          const list = registry.getAvailableSnapshot?.() ?? registry.getAvailable?.() ?? [];
          const found = list.find((m) => m.provider === cmd.provider && m.id === cmd.modelId);
          if (!found) throw new Error(`model not found: ${cmd.provider}/${cmd.modelId}`);
          const ok = await pi.setModel(found as never);
          return ok ? reply(socket, id, true) : reply(socket, id, false, undefined, "no api key");
        }
        case "set_thinking_level":
          pi.setThinkingLevel((cmd.level ?? "off") as never);
          return reply(socket, id, true);
        case "compact":
          if (!ctx) throw new Error("no active context");
          ctx.compact({ customInstructions: typeof cmd.customInstructions === "string" ? cmd.customInstructions : undefined });
          return reply(socket, id, true);
        case "set_session_name":
          pi.setSessionName(String(cmd.name ?? ""));
          return reply(socket, id, true);
        case "get_tools": {
          // Data source = the tools snapshot captured from before_provider_request
          // (the real tool list); an empty array until first captured (frontend shows
          // its normal empty state).
          return reply(socket, id, true, lastTools);
        }
        default:
          return reply(socket, id, false, undefined, `unsupported command: ${type}`);
      }
    } catch (e) {
      return reply(socket, id, false, undefined, e instanceof Error ? e.message : String(e));
    }
  };

  // Stop the bridge: drop clients + close server + clear URL/executed-args + release the
  // registry entry + kill the spawned pi-web (manual /web off or the management menu's
  // "Stop" = close everything; session_shutdown does NOT kill the child — detached,
  // left to the user)
  const stopBridge = (ctx: { ui: { notify: (m: string, k?: string) => void } }) => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } // after a manual stop, never auto-exit (the user took over)
    for (const c of clients) c.destroy();
    clients.clear();
    server?.close();
    server = null;
    bridgeUrl = null;
    (globalThis as Record<string, unknown>).__aitiTuiRelay = null; // /web off → reverse RPC offline; connector falls back to direct bridge
    lastCommand = null;
    if (child && child.exitCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill(); } catch { /* already exited */ } }
    }
    child = null;
    if (latestCtx) void unregisterBridge(registeredFile ?? latestCtx.sessionManager.getSessionFile() ?? "");
    registeredFile = null;
    notifySafe(S.stopped, "info");
  };

  /** Build the "executed args" string: assemble this run's choices into a reusable /web command line (skips the TUI wizard). */
  function buildCommandArgs(flags: { port?: string; takeover?: boolean; base?: string; url?: string; basePath?: string; scheme?: string; domain?: string; webport?: string }, o: { open: boolean; spawn: boolean }): string {
    const parts: string[] = [flags.takeover ? "--takeover" : "--attach"];
    if (flags.port) parts.push(`--port ${flags.port}`);
    const base = resolveBridgeBase(flags);
    if (base) parts.push(`--base ${base}`);
    parts.push(o.open ? "--open" : "--no-open");
    if (!o.spawn) parts.push("--no-spawn");
    return `/web ${parts.join(" ")}`;
  }

  // Command body (shared by TUI /web and the auto-bridge): empty rawArgs opens the
  // interactive wizard (TUI only); args go direct. Under AUTO_BRIDGE everything logs to
  // console to keep the UI noise-free — callers guarantee direct args + base ready
  // (env PI_WEB_BRIDGE_BASE); the interactive branch guards itself.
  const runWeb = async (rawArgs: string, ctx: import("@earendil-works/pi-coding-agent").ExtensionContext): Promise<void> => {
    const notifySafe = (msg: string, level: "info" | "error") => {
      if (AUTO_BRIDGE) { console.log(`[pi-web-bridge] ${msg}`); return; }
      try { ctx.ui.notify(msg, level); } catch { /* headless ctx fallback */ }
    };
      // /web off: stop the bridge (server + clients + registry; event listeners can't be
      // unsubscribed since pi.on is one-way, but broadcast short-circuits on empty
      // clients → zero cost; the next /web restores forwarding)
      const arg = typeof rawArgs === "string" ? rawArgs.trim().toLowerCase() : "";
      // Parse args up front: the management branch (server already running) also reads
      // flags.takeover etc., avoiding TDZ
      const flags = parseWebArgs(typeof rawArgs === "string" ? rawArgs : String(rawArgs ?? ""));
      if (arg === "off" || arg === "stop" || arg === "close" || arg === "--off") {
        if (!server) {
          notifySafe("pi-web bridge not running", "info");
          return;
        }
        stopBridge(ctx);
        return;
      }
      if (server) {
        // Idempotent: already running → the four-option "manage running bridge" menu
        // (CLI_AUTO has a TUI too, so the menu is fine; only headless subagents
        // short-circuit to console)
        if (bridgeUrl) {
          if (HEADLESS_AUTO) { console.log(`[pi-web-bridge] already running: ${bridgeUrl}`); return; }
          const act = await ctx.ui.select(S.runningTitle(bridgeUrl), [
            S.openBrowser,
            S.noOpenBrowser,
            S.showInfo,
            S.stop,
          ]);
          if (act === undefined) return; // user cancelled
          if (act.startsWith(S.openBrowser)) openBrowser(bridgeUrl);
          else if (act.startsWith(S.noOpenBrowser)) notifySafe(S.stillRunning(bridgeUrl), "info");
          else if (act.startsWith(S.showInfo)) ctx.ui.notify(S.infoMsg(bridgeUrl, lastCommand ?? buildCommandArgs({ takeover: flags.takeover === true }, { open: true, spawn: true })), "info");
          else if (act.startsWith(S.stop)) stopBridge(ctx);
          return;
        }
        // Older process without a recorded URL: echo the socket path only
        notifySafe(S.alreadyRunning(sockPath ?? ""), "info");
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      // Empty session (file not lazily persisted yet) may still bridge: opening the
      // session in pi-web looks the registry up by id and prefers socket attach (the
      // file read is only for history replay) — no file needed, only a session id.
      if (!sessionFile && !ctx.sessionManager.getSessionId()) throw new Error(S.noSession);

      // ── Mode decision: with args, use them directly; without, show the wizard ──
      let openBrowser_ = true;
      let doSpawn = true;
      if (flags.hasArgs) {
        if (flags.open !== undefined) openBrowser_ = flags.open;
        if (flags.spawn !== undefined) doSpawn = flags.spawn;
      } else {
        // Two-stage wizard: ① custom args (optional, may be empty) → ② mode
        // (takeover/attach) → ③ server × browser three options
        const custom = await ctx.ui.input(
          S.customArgsTitle,
          `--port ${process.env.PI_WEB_BRIDGE_PORT || "3000"}`,
        );
        if (custom === undefined) return; // user cancelled
        if (custom.trim() !== "") {
          const extra = parseWebArgs(custom);
          for (const k of Object.keys(extra) as Array<keyof typeof extra>) {
            if (extra[k] !== undefined) (flags as Record<string, unknown>)[k] = extra[k];
          }
        }
        // Both modes spawn a new pi-web; the difference is the mechanism (see the
        // bridge block below under if (!takeover)):
        //   takeover = no rpc bridge; after pi-web opens the file it runs the pi SDK
        //     in-process and takes over this session (the TUI stops accepting input)
        //   attach = starts the rpc bridge; pi-web attaches to this session, IO is
        //     forwarded/broadcast over the bridge, both work together
        const mode = await ctx.ui.select(S.modeTitle, [S.modeTakeover, S.modeAttach]);
        if (mode === undefined) return; // user cancelled
        flags.takeover = mode.startsWith(S.modeTakeover);
        // ③ Last page: "spawn × browser" combined into three options — when a resident
        // dev/prod instance is already running there is no need to spawn a new one
        // every time (a second build + port drift); pick "don't spawn" to reuse it.
        // CLI equivalent: --no-spawn (address from --base/--url, or the port-derived
        // fallback when empty).
        const br = await ctx.ui.select(S.finalTitle, [
          S.finalSpawnOpen,
          S.finalSpawnNoOpen,
          S.finalNoSpawn,
        ]);
        if (br === undefined) return; // user cancelled
        if (br.startsWith(S.finalNoSpawn)) {
          doSpawn = false;
          // Existing instance address: CLI --base/--url/--domain and env
          // PI_WEB_BASE_PATH take priority; only ask when none is set (may stay empty →
          // keep the port-derived fallback URL)
          if (!resolveBridgeBase(flags)) {
            if (HEADLESS_AUTO) throw new Error("headless auto-bridge requires PI_WEB_BRIDGE_BASE pointing at a running pi-web");
            const addr = await ctx.ui.input(S.addrInput, "");
            if (addr === undefined) return; // user cancelled
            if (addr.trim() !== "") flags.base = addr.trim();
          }
        } else {
          openBrowser_ = br.startsWith(S.finalSpawnOpen);
        }
      }

      const port = flags.port || process.env.PI_WEB_BRIDGE_PORT || "3000";

      // 1. Socket server (attach mode only: rpc interface + event broadcast; takeover
      //    starts no bridge)
      const takeover = flags.takeover === true;
      if (!takeover) {
      sockPath = bridgeSocketName(process.pid);
      // Reverse-RPC response routing: aiti_* tools are forwarded over this socket into
      // the in-process pi-web bridge (merged single stream: no HTTP/auth/port reachability
      // needed — reuses the existing attach connection; frame protocol see
      // aiti-attach-agent/index.ts handleAitiBridgeReq). Response frame ids get the "rr"
      // prefix.
      let relaySeq = 0;
      const relayPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      installTuiRelay = {
        active: () => {
          if (server === null) return false;
          // Any peer that pushed a registration frame (even with pages=0 at the time —
          // page claims may arrive after attach) is a forwardable peer
          return relayPages.size > 0;
        },
        call: (tool: string, args: Record<string, unknown>): Promise<unknown> =>
          new Promise((resolve, reject) => {
            const pid = typeof args.pageId === "string" ? args.pageId : null;
            // Self-healing routing: peers holding the pageId go first, tried one by one
            // (20s each); silent peers are evicted; only total failure throws → the
            // connector falls back to the direct bridge. Zombie connections no longer
            // block for 120s.
            const matched: Array<{ sock: Socket; ids: Set<string> }> = [];
            const others: Array<{ sock: Socket; ids: Set<string> }> = [];
            for (const [c, ids] of relayPages) {
              if (pid && ids.has(pid)) matched.push({ sock: c, ids });
              else others.push({ sock: c, ids });
            }
            const candidates = [...matched, ...others];
            console.log(`[pi-web-bridge] relay → ${tool} | clients=${clients.size} candidates=matched${matched.length}+other${others.length} | pageId=${pid ?? "-"}`);
            if (candidates.length === 0) return reject(new Error("relay: no rpc peer has registered pages"));
            const attempt = (idx: number): Promise<unknown> => {
              if (idx >= candidates.length) return Promise.reject(new Error("relay: all candidate peers failed to answer"));
              const { sock, ids } = candidates[idx];
              const id = "rr" + ++relaySeq;
              return new Promise((resolve2, reject2) => {
                const timer = setTimeout(() => {
                  if (relayPending.delete(id)) {
                    relayPages.delete(sock); // evict silent peer (half-open/zombie connection)
                    reject2(new Error(`relay timeout (20s): ${tool} @peer${idx}`));
                  }
                }, 20_000);
                relayPending.set(id, { resolve: resolve2, reject: reject2, timer });
                try {
                  sock.write(JSON.stringify({ id, type: "aiti_bridge_req", tool, args }) + "\n");
                } catch (e) {
                  clearTimeout(timer);
                  relayPending.delete(id);
                  relayPages.delete(sock);
                  reject2(new Error("relay write EPIPE: " + (e instanceof Error ? e.message : String(e))));
                }
              });
            };
            return attempt(0).catch(() => attempt(1).catch(() => (candidates.length > 2 ? attempt(2) : Promise.reject(new Error("relay: all peers failed")))));
          }),
      };
      (globalThis as Record<string, unknown>).__aitiTuiRelay = installTuiRelay;
      await new Promise<void>(async (resolve, reject) => {
        server = createServer((socket) => {
          clients.add(socket);
          idlePoke(); // a page attach connection = activity signal (resets the idle clock)
          // Write errors like EPIPE/ECONNRESET must never become uncaught exceptions
          // that kill the whole TUI process
          // (field-confirmed: reply() writing to a closed client → EPIPE → process exit
          // → relay/registration all lost)
          socket.on("error", () => { try { clients.delete(socket); relayPages.delete(socket); } catch { /* ignore */ } });
          let buf = Buffer.alloc(0);
          socket.on("data", (chunk: Buffer | string) => {
            // Accumulate bytes, split on \n as Buffer, then decode each line as utf8
            // (hardening A1 style) — per-chunk toString() can split multi-byte
            // characters across chunks, JSON.parse fails → the frame is silently lost
            // (relay fake timeouts)
            const c = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
            buf = buf.length === 0 ? c : Buffer.concat([buf, c]);
            let i: number;
            while ((i = buf.indexOf(0x0a)) !== -1) {
              const line = buf.subarray(0, i).toString("utf8");
              buf = buf.subarray(i + 1);
              try {
                const cmd = JSON.parse(line) as Record<string, unknown>;
                // ① Page registry push (pi-web → pi): update this connection's routable
                //    pageId set; older instances that never pushed (e.g. production)
                //    never become forwarding targets
                if (cmd.type === "aiti_pages") {
                  const pages = Array.isArray(cmd.pages) ? cmd.pages : [];
                  relayPages.set(socket, new Set(pages.map((p) => String((p as { pageId?: unknown }).pageId ?? "")).filter(Boolean)));
                  console.log(`[pi-web-bridge] aiti_pages ← via=${String(cmd.via ?? "?")} pages=${pages.length}`);
                  continue;
                }
                // ② Reverse-RPC responses (id=rr*) → route to relayPending; everything
                //    else is a forward command frame
                if (cmd.type === "response" && typeof cmd.id === "string" && cmd.id.startsWith("rr")) {
                  const p = relayPending.get(cmd.id);
                  if (!p) continue;
                  clearTimeout(p.timer);
                  relayPending.delete(cmd.id);
                  if (cmd.success === true) {
                    // Consume the piggybacked page-registry refresh (the peer syncs the
                    // latest pageId set on every forwarded response, covering the lag of
                    // "registered only once at connect": new/closed pages take effect on
                    // the next hop)
                    const d = cmd.data as { __pages?: { pages?: Array<{ pageId?: unknown }> } } | undefined;
                    if (d && d.__pages && Array.isArray(d.__pages.pages)) {
                      relayPages.set(socket, new Set(d.__pages.pages.map((q) => String((q as { pageId?: unknown }).pageId ?? "")).filter(Boolean)));
                    }
                    p.resolve(cmd.data);
                  } else p.reject(new Error(String(cmd.error ?? "relay failed")));
                } else {
                  void handleCommand(socket, cmd);
                }
              } catch { /* ignore */ }
            }
          });
          socket.on("close", () => { clients.delete(socket); relayPages.delete(socket); });
        });
        server.once("error", (err: Error) => { server = null; reject(err); });
        if (platform() !== "win32") {
          // Clean up stale socket files left by crashes (Windows named pipes manage
          // themselves; no such step needed). ⚠ The await must complete BEFORE listen:
          // otherwise the async import may run unlinkSync after listen already resolved,
          // deleting the just-created socket file (hit in E2E).
          await import("node:fs").then((fs) => { try { if (sockPath) fs.unlinkSync(sockPath); } catch { /* not there */ } });
        }
        // Socket permissions tightened to owner-only (default 0775 would let any other
        // local user connect and drive the session). Windows named-pipe ACLs isolate by
        // default; no such step needed.
        server.listen(sockPath, () => {
          if (platform() !== "win32" && sockPath) {
            void import("node:fs").then((fs) => { try { fs.chmodSync(sockPath!, 0o600); } catch { /* ignore */ } });
          }
          resolve();
        });
      });

      // 1.5 Register event forwarding only after the bridge is active (zero listeners,
      // zero dispatches before /web)
      registerEventListeners();
      }

      // 2. Detached-spawn pi-web (socket injected via env; survives pi exiting)
      //    Skipped in attach-only mode (doSpawn=false) — the user already has a pi-web
      webPort = port;
      if (doSpawn) {
        const entry = process.env.PI_WEB_BRIDGE_ENTRY || "pi-web";
        const childEnv: Record<string, string> = {
          ...process.env,
          PI_WEB_ATTACH_CWD: ctx.cwd,
          PORT: port,
        };
        if (!takeover) childEnv.PI_WEB_SOCKET = sockPath ?? "";
        applyBridgeDomainEnv(flags, childEnv);
        child = spawn(entry, [], {
          detached: true,
          stdio: "ignore",
          env: childEnv,
        });
        child.unref();
      }

      // 3. Registry registration (attach mode only: pi-web recognizes the ownership and
      //    attaches when opening the file)
      if (!takeover && sessionFile) {
        await registerBridge(sessionFile);
        registeredFile = sessionFile;
      }

      const basePath = resolveBridgeBase(flags);
      // session param uses the session id (uuid), not the path — AppShell
      // getInitialNavigation matches sessions by id (?session= and ?cwd= are mutually
      // exclusive, cwd wins)
      const sessionParam = ctx.sessionManager.getSessionId() || sessionFile;
      const url = basePath
        ? `${basePath}/?session=${encodeURIComponent(sessionParam)}`
        : `http://127.0.0.1:${port}/?session=${encodeURIComponent(sessionParam)}`;
      bridgeUrl = url;

      // Merged bridge (two-in-one): if this session has the aiti_* connector installed,
      // its tools should reach the same bridge as the pi-web page being opened (the page
      // launcher connects same-origin to <web>/api/extensions/aiti-devtools/mcp).
      // ⚠ Only merge when there is a real base (the user explicitly pointed at some
      // pi-web) — with CLI full-auto and no PI_WEB_BRIDGE_BASE set, the address derived
      // from the default port is a guess; writing it would only mislead the connector's
      // probing/retries (connecting to a port that does not exist); in that case keep
      // the connector's own bootstrap (standalone bridge).
      if (!process.env.AITI_BRIDGE_URL && basePath) {
        const webBase = (basePath || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
        process.env.AITI_BRIDGE_URL = webBase + "/api/extensions/aiti-devtools/mcp";
      }

      // 4. Browser open, gated by mode
      if (openBrowser_) openBrowser(url);

      lastCommand = buildCommandArgs(flags, { open: openBrowser_, spawn: doSpawn });
      notifySafe(
        (takeover ? S.takeoverDone(url) : S.attached(url)) + S.lastCommandLabel + lastCommand,
        "info",
      );
  };

  pi.registerCommand("web", {
    description: "Bridge this session to the browser (pi-web)",
    handler: (rawArgs, ctx) => runWeb(typeof rawArgs === "string" ? rawArgs : String(rawArgs ?? ""), ctx),
  });

  pi.on("session_shutdown", () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    for (const c of clients) c.destroy();
    clients.clear();
    server?.close();
    server = null;
    bridgeUrl = null;
    installTuiRelay = null;
    (globalThis as Record<string, unknown>).__aitiTuiRelay = null;
    if (latestCtx) void unregisterBridge(registeredFile ?? latestCtx.sessionManager.getSessionFile() ?? "");
    registeredFile = null;
    if (child && child.exitCode === null) {
      // Bridge down is enough — pi-web keeps running (detached), the user decides
      child.unref();
    }
  });
}
