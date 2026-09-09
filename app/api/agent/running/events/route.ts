import { getRunningRpcSessionIds, subscribeRunningSessions } from "@/lib/rpc-manager";
import { getRunningHandleIds, subscribeRunningHandles } from "@/lib/session/handle-store";
import { getBridgeRunningIds, subscribeBridgeRunning } from "@/lib/session/bridge-running";
// publishRunning 必须走本模块直接 import（不可经 globalThis.__piPageEvents）：
// prod 构建下 instrumentation 与路由的模块图 realm 分裂（见 lib/rpc-manager.ts 顶部
// 同款警告），路由 realm 的 globalThis 上没有全局槽 → 可选链静默吞帧。症状实证
// （2026-09-09，155 /win）：SSE 只有心跳、running 帧（含连接初始快照）全丢，
// 心跳又喂活了客户端全部判活兜底 → 侧栏运行中状态冻结到下次刷新。
// 直接 import 与下方 addPageEventSink 同模块实例，sink 集合必然一致。
import { addPageEventSink, publishPageEvent } from "@/lib/agent-page-events";

export const dynamic = "force-dynamic";

/** 合并后的完整运行集（local rpc + handle 后端 + TUI 桥未认领监听），任一变化都推合并集（文档 §2.2/§5）。 */
function mergedRunningIds(): string[] {
  return [...new Set([...getRunningRpcSessionIds(), ...getRunningHandleIds(), ...getBridgeRunningIds()])];
}

// GET /api/agent/running/events - 全页唯一事件 SSE（泛化承载）：
//   - `running` 帧：会话运行集（任一会话 start/stop 即推，侧栏免轮询）
//   - 扩展帧：plan-first pf:remind / model-check mc:avail / aiti-editor ed-watch…
//     （扩展经 globalThis.__piPageEvents.publish(type, data) 进程内发布，零 socket）
// 心跳用 named SSE event（非 message 帧）：SessionSidebar 监听它判活；
// 其余 message 帧消费方按 type 字段分发，互不误触。
export async function GET(req: Request) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // 注册到页面事件总线：所有帧（running + 扩展帧）统一走这条连接
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
      // 用 named SSE event（非 message 帧）：宿主 SessionSidebar 监听它判活
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
      // 同 agent/[id]/events：禁 nginx 缓冲，否则心跳/快照小帧被攒着延迟送达，
      // 客户端判活与运行状态推送都会失灵
      "X-Accel-Buffering": "no",
    },
  });
}
