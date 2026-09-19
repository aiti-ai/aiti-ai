// Page-level singleton: shared SSE channel for /api/agent/running/events (connection-pool protection)
//
// Background: browsers allow only 6 concurrent HTTP/1.1 connections per host. If the page's
// long-lived connections (running/events, availability/events, plan-first/events, extension
// bridge SSE, media watch...) are each opened per component instance (SessionSidebar alone has
// 2 instances under desktop/mobile dual rendering), the total hits 6 quickly, after which every
// new request (media streams, any fetch) pends forever — the whole page starves (observed:
// video won't play, random fetches time out after 4s, while curl works fine).
//
// So running/events shares one connection page-wide: subscribers only attach callbacks; the
// connection is actually closed when the last one unsubscribes. The server's 30s heartbeat
// (named event "heartbeat") serves liveness checks; error broadcasting is left to subscribers
// (e.g. delayed rebuild after CLOSED goes through broker.reconnect()).
import { apiUrl } from "./base-path";
import { isConnStarved } from "./conn-guard";
import { getEventBus, type BusEventSource } from "./event-bus-client";

// The server sends a 30s heartbeat; no frame at all (message/heartbeat) for longer than
// HEARTBEAT_FRAME_TIMEOUT_MS = the connection is half-dead / frozen by the browser in the
// background (a "silently dead connection": EventSource stays OPEN but receives no data and
// never fires onerror) → the broker's heartbeat watchdog proactively closes and rebuilds,
// healing the half-dead connection (this previously kept the session-manager health clock
// permanently timed out, falling back to polling /api/agent/running every 15s and needlessly
// amplifying backend load).
export const HEARTBEAT_FRAME_TIMEOUT_MS = 75_000;
// Type of the "heartbeat frame" the host broker delivers to frameListeners (dedicated to the
// extension health clock; consumers dispatch by type and ignore unknown types, never tripping
// each other). The original contract did not deliver the named heartbeat frame to
// frameListeners, so extensions received no frames at all while the running set was stable
// (no running-change frames) → the SSE was permanently judged dead. This frame fills that gap.
export const HEARTBEAT_FRAME_TYPE = "piwe:heartbeat";

export type RunningFrame = { type?: string; runningSessionIds?: string[] };
type Listener = (kind: "message" | "heartbeat" | "error", data: RunningFrame | null, raw?: MessageEvent) => void;

interface RunningBroker {
  listeners: Set<Listener>;
  frameListeners: Set<(frame: Record<string, unknown>) => void>;
  es: EventSource | BusEventSource | null;
  dead: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Consecutive failure count (+1 on each EventSource onerror; reset on onopen) — >=2 means the backend is disconnected */
  connFails: number;
  /** Whether "disconnected" has already been broadcast (broadcast only on state transitions, no repeated spam) */
  connOffline: boolean;
  /** Time of the last received frame (message/heartbeat) — the heartbeat watchdog's liveness baseline */
  lastFrameAt: number;
  /** Heartbeat-timeout watchdog (event-driven: reset on every frame; no frame within the
   *  window = half-dead connection → proactive rebuild).
   *  Zero business polling — it is the equivalent of TCP keepalive, frame-driven reset, no timed pulls. */
  frameWatchdog: ReturnType<typeof setTimeout> | null;
  connect: () => void;
}

// ── Backend disconnect/recovery broadcast (data source for the backend-restart banner)──────────────────
// During a backend (host app) restart window all requests 502 / are refused, and the scattered
// "HTTP 502" toasts carry no "please refresh" guidance. This reuses the broker's existing
// connection lifecycle as a page-wide unified liveness signal:
//   - EventSource onerror = one failure (during the restart, the existing 3s rebuild loop keeps
//     feeding errors); only >=2 consecutive failures count as disconnected — filtering one-off
//     network blips (common with mobile tunnel flaps).
//   - onopen = recovered (the connection actually got established).
// Zero new polling: the detection cadence is the existing reconnect loop itself.
export type BackendConnState = "offline" | "online";
const connStateListeners = new Set<(state: BackendConnState) => void>();

