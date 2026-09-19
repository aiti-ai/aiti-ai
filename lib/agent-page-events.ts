// Page event stream (server-side broadcaster): the generalized carrier for /api/agent/running/events.
//
// The page's single event SSE (protection against HTTP/1.1's 6-connections-per-host limit —
// extensions/core used to open their own connections, and once ≥6 long-lived connections were
// open, media/random requests stayed pending forever and the whole page starved; observed in
// practice).
// Frame format: JSON message frames, the `type` field distinguishes the source:
//   running   → session running set (core)
//   pf:remind → plan-first reminders (the plan-first extension)
//   mc:avail  → model availability (the model-check extension)
//   ed-watch  → media file changes (the file-editor extension; frame carries id = watchId)
// In-process publishing by extensions: globalThis.__piPageEvents.publish(type, data)
// (instrumentation imports this module at startup to complete registration; same process as
// this module, zero socket overhead).

type PageFrame = Record<string, unknown> & { type: string };
const sinks = new Set<(frame: PageFrame) => void>();

export function publishPageEvent(type: string, data: Record<string, unknown> = {}): void {
  const frame: PageFrame = { type, ...data };
  for (const send of [...sinks]) {
    try { send(frame); } catch { sinks.delete(send); }
  }
}

/**
 * Wide publish: core sinks (fallback SSE / core route consumers) + the bus (if the event-bus
 * extension has taken over the globalThis slot). Server-side publishing for the unified SSE
 * goes through this function — calling publishPageEvent directly only reaches the module-level
 * sinks, bypassing the bus's takeover slot (what the bus takes over is exactly the slot's
 * wrapper). Double-dispatch guard: skipped when the slot is this module's own plain assignment
 * (bus absent — already published directly); in the accessor-wrapper case the wrapper's
 * "predecessor" may also be an instance of this module — duplicate frames would only land in
 * the core sinks (where the fallback client is not online, so no actual duplication), and the
 * bus side gets exactly one copy.
 */
export function publishPageEventToBus(type: string, data: Record<string, unknown> = {}): void {
  publishPageEvent(type, data);
  const slot = (globalThis as { __piPageEvents?: { publish: typeof publishPageEvent } }).__piPageEvents;
  if (slot?.publish && slot.publish !== publishPageEvent) {
    try { slot.publish(type, data); } catch { /* silently ignore when the bus is unreachable */ }
  }
}

export function addPageEventSink(send: (frame: PageFrame) => void): () => void {
  sinks.add(send);
  return () => sinks.delete(send);
}

// Extension publish entry point (direct in-process call on the server)
(globalThis as { __piPageEvents?: { publish: typeof publishPageEvent } }).__piPageEvents = { publish: publishPageEvent };
