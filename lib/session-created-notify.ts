import { publishPageEventToBus } from "./agent-page-events.ts";

/**
 * Broadcast when a session file/session id is created (or is about to be) — the sidebar
 * session-manager draft row becomes visible immediately (the pendingDraft channel),
 * without relying on a running frame or the host refreshKey riding along.
 *
 * cwd lets the frontend group the draft row under the correct project; origin marks the
 * creation path for easier debugging; repeated broadcasts are idempotent (consumers
 * dedupe by sessionId).
 *
 * ⚠ Must go through publishPageEventToBus (wide publish): calling publishPageEvent
 * directly only reaches core sinks in the local realm; across realms (Turbopack module
 * splitting) it never reaches the event-bus extension's bus — and the session-manager's
 * frame source is exactly that bus. See docs/todo-session-created-sidebar-notify.md §1.1
 * in the workspace docs for measured details.
 */
export function notifySessionCreated(sessionId: string, cwd: string, origin?: string): void {
  try {
    publishPageEventToBus("sm:session-created", { sessionId, cwd, ...(origin ? { origin } : {}) });
  } catch { /* A failed broadcast must not block creation */ }
}