/** Subscribe to backend disconnect/recovery (module-level listener + window CustomEvent dual channel; extension bundles can also consume via the event) */
export function onBackendConnChange(listener: (state: BackendConnState) => void): () => void {
  connStateListeners.add(listener);
  return () => connStateListeners.delete(listener);
}

/** Most recently broadcast state (subscribers may have missed offline before attaching — check once when entering the banner) */
let lastConnState: BackendConnState | null = null;
export function getBackendConnState(): BackendConnState | null {
  return lastConnState;
}

function broadcastConnState(state: BackendConnState): void {
  if (lastConnState === state) return;
  lastConnState = state;
  connStateListeners.forEach((f) => { try { f(state); } catch { /* subscriber exceptions don't propagate */ } });
  // window event channel: for cross-bundle (extension client) consumption; silent in non-browser environments
  try {
    window.dispatchEvent(new CustomEvent("piwe-backend-conn", { detail: { state } }));
  } catch { /* non-browser */ }
}

/** Broker mount point on window (core and each extension client bundle share the same singleton) */
interface BrokerWindow {
  __runningEventsBroker?: RunningBroker | null;
  __piPageEventsClient?: {
    subscribePageFrames: typeof subscribePageFrames;
    /** Force an immediate rebuild of the shared connection (called by extensions on liveness timeout / half-dead connection; rebuilds at 0ms) */
    reconnectRunning: () => void;
  };
}

/** document listener that rebuilds suspect connections immediately on return to foreground (registered once, along with the first broker) */
let visibilityRelayWired = false;
function ensureVisibilityRelay(): void {
  if (visibilityRelayWired || typeof document === "undefined") return;
  visibilityRelayWired = true;
  document.addEventListener("visibilitychange", () => {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    const b = (window as BrokerWindow).__runningEventsBroker;
    if (!b || b.dead) return;
    const stale = b.connOffline
      || Date.now() - b.lastFrameAt >= HEARTBEAT_FRAME_TIMEOUT_MS
      || b.reconnectTimer != null;
    if (!stale) return; // connection healthy (briefly backgrounded and back), leave it alone
    if (b.reconnectTimer) clearTimeout(b.reconnectTimer);
    b.reconnectTimer = null;
    try { b.es?.close(); } catch { /* noop */ }
    b.es = null;
    b.connect();
  });
}

/** Connection-pool starvation yield (anti-deadlock): while starved, proactively close the shared
 *  connection to release the socket, and rebuild immediately on recovery.
 *  running/events is the most "yieldable" of the page's long-lived connections (safe to drop and
 *  reconnect), so release it first when starved.
 *  Goes through the window "piwe-conn-starve" event (conn-guard broadcast protocol, same channel
 *  as cross-bundle consumers like bridge-client; module-internal subscriptions cannot hear events
 *  broadcast manually by external tests/extensions). */
let connGuardRelayWired = false;
function ensureConnGuardRelay(): void {
  // Minimal environments (unit-test stub window with only dispatchEvent) have no event surface to attach to → skip silently; main path unaffected
  if (connGuardRelayWired || typeof window === "undefined"
    || typeof window.addEventListener !== "function") return;
  connGuardRelayWired = true;
  window.addEventListener("piwe-conn-starve", ((ev: CustomEvent<{ starved?: boolean }>) => {
    const starved = Boolean(ev.detail?.starved);
    const b = (window as BrokerWindow).__runningEventsBroker;
    if (!b || b.dead) return;
    if (starved) {
      if (b.reconnectTimer) clearTimeout(b.reconnectTimer);
      b.reconnectTimer = null;
      try { b.es?.close(); } catch { /* noop */ }
      b.es = null;
    } else if (!b.es && (b.listeners.size > 0 || b.frameListeners.size > 0)) {
      b.connect();
    }
  }) as EventListener);
}

