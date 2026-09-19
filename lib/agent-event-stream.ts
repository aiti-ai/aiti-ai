import {
  isEventIncludedInSnapshot,
  toClientAgentEvent,
  type AgentEventLike,
} from "./agent-event-wire";
import { acquireSessionLivenessLease } from "./session-liveness";

export interface AgentEventStreamSession {
  readonly isStreaming: boolean;
  readonly streamingMessage: unknown;
  isAlive?(): boolean;
  onEvent(listener: (event: AgentEventLike) => void): () => void;
  /** Busy state (same accounting as the /api/agent/running set, including busy states beyond isStreaming such as compaction/queued follow-up rounds).
   *  Optional: when absent, the connected frame falls back to isStreaming. */
  isRunning?(): boolean;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

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
  let releaseLease: () => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      // "error": hard-terminate the response (SSE client sees a broken
      // stream and reconnects). Used on process shutdown: a plain close() is
      // swallowed by the Next/Node response pipeline without emitting a
      // chunked termination, so the socket stays ESTABLISHED and Next's
      // server.close() drain never completes (the original zombie bug).
      // "true": graceful close after we finished writing a final event.
      const cleanup = (closeController: boolean | "error") => {
        if (closed) return;
        closed = true;
        releaseLease();
        releaseLease = () => {};
        activeStreamClosers.delete(cleanup);
        if (heartbeat !== null) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = null;
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        if (closeController === "error") {
          try { controller.error(new Error("pi-web server shutting down")); } catch { /* already closed */ }
        } else if (closeController) {
          try { controller.close(); } catch { /* stream already closed */ }
        }
      };
      cancelStream = cleanup;
      releaseLease = acquireSessionLivenessLease(sessionId).release;
      activeStreamClosers.add(cleanup);

      const enqueueText = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup(false);
        }
      };
      const encode = (data: unknown) => {
        enqueueText(`data: ${JSON.stringify(data)}\n\n`);
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
          encode(safeEvent);
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
            ? structuredClone(rawSnapshot)
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
      // treat "silence past the threshold" as a dead channel.
      heartbeat = setInterval(() => encode({ type: "ping", ts: Date.now() }), HEARTBEAT_INTERVAL_MS);

      // Force the response headers through without claiming that the agent is
      // ready. The client waits for the later `connected` data event.
      enqueueText(":\n\n");
    },
    cancel() {
      cancelStream(false);
    },
  });
}
