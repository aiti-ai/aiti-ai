import {
  AGENT_EVENT_HEARTBEAT_MS,
  isEventIncludedInSnapshot,
  toClientAgentEvent,
  type AgentEventLike,
} from "./agent-event-wire.ts";
import { acquireSessionLivenessLease } from "./session-liveness.ts";
import { withoutMessageSignatures } from "./message-signatures.ts";

export interface AgentEventStreamSession {
  readonly isStreaming: boolean;
  readonly streamingMessage: unknown;
  isAlive?(): boolean;
  onEvent(listener: (event: AgentEventLike) => void): () => void;
  /** Busy state (same accounting as the /api/agent/running set, including busy states beyond isStreaming such as compaction/queued follow-up rounds).
   *  Optional: when absent, the connected frame falls back to isStreaming. */
  isRunning?(): boolean;
}

/**
 * Backpressure for one SSE connection. The client is often a phone: when it
 * stops reading (screen off, backgrounded tab, flaky network) every event we
 * keep enqueueing stays in this process.
 *
 *  - above STREAM_HIGH_WATER_MARK_BYTES we drop events a later event repairs
 *    (streaming deltas, partial tool output);
 *  - above the backlog limit we terminate the stream instead, so the client
 *    reconnects and re-snapshots.
 *
 * Measured before this: a single 24 MB command with a client that stopped
 * reading left 22.7 MB queued here, and that memory only comes back with a GC
 * this app never triggers (issue #923).
 *
 * The limit also has to absorb what a healthy client on a slow link has in
 * flight: one `read` of an image emits its base64 twice (the tool result's
 * `message_start` and `message_end`), and the second queues up while the first
 * one is still being written to the socket.
 */
const STREAM_HIGH_WATER_MARK_BYTES = 512 * 1024;
const DEFAULT_BACKLOG_LIMIT_BYTES = 16 * 1024 * 1024;
const BACKPRESSURE_LOG_INTERVAL_MS = 60_000;
let lastBackpressureLogAt = 0;

/**
 * How long `tool_execution_update` events wait to be coalesced. Each update
 * carries the tool's whole partial result, so only the latest one per tool call
 * matters: a codemode script publishes a snapshot of every call it made each
 * time one starts or ends, and bash streams its output tail per chunk. A burst
 * inside the window reaches the client as one event per tool call.
 */
export const TOOL_UPDATE_COALESCE_MS = 150;

/**
 * Whether a later event repairs this one if it is dropped. A `*_delta` only
 * extends a block that its `*_end` replaces with the authoritative content, and
 * `tool_execution_update` carries the whole partial result, which the next update
 * or `tool_execution_end` supersedes. `*_start` / `*_end` are never dropped: the
 * client's stream reducer creates and finalizes blocks from them.
 */
function isDroppableEvent(event: AgentEventLike): boolean {
  if (event.type === "tool_execution_update") return true;
  if (event.type !== "message_update") return false;
  const update = event.assistantMessageEvent;
  return typeof update === "object"
    && update !== null
    && typeof (update as { type?: unknown }).type === "string"
    && (update as { type: string }).type.endsWith("_delta");
}
function resolveBacklogLimitBytes(): number {
  const raw = Number(process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES);
  return Number.isFinite(raw) && raw >= 64 * 1024 ? raw : DEFAULT_BACKLOG_LIMIT_BYTES;
}

function logBackpressure(
  sessionId: string,
  queuedBytes: number,
  limitBytes: number,
  droppedEvents: number,
  closing: boolean,
): void {
  const now = Date.now();
  if (now - lastBackpressureLogAt < BACKPRESSURE_LOG_INTERVAL_MS) return;
  lastBackpressureLogAt = now;
  const queued = `${Math.round(queuedBytes / 1024)} KB`;
  console.warn(closing
    ? `[pi-web] Agent event stream for ${sessionId} closed: client backlog ${queued} exceeds ${Math.round(limitBytes / 1024)} KB; it reconnects and re-snapshots.`
    : `[pi-web] Agent event stream for ${sessionId} is behind (${queued} queued): dropping rebuildable deltas (${droppedEvents} so far).`);
}