export function subscribeRunningEvents(listener: Listener): () => void {
  const w = window as BrokerWindow;
  let b = w.__runningEventsBroker;
  if (!b) {
    b = w.__runningEventsBroker = {
      listeners: new Set<Listener>(),
      frameListeners: new Set<(frame: Record<string, unknown>) => void>(),
      es: null,
      dead: false,
      reconnectTimer: null,
      connFails: 0,
      connOffline: false,
      lastFrameAt: 0,
      frameWatchdog: null,
      connect: () => {
        // Refuse to connect during connection-pool starvation (anti-deadlock): avoid the
        // just-released socket being eaten right back by a long-lived connection;
        // recovery is handled by ensureConnGuardRelay's unstarve callback.
        if (isConnStarved()) return;
        // Heartbeat watchdog (event-driven, zero business polling): reset on every frame
        // (message/heartbeat); no frame at all within the timeout window = half-dead connection
        // / frozen by the browser in the background (EventSource stays OPEN but receives no data
        // and never fires onerror — the "silently dead connection" is exactly what kept
        // session-manager fallback-polling). When it fires, the watchdog proactively closes the
        // old connection and rebuilds, healing the half-dead connection so heartbeat/snapshot
        // frames flow again.
        const armFrameWatchdog = () => {
          if (b!.frameWatchdog) clearTimeout(b!.frameWatchdog);
          b!.frameWatchdog = setTimeout(() => {
            b!.frameWatchdog = null;
            if (b!.dead) return;
            if (Date.now() - b!.lastFrameAt >= HEARTBEAT_FRAME_TIMEOUT_MS) {
              try { b!.es?.close(); } catch { /* noop */ }
              b!.es = null;
              b!.connect();
            } else {
              armFrameWatchdog(); // a frame just arrived; the timer merely fired late — keep watching
            }
          }, HEARTBEAT_FRAME_TIMEOUT_MS);
        };
        const markFrame = () => {
          b!.lastFrameAt = Date.now();
          armFrameWatchdog();
        };
        if (b!.dead) return;
        try { b!.es?.close(); } catch { /* noop */ }
        // Unified SSE convergence for page events: when the bus capability is present (the
        // event-bus extension is deployed) → go through the single bus
        // (dispatch type "running", same transport-level named heartbeat contract); otherwise →
        // plain EventSource (fallback, current behavior).
        const busSource = getEventBus("/api/agent/running/events", { topic: "running" });
        const source: EventSource | BusEventSource = busSource
          ?? new EventSource(apiUrl("/api/agent/running/events"));
        b!.es = source;
        markFrame(); // seed the liveness baseline at connect so the watchdog's first pass doesn't misjudge
        // named event heartbeat (one frame every 30s from the server): dedicated to subscriber liveness checks
        source.addEventListener("heartbeat", () => {
          markFrame();
          b!.listeners.forEach((f) => { try { f("heartbeat", null); } catch { /* noop */ } });
          // Also delivered to frameListeners (the extension health clock depends on it). The
          // original contract gap meant that with a stable running set session-manager always
          // judged the SSE dead → continuous fallback polling of /api/agent/running.
          // Dedicated type=HEARTBEAT_FRAME_TYPE; consumers dispatch by type and ignore unknown types.
          b!.frameListeners.forEach((f) => { try { f({ type: HEARTBEAT_FRAME_TYPE, at: b!.lastFrameAt }); } catch { /* noop */ } });
        });
        source.onopen = () => {
          // Connection established = backend alive: clear the failure count; if a disconnect was
          // broadcast earlier → broadcast recovery.
          // lastConnState backstop: when the broker is destroyed after full unsubscribe and then
          // rebuilt, connOffline is lost with the old object, but module-level lastConnState may
          // still be offline — the first successful connection corrects it.
          b!.connFails = 0;
          markFrame();
          if (b!.connOffline || lastConnState === "offline") {
            b!.connOffline = false;
            broadcastConnState("online");
          }
        };
        source.onmessage = (e: MessageEvent) => {
          markFrame();
          let data: RunningFrame | null = null;
          try { data = JSON.parse((e as MessageEvent).data) as RunningFrame; } catch { /* malformed frame */ }
          b!.listeners.forEach((f) => { try { f("message", data, e as MessageEvent); } catch { /* noop */ } });
          if (data) b!.frameListeners.forEach((f) => { try { f(data as Record<string, unknown>); } catch { /* noop */ } });
        };
        source.onerror = () => {
          b!.listeners.forEach((f) => { try { f("error", null); } catch { /* noop */ } });
          // Disconnect judgment: >=2 consecutive failures (the first may be the restart just
          // cutting in-flight connections; the second comes from the rebuild loop being
          // refused/502 — at this point the backend is almost certainly gone) → broadcast offline
          b!.connFails++;
          if (b!.connFails >= 2 && !b!.connOffline) {
            b!.connOffline = true;
            broadcastConnState("offline");
          }
          // HTTP errors (502/503 during the restart window) flip EventSource to CLOSED — the
          // browser stops auto-retrying. Fallback-mode subscribers call reconnectRunningEvents
          // via their error callback as a backstop, but takeover-mode consumers (sidebar-dock via
          // subscribePageFrames) have no error callback; without a backstop they'd idle until
          // the 75s watchdog and the disconnect banner would linger long after the backend
          // recovers. Schedule the rebuild uniformly at the broker level (short delay prevents a
          // high-frequency 502 loop); recovery fires onopen immediately.
          if (b!.es === source && source.readyState === 2 /* CLOSED */) {
            reconnectRunningEvents(3000);
          }
        };
      },
    };
    b.connect();
    // Verify immediately on return to foreground (event-driven, zero polling): mobile background
    // freezing often kills EventSource into a "silently dead connection" — the browser never
    // fires onerror, the rebuild waits for the 75s watchdog, and the disconnect banner just hangs
    // there. On return to foreground, if disconnected / frames silent / reconnect still pending
    // on a delayed timer, close old and build new immediately: a successful onopen broadcasts
    // online → the disconnect banner drops right away instead of waiting for the heartbeat timeout.
    // (The listener reads the singleton dynamically; a leftover after broker destruction is
    // harmless; ensureVisibilityRelay prevents duplicate registration.)
    ensureVisibilityRelay();
    ensureConnGuardRelay();
  }
  b.listeners.add(listener);
  return () => {
    b.listeners.delete(listener);
    if (b.listeners.size === 0 && b.frameListeners.size === 0) {
      b.dead = true;
      if (b.reconnectTimer) clearTimeout(b.reconnectTimer);
      try { b.es?.close(); } catch { /* noop */ }
      w.__runningEventsBroker = null;
    }
  };
}

