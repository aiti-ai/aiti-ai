/**
 * aiti-channels · chat-relay — server-side relay between pi-web chat clients
 * (SSE downlink + REST send) and a cc-connect instance's Bridge WebSocket.
 *
 * Why a relay: the bridge listens on 127.0.0.1:<port> and the pi-web page runs
 * on another origin/port — the browser cannot reach it. The original cc-connect
 * web admin solves this with a same-origin reverse proxy; our equivalent is the
 * extension server holding ONE upstream WebSocket per instance and fan-out to
 * any number of SSE chat clients.
 *
 * Upstream protocol (core/bridge.go + web/src/hooks/useBridgeSocket.ts):
 *   connect ws://127.0.0.1:<port><path>?token=<token>
 *   → {type:"register", platform:"aiti-channels", capabilities:[...]}
 *   ← {type:"register_ack", ok}
 *   → {type:"message", msg_id, session_key, user_id, user_name, content, reply_ctx, project}
 *   ← reply | reply_stream(delta, full_text, done) | card | buttons | typing_start/stop | error | pong
 *   ping every 25s (protocol keepalive)
 *
 * Lifecycle: relay is created on first SSE chat client (or explicit send) and
 * torn down after the last client leaves (grace 5s after the server notices;
 * abrupt disconnects are detected by the 20s heartbeat, worst case ~25s) —
 * no idle background
 * connections. Reconnect uses exponential-ish backoff capped at 5s while
 * clients remain. Event-driven throughout; no polling.
 */
import { readConfigFile } from "./config.ts";
import * as managerLib from "./manager.js";

export type BridgeFrame = Record<string, any>;
type Sink = (frame: BridgeFrame) => void;

type Relay = {
  instanceId: string;
  ws: WebSocket | null;
  status: "idle" | "connecting" | "open" | "error";
  registered: boolean;
  lastError: string | null;
  sinks: Set<Sink>;
  pingTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  teardownTimer: ReturnType<typeof setTimeout> | null;
  mOptsRef: { config?: string } | null;
};

// globalThis singleton across extension reloads, keyed per instance + LIB_VERSION
const RELAYS_KEY = "__aitiChannelsChatRelays";
function relaysMap(): Map<string, Relay> {
  const g = globalThis as Record<string, any>;
  const key = `${RELAYS_KEY}_${managerLib.LIB_VERSION || "dev"}`;
  if (!g[key]) g[key] = new Map<string, Relay>();
  return g[key] as Map<string, Relay>;
}

export function bridgeInfo(mOpts: { config?: string }): { enabled: boolean; listening: boolean; port: number; path: string; lastError: string | null } & Record<string, any> {
  const cfg = readConfigFile(mOpts.config || managerLib.DEFAULTS.config);
  const b = cfg?.bridge || {};
  return { enabled: !!b.enabled, listening: true, port: Number(b.port) || 9810, path: String(b.path || "/bridge/ws"), lastError: null };
}

function relayFor(instanceId: string): Relay | undefined {
  return relaysMap().get(instanceId);
}

function setRelay(instanceId: string, r: Relay) {
  relaysMap().set(instanceId, r);
}

/** Ensure an upstream WS is connected+registered for the instance. Never throws. */
export function ensureRelay(instanceId: string, mOpts: { config?: string }): Relay {
  let r = relayFor(instanceId);
  if (!r) {
    r = { instanceId, ws: null, status: "idle", registered: false, lastError: null, sinks: new Set(), pingTimer: null, reconnectTimer: null, teardownTimer: null, mOptsRef: null };
    setRelay(instanceId, r);
  }
  r.mOptsRef = mOpts;
  if (r.ws && (r.ws.readyState === WebSocket.OPEN || r.ws.readyState === WebSocket.CONNECTING)) return r;
  connectUpstream(r);
  return r;
}