/**
 * Registry of live SSE streams, closed from the SIGINT/SIGTERM hook in
 * instrumentation.ts.
 *
 * In production Next 16 handles those signals with `server.close()` and waits
 * for every connection to end, with no timeout and no `closeAllConnections`
 * (that call is dev-only in next/dist/server/lib/start-server.js). An SSE
 * stream only ends when the client disconnects, so without this the process
 * stops listening (502 upstream) but never exits.
 *
 * instrumentation.ts and the route handlers are bundled into separate module
 * graphs, each with its own copy of this module; a plain module-level Set
 * would be two disconnected registries. Symbol.for + globalThis shares one.
 */
const CLOSER_REGISTRY: symbol = Symbol.for("pi-web.agentEventStreamClosers");
type StreamCloser = (closeController: boolean | "error") => void;
const activeStreamClosers: Set<StreamCloser> =
  ((globalThis as Record<symbol, Set<StreamCloser>>)[CLOSER_REGISTRY] ??= new Set<StreamCloser>());

/** Close every live SSE stream (called on process shutdown signals). */
export function closeAllAgentEventStreams(): void {
  for (const close of [...activeStreamClosers]) {
    try { close("error"); } catch { /* stream already closed */ }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lazy (pending-start) session handle (2026-09-15):
 *
 * Opening a session page no longer cold-starts the full runtime (viewing alone shouldn't spin up an
 * agent); when no wrapper exists yet, this handle readies itself in an "idle" shape — SSE sends
 * connected immediately (otherwise the client's 60s readiness timeout would misjudge the session as
 * rejected); the real wrapper is brought up by later real interactions (send/steer etc.) and attaches
 * via the waitForSession callback, its events forwarded to the stream through this handle.
 *
 * Lifecycle: createAgentEventStream calls the unsubscribe returned by onEvent on stream cleanup;
 * this handle uses that to stop both the wait and the real subscription.
 */
export function createPendingAgentSessionHandle(
  waitForSession: (onReady: (session: AgentEventStreamSession) => void) => () => void,
): AgentEventStreamSession {
  const listeners = new Set<(event: AgentEventLike) => void>();
  let stopWaiting: (() => void) | null = null;
  let detach: (() => void) | null = null;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    stopWaiting?.();
    stopWaiting = null;
    detach?.();
    detach = null;
    listeners.clear();
  };

  const attach = (session: AgentEventStreamSession) => {
    if (released) return;
    detach = session.onEvent((event) => {
      for (const listener of listeners) {
        try { listener(event); } catch { /* one failing listener doesn't affect the others */ }
      }
    });
  };

  return {
    isStreaming: false,
    streamingMessage: undefined,
    // When the connected frame is served, nothing is really running (the session was opened just to view);
    // once the wrapper appears, its event stream carries agent_start/agent_settled and other state
    // frames, so no synthesis is needed here.
    isRunning: () => false,
    onEvent(listener) {
      if (released) return () => {};
      listeners.add(listener);
      if (!stopWaiting) stopWaiting = waitForSession(attach);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) release();
      };
    },
  };
}

/**
 * Open the SSE transport immediately, then publish the session snapshot only
 * after the agent is ready and its event listener has been installed.
 */
