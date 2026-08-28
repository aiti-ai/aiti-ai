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
      // 用 named SSE event（非 message 帧）：宿主 SessionSidebar 监听它判活
      // （心跳静默才启用兑底轮询）；onmessage 消费方（session-manager 等）
      // 按规范收不到 named event，零影响、不会被误触发刷新。
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
      // 同 agent/[id]/events：禁 nginx 缓冲，否则心跳/快照小帧被攒着延迟送达，
      // 客户端判活与运行状态推送都会失灵
      "X-Accel-Buffering": "no",
    },
  });
}