function connectUpstream(r: Relay) {
  if (!r.mOptsRef) return;
  const info = bridgeInfo(r.mOptsRef);
  if (!info.enabled) { r.status = "error"; r.lastError = "[bridge] not enabled for this instance"; return; }
  const token = (() => {
    const cfg = readConfigFile(r.mOptsRef!.config || managerLib.DEFAULTS.config);
    return String(cfg?.bridge?.token || "");
  })();
  clearTimeout(r.reconnectTimer ?? undefined);
  r.status = "connecting";
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}${info.path}?token=${encodeURIComponent(token)}`);
    r.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "register",
        platform: "aiti-channels",
        capabilities: ["text", "card", "buttons", "typing", "update_message", "preview", "reconstruct_reply"],
        metadata: { version: "1.0.0", description: "aiti-channels chat relay" },
      }));
    };
    ws.onmessage = (evt) => {
      let frame: BridgeFrame;
      try { frame = JSON.parse(String(evt.data)); } catch { return; }
      if (frame.type === "register_ack") {
        r.registered = !!frame.ok;
        if (!frame.ok) r.lastError = String(frame.error || "register rejected");
        if (r.registered) {
          r.status = "open";
          r.lastError = null;
          if (!r.pingTimer) r.pingTimer = setInterval(() => { try { r.ws?.send(JSON.stringify({ type: "ping", ts: Date.now() })); } catch { /* ignore */ } }, 25000);
        }
        return;
      }
      if (frame.type === "pong") return;
      // fan out to SSE sinks
      for (const sink of r.sinks) {
        try { sink(frame); } catch { /* a broken sink must not starve the rest */ }
      }
    };
    ws.onclose = () => {
      r.ws = null;
      r.registered = false;
      if (r.pingTimer) { clearInterval(r.pingTimer); r.pingTimer = null; }
      if (r.sinks.size > 0) {
        // clients still attached → reconnect (event-driven connection upkeep)
        r.reconnectTimer = setTimeout(() => connectUpstream(r!), 3000);
      } else {
        r.status = "idle";
      }
    };
    ws.onerror = () => {
      r.status = "error";
      r.lastError = "bridge websocket error (instance not running or [bridge] not enabled?)";
    };
  } catch (e: any) {
    r.status = "error";
    r.lastError = String(e?.message || e);
  }
}

function teardownIfIdle(r: Relay, delayMs = 5000) {
  clearTimeout(r.teardownTimer ?? undefined);
  r.teardownTimer = setTimeout(() => {
    if (r.sinks.size > 0) return; // a client came back
    if (r.pingTimer) { clearInterval(r.pingTimer); r.pingTimer = null; }
    if (r.reconnectTimer) { clearTimeout(r.reconnectTimer); r.reconnectTimer = null; }
    try { r.ws?.close(); } catch { /* ignore */ }
    r.ws = null;
    r.status = "idle";
    relaysMap().delete(r.instanceId);
  }, delayMs);
}

/** SSE stream of bridge frames (optionally filtered to one project's sessions).
 *  Returns a Response; the sink is removed when the client disconnects. */
export function sseChat(instanceId: string, mOpts: { config?: string }, project: string | null): Response {
  const r = ensureRelay(instanceId, mOpts);
  const encoder = new TextEncoder();
  let cleanup: () => void = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const push = (obj: unknown) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { /* client gone */ }
      };
      const sink: Sink = (frame) => {
        if (project) {
          const sk = String(frame.session_key || "");
          // project scoping: bridge/web-admin session_keys carry the project
          // suffix (`bridge:web-admin:<project>`); prefer the explicit project
          // field when the frame has one, else match the session_key substring.
          const fp = String(frame.project || "");
          if (fp && fp !== project) return;
          if (!fp && sk && !sk.includes(project)) return;
        }
        push(frame);
      };
      r.sinks.add(sink);
      push({ type: "relay_ready", status: r.status, registered: r.registered, error: r.lastError });
      // SSE comment heartbeat (proxy keepalive; not data polling)
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: hb\n\n`)); } catch { /* ignore */ }
      }, 20000);
      cleanup = () => {
        r.sinks.delete(sink);
        clearInterval(heartbeat);
        teardownIfIdle(r);
      };
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

/** Send a chat message through the upstream bridge (web-admin session pattern). */
export function sendChat(instanceId: string, mOpts: { config?: string }, opts: { project: string; sessionKey: string; content: string; userName?: string }): { ok: boolean; error?: string } {
  if (!opts.project || !opts.content?.trim()) return { ok: false, error: "project + content required" };
  const r = ensureRelay(instanceId, mOpts);
  if (!r.ws || r.ws.readyState !== WebSocket.OPEN) return { ok: false, error: r.lastError || "bridge not connected (instance not running or [bridge] not enabled?)" };
  const sessionKey = opts.sessionKey?.trim() || `bridge:web-admin:${opts.project}`;
  try {
    r.ws.send(JSON.stringify({
      type: "message",
      msg_id: `aiti-channels-${Date.now()}`,
      session_key: sessionKey,
      user_id: "aiti-channels",
      user_name: opts.userName || "aiti-channels",
      content: opts.content,
      reply_ctx: sessionKey,
      project: opts.project,
    }));
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** Relay status snapshot (for the chat tab header). */
export function relayStatus(instanceId: string): { status: string; registered: boolean; clients: number; error: string | null } {
  const r = relayFor(instanceId);
  return r ? { status: r.status, registered: r.registered, clients: r.sinks.size, error: r.lastError } : { status: "idle", registered: false, clients: 0, error: null };
}