export function createAgentEventStream(
  req: Request,
  sessionId: string,
  sessionPromise: Promise<AgentEventStreamSession>,
): ReadableStream<Uint8Array> {
  let cancelStream: (closeController: boolean | "error") => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;
  let releaseLease: () => void = () => {}; // set when the session subscribes (fork liveness lease)
      let abortHandler: (() => void) | null = null;
      // Latest `tool_execution_update` per tool call id, waiting for the flush.
      const pendingToolUpdates = new Map<unknown, AgentEventLike>();
      let toolUpdateTimer: ReturnType<typeof setTimeout> | null = null;

      // "error": hard-terminate the response (SSE client sees a broken
      // stream and reconnects). Used on process shutdown: a plain close() is
      // swallowed by the Next/Node response pipeline without emitting a
      // chunked termination, so the socket stays ESTABLISHED and Next's
      // server.close() drain never completes (the original zombie bug).
      // Also used when a client stops consuming: a graceful close() there
      // would leave the socket (and the queued backlog) alive.
      // "true": graceful close after we finished writing a final event.
      const cleanup = (closeController: boolean | "error", reason?: Error) => {
        if (closed) return;
        closed = true;
        activeStreamClosers.delete(cleanup);
        if (heartbeat !== null) clearInterval(heartbeat);
        if (toolUpdateTimer !== null) clearTimeout(toolUpdateTimer);
        pendingToolUpdates.clear();
        releaseLease();
        unsubscribe?.();
        unsubscribe = null;
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        if (closeController === "error") {
          try { controller.error(reason ?? new Error("pi-web server shutting down")); } catch { /* already closed */ }
        } else if (closeController) {
          try { controller.close(); } catch { /* stream already closed */ }
        }
      };
      cancelStream = cleanup;
      // Fork: the stream holds a session-liveness lease while subscribed (the
      // idle reaper must not tear down a wrapper a visible page is watching).
      releaseLease = acquireSessionLivenessLease(sessionId).release;
      activeStreamClosers.add(cleanup);

      const backlogLimitBytes = resolveBacklogLimitBytes();
      let droppedEvents = 0;
      const enqueueText = (text: string, options?: { droppable?: boolean }) => {
        if (closed) return;
        const desiredSize = controller.desiredSize;
        if (desiredSize === null) {
          cleanup(false);
          return;
        }
        const queuedBytes = STREAM_HIGH_WATER_MARK_BYTES - desiredSize;
        if (options?.droppable && queuedBytes > STREAM_HIGH_WATER_MARK_BYTES) {
          droppedEvents += 1;
          logBackpressure(sessionId, queuedBytes, backlogLimitBytes, droppedEvents, false);
          return;
        }
        if (queuedBytes > backlogLimitBytes) {
          logBackpressure(sessionId, queuedBytes, backlogLimitBytes, droppedEvents, true);
          cleanup(
            "error",
            new Error(`pi-web agent event stream closed: client backlog exceeded ${Math.round(backlogLimitBytes / 1024)} KB`),
          );
          return;
        }
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup(false);
        }
      };
      const encode = (data: unknown, options?: { droppable?: boolean }) => {
        enqueueText(`data: ${JSON.stringify(data)}\n\n`, options);
      };
      const flushToolUpdates = () => {
        toolUpdateTimer = null;
        const updates = [...pendingToolUpdates.values()];
        pendingToolUpdates.clear();
        for (const update of updates) encode(update, { droppable: true });
      };
      const sendClientEvent = (clientEvent: AgentEventLike) => {
        if (clientEvent.type === "tool_execution_update") {
          pendingToolUpdates.set(clientEvent.toolCallId, clientEvent);
          toolUpdateTimer ??= setTimeout(flushToolUpdates, TOOL_UPDATE_COALESCE_MS);
          return;
        }
        // The end supersedes a partial result still waiting here, and the client
        // would treat one arriving after the end as a tool that is running again.
        // agent_end does the same for any tool call whose end never came.
        if (clientEvent.type === "tool_execution_end") {
          pendingToolUpdates.delete(clientEvent.toolCallId);
        } else if (clientEvent.type === "agent_end") {
          pendingToolUpdates.clear();
        }
        encode(clientEvent, { droppable: isDroppableEvent(clientEvent) });
      };
      const forwardEvent = (event: AgentEventLike, snapshot: unknown) => {
        if (isEventIncludedInSnapshot(event, snapshot)) return;
        const clientEvent = toClientAgentEvent(event);
        if (clientEvent) {
          // Deep-clone message_start events to prevent the shared .content array
          // (shallow-copied from the agent's live partialMessage) from being mutated
          // by subsequent thinking_delta events before JSON.stringify serializes it.
          const safeEvent = clientEvent.type === "message_start"
            ? { ...clientEvent, message: structuredClone(clientEvent.message) }
            : clientEvent;
          sendClientEvent(safeEvent);
        }
      };

      const publishSession = async () => {
        try {
          const session = await sessionPromise;
          if (closed) return;
          if (session.isAlive && !session.isAlive()) {
            cleanup(true);
            return;
          }

          const bufferedEvents: AgentEventLike[] = [];
          let snapshotPublished = false;
          const handleEvent = (event: AgentEventLike) => {
            if (event.type === "session_shutdown") {
              cleanup(true);
              return;
            }
            if (!snapshotPublished) {
              bufferedEvents.push(event);
              return;
            }
            forwardEvent(event, snapshot);
          };

          const stopListening = session.onEvent(handleEvent);
          if (closed) {
            stopListening();
            return;
          }
          if (session.isAlive && !session.isAlive()) {
            stopListening();
            cleanup(true);
            return;
          }
          unsubscribe = stopListening;

          // Deep-clone the snapshot to decouple from the live streamingMessage
          // whose .content array is shared with the agent's partialMessage and
          // gets mutated in-place by subsequent thinking_delta events.
          const rawSnapshot = session.streamingMessage;
          const snapshot = (rawSnapshot !== undefined && rawSnapshot !== null)
            ? withoutMessageSignatures(structuredClone(rawSnapshot))
            : rawSnapshot;
          // Canonical id echo: when the handle resolved from an alias/placeholder id (zcode:new-* etc.)
          // has been rebound to the real composite id, tell the client via the connected frame —
          // session_backend_ready is a one-shot event and streams that (re)connect after the rebind
          // miss it forever, leaving the client pinned to the alias id (the sidebar would show two
          // rows for the same session: the real one + the draft one). The wrapper carries sessionId,
          // the extension handle carries id; echo only when obtainable and different from the requested id.
          const asIded = session as { sessionId?: unknown; id?: unknown };
          const canonicalId = typeof asIded.sessionId === "string" && asIded.sessionId
            ? asIded.sessionId
            : typeof asIded.id === "string" && asIded.id ? asIded.id : undefined;
          encode({
            type: "connected",
            sessionId,
            ...(canonicalId && canonicalId !== sessionId ? { canonicalSessionId: canonicalId } : {}),
            isStreaming: session.isStreaming,
            // Lets the frontend restore the "running" state immediately on reconnect/new page — isStreaming
            // misses busy states such as mid-compaction (a manual compact aborts first, the run is no longer
            // active), which would render as "shown as not running".
            isRunning: session.isRunning?.() ?? session.isStreaming,
            // onEvent() has just replayed every request the session still holds,
            // so a reconnecting client can drop the ones closed while it was away.
            pendingExtensionUiIds: bufferedEvents
              .filter((event) => event.type === "extension_ui_request" && typeof event.id === "string")
              .map((event) => event.id as string),
          });
          // [Root-cause fix for duplicated first characters] Events in the buffer (arriving between
          // listener installation and snapshot publication) are already fully reflected in the snapshot
          // (a clone of the live partialMessage): pi applies deltas to partialMessage before emitting
          // message_update. If the buffer were replayed first and the snapshot sent after, the frontend
          // would stitch the replayed deltas, then get overwritten by the snapshot, then stitch the
          // rAF-flushed batch deltas on top of the snapshot → duplicated content at the start of the
          // stream ("duplicated first letter/word"), only corrected by the full overwrite at
          // thinking_end/text_end. Therefore: with a snapshot present, only non-content events are
          // replayed (state events like agent_start); content events (message_update/message_start)
          // always defer to the snapshot; only when there is no snapshot (streamingMessage not yet
          // established) is the buffer replayed to rebuild.
          if (snapshot !== undefined && snapshot !== null) {
            for (const event of bufferedEvents) {
              if (event.type === "message_update" || event.type === "message_start") continue;
              forwardEvent(event, rawSnapshot);
            }
            encode({ type: "message_start", message: snapshot });
          } else {
            for (const event of bufferedEvents) forwardEvent(event, rawSnapshot);
          }
          snapshotPublished = true;
        } catch (error) {
          if (closed) return;
          encode({
            type: "startup_error",
            errorMessage: `Failed to start agent: ${errorMessage(error)}`,
          });
          cleanup(true);
        }
      };

      // Attach the rejection handler before checking the request signal. The
      // route may already have started a shared cold-start promise.
      void publishSession();

      abortHandler = () => cleanup(true);
      if (req.signal.aborted) {
        cleanup(true);
        return;
      }
      req.signal.addEventListener("abort", abortHandler, { once: true });

      // The heartbeat must be a perceivable data event, not a comment line: comment lines (":\n\n")
      // don't trigger EventSource.onmessage, so the client can't use them to judge channel liveness
      // and would fall back to high-frequency state polling. A data event lets the client reliably
      // treat "silence past the threshold" as a dead channel. droppable (upstream): under backpressure
      // the heartbeat is the first thing to drop — liveness resumes with the next real event.
      // (Event type "heartbeat" per upstream; the fork's AgentEventConnection refreshes its
      // activity stamp on it just the same.)
      heartbeat = setInterval(() => encode({ type: "heartbeat" }, { droppable: true }), AGENT_EVENT_HEARTBEAT_MS);

      // Force the response headers through without claiming that the agent is
      // ready. The client waits for the later `connected` data event.
      enqueueText(":\n\n");
    },
    cancel() {
      cancelStream(false);
    },
  }, {
    highWaterMark: STREAM_HIGH_WATER_MARK_BYTES,
    size: (chunk) => chunk.byteLength,
  });
}
