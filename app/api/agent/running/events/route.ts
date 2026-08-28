import { getRunningRpcSessionIds, subscribeRunningSessions } from "@/lib/rpc-manager";
import { getRunningHandleIds, subscribeRunningHandles } from "@/lib/session/handle-store";
import { getBridgeRunningIds, subscribeBridgeRunning } from "@/lib/session/bridge-running";

export const dynamic = "force-dynamic";

/** 合并后的完整运行集（local rpc + handle 后端 + TUI 桥未认领监听），任一变化都推合并集（文档 §2.2/§5）。 */
function mergedRunningIds(): string[] {
  return [...new Set([...getRunningRpcSessionIds(), ...getRunningHandleIds(), ...getBridgeRunningIds()])];
}

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Pushes an update whenever any session starts or stops working,
// so the sidebar never has to poll.
export async function GET(req: Request) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription.
      const unsubRpc = subscribeRunningSessions(() => {
        try {
          encode({ type: "running", runningSessionIds: mergedRunningIds() });
        } catch {
          // controller already closed
        }
      });
      const unsubHandle = subscribeRunningHandles(() => {
        try {
          encode({ type: "running", runningSessionIds: mergedRunningIds() });
        } catch {
          // controller already closed
        }
      });
      const unsubBridge = subscribeBridgeRunning(() => {
        try {
          encode({ type: "running", runningSessionIds: mergedRunningIds() });
        } catch {
          // controller already closed
        }
      });
      const unsubscribe = () => { unsubRpc(); unsubHandle(); unsubBridge(); };

      // Initial snapshot so the client renders the correct state immediately.
      encode({ type: "running", runningSessionIds: mergedRunningIds() });

      // Heartbeat to keep the connection alive through proxies/timeouts.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
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
    },
  });
}