/** Called by subscribers when the broker connection enters CLOSED (EventSource no longer auto-reconnects): delayed rebuild */
export function reconnectRunningEvents(delayMs = 3000): void {
  const b = (window as BrokerWindow).__runningEventsBroker;
  if (!b || b.dead || b.reconnectTimer) return;
  b.reconnectTimer = setTimeout(() => {
    b.reconnectTimer = null;
    if (!b.dead && b.listeners.size > 0) b.connect();
  }, delayMs);
}

// ── Generic frame subscription (cross-extension shared connection)──────────────────────────
// Extensions/other consumers attach to the same connection via
// window.__piPageEventsClient.subscribePageFrames(handler): every message frame (JSON) is
// delivered verbatim to the handler (frame.type distinguishes the source:
// running / pf:remind / mc:avail / ed-watch ...); the named heartbeat frame is now also
// delivered as a { type: HEARTBEAT_FRAME_TYPE, at } frame (fixing the missing extension health
// clock feed); extensions dispatch by type and ignore unknown types, never tripping each other.
export function subscribePageFrames(handler: (frame: Record<string, unknown>) => void): () => void {
  const w = window as BrokerWindow;
  let b = w.__runningEventsBroker;
  if (!b) { subscribeRunningEvents(() => {}); b = w.__runningEventsBroker; }
  const listeners = b!.frameListeners as Set<(frame: Record<string, unknown>) => void>;
  listeners.add(handler);
  return () => listeners.delete(handler);
}


// Cross-extension browser-side entry point (plan-first / model-check / the file-editor extension and others share the connection through here)
if (typeof window !== "undefined") {
  (window as BrokerWindow).__piPageEventsClient = {
    subscribePageFrames,
    // On liveness timeout / half-dead connection, extensions can proactively rebuild the shared connection (0ms) to shorten self-healing time
    reconnectRunning: () => reconnectRunningEvents(0),
  };
}
