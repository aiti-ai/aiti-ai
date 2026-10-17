// The core host's standard bus entry point: getEventBus(route) (the single SSE convergence for page events).
//
// Background: browsers allow only ~6 concurrent HTTP/1.1 connections per host; running/events,
// agent/[id]/events, terminal/[id]/events and files watch each open their own connection
// (extension page events already converge onto the event bus — decided 2026-09-09), and stacked
// together they can still exhaust the quota. This factory converges the core's SSE channels onto
// the same bus: when the bus capability is present (the event-bus extension deployed,
// window.__piEventBus set) → a single SSE by dispatch type; when it is ultimately absent → the
// adapter flips to CLOSED + a one-shot onerror, and callers fall back to a plain
// EventSource(route) per their own retry semantics.
//
// Frame protocol (bus dispatch convention): the server publishes
// { type: <topic>, evt?: "<original event type>", ...payload }; this adapter reassembles frames
// back into the original SSE frame shape ({type: evt, ...payload}):
//   - no evt (e.g. running frames verbatim) → data = the whole frame, via onmessage
//   - with evt (terminal output/exit, file connected/change, agent business frames) →
//     data = {type: evt, ...payload}, dispatching both onmessage and the named event <evt>
//     (callers may use onmessage or addEventListener("change",...) — equivalent to the original SSE)
// The bus transport's named heartbeat (30s) → dispatches named "heartbeat" (for running broker liveness).

import { eventBusDeployedVerdict, onEventBusDeployed, settleEventBusDeployed } from "./ext-boot-signal.ts";

// Re-export the event-bus deployment verdict within the same module graph: the setter (ExtSlots),
// consumers, and tests all drive it in one module graph.
// Verdict semantics: the event-bus extension listed in the manifest = installed and enabled
// (disabled extensions do not enter the manifest).
export { settleEventBusDeployed, eventBusDeployedVerdict, onEventBusDeployed };

export const BUS_FRAME_HEARTBEAT = "heartbeat";

/** Common surface shared with lib/agent-event-connection.ts's AgentEventSourceLike / the native EventSource */
export interface BusEventSource {
  readonly readyState: number; // 0 CONNECTING / 1 OPEN / 2 CLOSED (simulated semantics)
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
  /** Dispatch a named event (used by the connect semantics wrapped in the adapter: e.g. a
   *  file-watch ticket succeeding → "connected").
   *  Not a frame-dispatch channel — ordinary subscribers only use addEventListener/onmessage. */
  dispatchNamed(name: string, data: unknown): void;
}

interface PiEventBusSlot {
  /** Topic subscription on the event-bus extension's client broker (same singleton, shared through the extension ctx registration surface) */
  subscribeTopics(
    handler: (frame: Record<string, unknown>) => void,
    types: string[],
    onStatus?: (status: "up" | "down" | "reconnecting") => void,
    /** [page-events plan §7] server named heartbeat (30s) — for liveness checks, not dispatched into frames */
    onHeartbeat?: () => void,
  ): { ready: Promise<void>; off: () => void };
}

interface EventBusWindow {
  __piEventBus?: PiEventBusSlot;
}

export interface GetEventBusOptions {
  /** Dispatch type (bus topic). Defaults to being derived from route: /api/xxx/y → "xxx-y". */
  topic?: string;
  /**
   * Pre-action before the bus is ready (e.g. the agent-session attach POST — channels with
   * connection side effects must complete server-side registration before the subscription
   * takes effect). On failure a startup_error frame is delivered via onmessage
   * (AgentEventConnection protocol frame, semantics: do not retry).
   */
  onSetup?: () => Promise<void>;
}

function topicFromRoute(route: string): string {
  const path = route.replace(/^\//, "").split("?")[0].replace(/\[|\]/g, "");
  return path.split("/").filter(Boolean).join("-");
}

function readSlot(): PiEventBusSlot | null {
  if (typeof window === "undefined") return null;
  const bus = (window as unknown as EventBusWindow).__piEventBus;
  return bus?.subscribeTopics ? bus : null;
}

/** Bus-absent verdict: slot still unseen after the wait window is exhausted → set. From then on
 *  getEventBus returns null directly, so callers' existing "?? new EventSource / if (!bus)" plain
 *  SSE fallback actually engages (otherwise the adapter is always truthy and the fallback branch
 *  is dead code — deployments without the event-bus extension could never connect).
 *  Reset when the bus registers (piwe-event-bus-ready); new connections then switch back to the
 *  bus channel automatically. */
let busAbsent = false;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // Reset scenario: the bus is enabled mid-session (not deployed → installed, or an early
  // misjudgment). Subsequent getEventBus probes go through the bus again; already-fallbacked
  // native connections switch back automatically on their next reconnect via each caller's
  // existing reconnect semantics (reconnect re-runs the getEventBus probe).
  window.addEventListener("piwe-event-bus-ready", () => { busAbsent = false; });
}

