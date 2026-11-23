/**
 * Event-driven "wait until a live session exists" helper for a session id.
 *
 * Covers BOTH worlds the API routes resolve sessions from:
 *
 *   local runtime (rpc-manager)     → running-set broadcast
 *   provider handles (handle-store) → store-change broadcast (registration)
 *
 * Used by the agent SSE route: opening a cold provider-owned session (pi spawn
 * backend, external driver) must not start a process just to stream. The stream
 * stays pending and attaches as soon as a real interaction creates the backend
 * handle (prompt / steer / explicit start) — no polling, no readiness timeout.
 */
import type { AgentEventStreamSession } from "../agent-event-stream.ts";
import { getRpcSession, subscribeRunningSessions } from "../rpc-manager.ts";
import { subscribeHandleStore } from "./handle-store.ts";
import { HandleSessionAdapter, findAliveHandleById } from "./index.ts";

/**
 * Call onReady exactly once, as soon as a live session for `id` exists.
 * Returns an unsubscribe function that stops waiting.
 */
export function waitForLiveSessionById(
  id: string,
  onReady: (session: AgentEventStreamSession) => void,
): () => void {
  let stopped = false;
  const cleanups: Array<() => void> = [];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const cleanup of cleanups.splice(0)) {
      try { cleanup(); } catch { /* best effort */ }
    }
  };
  const deliver = (session: AgentEventStreamSession | undefined) => {
    if (stopped || !session) return;
    if (typeof session.isAlive === "function" && !session.isAlive()) return;
    stop();
    onReady(session);
  };
  const check = () => {
    if (stopped) return;
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      deliver(rpc);
      return;
    }
    const handle = findAliveHandleById(id);
    // HandleSessionAdapter is the WrappedSessionLike view of a handle; its
    // onEvent/isRunning surface is the same contract the SSE stream consumes.
    if (handle) deliver(new HandleSessionAdapter(handle) as unknown as AgentEventStreamSession);
  };
  cleanups.push(subscribeRunningSessions(check));
  cleanups.push(subscribeHandleStore(check));
  // Closes the "already live before subscribing" window.
  check();
  return stop;
}
