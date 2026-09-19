import { getRunningRpcSessionIds, subscribeRunningSessions } from "@/lib/rpc-manager";
import { getRunningHandleIds, subscribeRunningHandles } from "@/lib/session/handle-store";
import { getBridgeRunningIds, subscribeBridgeRunning } from "@/lib/session/bridge-running";
// publishRunning must be imported directly by this module (not via globalThis.__piPageEvents):
// in the prod build, instrumentation and routes split into separate module-graph realms
// (see the same warning at the top of lib/rpc-manager.ts); the route realm's globalThis
// has no global slot → optional chaining silently swallows frames. Symptom evidence
// (2026-09-09, the Windows /win instance): SSE had only heartbeats while running frames
// (including the initial snapshot on connect) were all lost, and the heartbeats kept
// every client liveness fallback fed → the sidebar's running state froze until the
// next refresh. The direct import and addPageEventSink below share one module instance,
// so the sink sets are guaranteed identical.
import { addPageEventSink, publishPageEvent } from "@/lib/agent-page-events";

export const dynamic = "force-dynamic";

/** The merged full running set (local rpc + handle backends + TUI bridge unclaimed listeners); any change pushes the merged set (docs §2.2/§5). */
function mergedRunningIds(): string[] {
  return [...new Set([...getRunningRpcSessionIds(), ...getRunningHandleIds(), ...getBridgeRunningIds()])];
}

// GET /api/agent/running/events - the page-wide single event SSE (generalized carrier):
//   - `running` frames: the session running set (pushed on any session start/stop, so
//     the sidebar needs no polling)
//   - extension frames: plan-first pf:remind / model-check mc:avail / editor ed-watch…
//     (extensions publish in-process via globalThis.__piPageEvents.publish(type, data),
//     zero sockets)
// The heartbeat is a named SSE event (not a message frame): SessionSidebar listens to
// it for liveness; consumers of the other message frames dispatch on the type field
// and don't trigger each other.
export async function GET(req: Request) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // Register with the page event bus: all frames (running + extension frames) go through this one connection
      const unsubSink = addPageEventSink((frame) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        } catch {
          // controller already closed
        }
      });

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription.
      const onRunningChange = () => {
        publishRunning();
      };
      // running frame: call publishPageEvent directly — it only reaches core sinks in
      // this module's graph, i.e. SSE clients connected directly to this route (kept
      // for compatibility). The cross-surface main channel (event bus) gets its running
      // frame from lib/running-broadcast.ts (decoupled from connection lifecycles,
      // 2026-09-15); publishing broadly here as well would double-deliver to the bus,
      // hence no broad publish.
      const publishRunning = () => {
        publishPageEvent("running", { runningSessionIds: mergedRunningIds() });
      };
      const unsubRpc = subscribeRunningSessions(onRunningChange);
      const unsubHandle = subscribeRunningHandles(onRunningChange);
      const unsubBridge = subscribeBridgeRunning(onRunningChange);
      const unsubscribe = () => { unsubRpc(); unsubHandle(); unsubBridge(); };

      // Initial snapshot so the client renders the correct state immediately.
      publishRunning();

      // Heartbeat to keep the connection alive through proxies/timeouts.
      // A named SSE event (not a message frame): the host SessionSidebar listens to it for liveness
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("event: heartbeat\ndata: {}\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        unsubSink();
        try { controller.close(); } catch { /* already closed */ }
      };

      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Same as agent/[id]/events: disable nginx buffering, otherwise heartbeat/snapshot
      // small frames get buffered and delayed, breaking both client liveness and
      // running-state pushes
      "X-Accel-Buffering": "no",
    },
  });
}