/**
 * Returns the bus adapter (EventSource-compatible surface); if the bus capability is ultimately
 * absent → the adapter flips to CLOSED and fires one onerror, and callers fall back to the plain
 * SSE per their retry semantics (the next connect re-probes — once the bus becomes ready it
 * switches back to the bus channel automatically).
 */
export function getEventBus(route: string, opts: GetEventBusOptions = {}): BusEventSource | null {
  if (typeof window === "undefined") return null;
  // Deployment verdict = not deployed (event-bus extension absent from the manifest) → the only synchronous fallback condition (callers use native SSE)
  if (eventBusDeployedVerdict() === false) busAbsent = true;
  if (busAbsent && !readSlot()) return null;
  const topic = opts.topic ?? topicFromRoute(route);
  const slot = readSlot();

  // ── Adapter state (shared across the connection lifecycle) ──
  const CONNECTING = 0, OPEN = 1, CLOSED = 2;
  let readyState: number = CONNECTING;
  let closed = false;
  let subscribed = false;
  let off: (() => void) | null = null;

  const messageListeners = new Set<(e: MessageEvent<string>) => void>();
  const namedListeners = new Map<string, Set<(e: MessageEvent<string>) => void>>();
  // onmessage is EventSource's property-style handle (subscribers assign bus.onmessage = fn
  // directly), so it goes into no set — it must be stored separately and invoked in emitMessage.
  // This was once mis-wired: the assignment landed on a plain data property, and in bus mode
  // data frames never reached the subscriber (named events/heartbeat/onopen all worked — very
  // hard to notice).
  let onmessageHandler: ((event: MessageEvent<string>) => void) | null = null;

  const emitMessage = (data: string) => {
    const event = new MessageEvent("message", { data });
    for (const fn of [...messageListeners]) {
      try { fn(event); } catch { /* subscriber exceptions don't propagate */ }
    }
    try { onmessageHandler?.(event); } catch { /* noop */ }
  };
  const emitNamed = (name: string, data: string) => {
    for (const fn of [...(namedListeners.get(name) ?? [])]) {
      try { fn(new MessageEvent(name, { data })); } catch { /* subscriber exceptions don't propagate */ }
    }
  };
  const fireError = () => {
    try { adapter.onerror?.(new Event("error")); } catch { /* noop */ }
  };

  const adapter: BusEventSource = {
    get readyState() { return readyState; },
    get onmessage() { return onmessageHandler; },
    set onmessage(fn: ((event: MessageEvent<string>) => void) | null) { onmessageHandler = fn; },
    onerror: null,
    onopen: null,
    addEventListener(type, listener) {
      if (!namedListeners.has(type)) namedListeners.set(type, new Set());
      namedListeners.get(type)!.add(listener);
    },
    dispatchNamed(name, data) {
      emitNamed(name, JSON.stringify(data ?? {}));
    },
    close() {
      if (closed) return;
      closed = true;
      readyState = CLOSED;
      try { off?.(); } catch { /* noop */ }
      off = null;
      messageListeners.clear();
      namedListeners.clear();
    },
  };

  // Dispatch: frame {type: topic, evt?, ...payload} → reassembled to the original shape, then onmessage + named
  const handler = (frame: Record<string, unknown>) => {
    if (closed) return;
    const { evt, ...payload } = frame as { evt?: string };
    // Spread order: type: evt must be written after the payload — otherwise the leftover topic
    // type inside the payload would overwrite evt (the reassembled product's type would wrongly
    // become the topic, and subscribers dispatching by evt would all miss)
    const data = evt !== undefined
      ? JSON.stringify({ ...payload, type: evt })
      : JSON.stringify(frame);
    emitMessage(data);
    if (evt !== undefined) emitNamed(evt, data);
  };

  const onStatus = (status: "up" | "down" | "reconnecting") => {
    if (closed) return;
    if (status === "up") {
      if (readyState !== OPEN) {
        readyState = OPEN;
        try { adapter.onopen?.(new Event("open")); } catch { /* noop */ }
      }
      return;
    }
    // down / reconnecting: one-shot onerror (the broker auto-reconnects; recovery to up fires onopen again)
    if (readyState === OPEN) {
      readyState = CONNECTING;
      fireError();
    }
  };

  const beginSubscribe = (busSlot: PiEventBusSlot) => {
    if (closed || subscribed) return;
    subscribed = true;
    void (async () => {
      if (opts.onSetup) {
        try {
          await opts.onSetup();
        } catch (e) {
          if (closed) return;
          closed = true;
          readyState = CLOSED;
          const message = e instanceof Error ? e.message : String(e);
          // startup_error protocol frame (AgentEventConnection semantics: do not retry)
          emitMessage(JSON.stringify({ type: "startup_error", errorMessage: message }));
          return;
        }
      }
      if (closed) return;
      // [page-events plan §7] heartbeat passthrough: deliver the bus transport's named heartbeat
      // (30s) to this adapter's named subscribers (the running broker listens for "heartbeat" →
      // markFrame → the 75s frame watchdog no longer misjudges a half-dead connection; the
      // session-manager health clock recovers in sync). Before the fix the bus client swallowed
      // this frame, causing a close+connect teardown of the page-wide shared SSE every 75s and
      // triggering fallback polling.
      const sub = busSlot.subscribeTopics(handler, [topic], onStatus, () => {
        try { emitNamed(BUS_FRAME_HEARTBEAT, "{}"); } catch { /* subscriber exceptions don't propagate */ }
      });
      off = sub.off;
      try {
        await sub.ready;
      } catch {
        // Bus unreachable: flip to CLOSED + one-shot onerror (caller falls back to the plain SSE; next connect re-probes)
        if (!closed) {
          closed = true;
          readyState = CLOSED;
          fireError();
        }
        return;
      }
      if (closed) return;
      readyState = OPEN;
      try { adapter.onopen?.(new Event("open")); } catch { /* noop */ }
    })();
  };

  if (slot) {
    beginSubscribe(slot);
    return adapter;
  }

  // Slot not mounted (loader lazy-load race / host component materializing before the extension):
  // **queue and wait, do not fall back**
  // (unified SSE port plan v2 §3-C, user decision: code that wants the bus enters the queue and
  // is connected uniformly once the bus is ready).
  // Two mutually exclusive wait sources, decided as:
  //   1. piwe-event-bus-ready broadcast (client register mounts the slot) → onto the bus
  //   2. onEventBusDeployed(false) (manifest verdict: not deployed) → flip to CLOSED + one-shot
  //      onerror (callers fall back to native SSE per their own contracts)
  // When deployed (verdict true/unknown) there is no timeout give-up — deployed = usable is the
  // platform contract, so wait until register; meanwhile the adapter stays CONNECTING (callers
  // treat it as connecting and will not open a separate native EventSource).
  if (typeof window.addEventListener !== "function") {
    // Minimal environments without an event surface (unit-test stubs etc.): nothing to wait on or mount the slot with, verdict absent immediately
    busAbsent = true;
    return null;
  }
  const markAbsent = () => {
    busAbsent = true;
    closed = true;
    readyState = CLOSED;
    fireError();
    messageListeners.clear();
    namedListeners.clear();
  };
  const onReady = () => {
    const s = readSlot();
    if (!s) return; // slot absent at broadcast time (abnormal ordering): keep waiting
    cleanupWait();
    beginSubscribe(s);
  };
  const onVerdict = (deployed: boolean) => {
    if (deployed) return; // verdict = deployed: keep waiting for ready (the queue stays intact)
    cleanupWait();
    if (!closed) markAbsent();
  };
  let unwaitDeployed: () => void = () => {}; // placeholder: cleanupWait must already be usable when onEventBusDeployed calls back synchronously
  const cleanupWait = () => {
    window.removeEventListener("piwe-event-bus-ready", onReady);
    unwaitDeployed();
  };
  window.addEventListener("piwe-event-bus-ready", onReady);
  unwaitDeployed = onEventBusDeployed(onVerdict);
  const originalClose = adapter.close.bind(adapter);
  adapter.close = () => {
    cleanupWait();
    originalClose();
  };
  return adapter;
}

/** Bus capability probe (for subscribers deciding UI hints / degradation semantics) */
export function hasEventBus(): boolean {
  if (typeof window === "undefined") return false;
  const bus = (window as unknown as EventBusWindow).__piEventBus;
  return typeof bus?.subscribeTopics === "function";
}

declare global {
  interface Window {
    __piEventBus?: PiEventBusSlot;
  }
}
