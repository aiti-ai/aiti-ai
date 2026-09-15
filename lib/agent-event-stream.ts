import {
  isEventIncludedInSnapshot,
  toClientAgentEvent,
  type AgentEventLike,
} from "./agent-event-wire";
import { acquireSessionLivenessLease } from "./session-liveness";

export interface AgentEventStreamSession {
  readonly isStreaming: boolean;
  readonly streamingMessage: unknown;
  onEvent(listener: (event: AgentEventLike) => void): () => void;
  /** 忙态（与 /api/agent/running 集同口径，含 compaction/队列续轮等 isStreaming 之外的忙态）。
   *  可选：不提供时 connected 帧回退 isStreaming。 */
  isRunning?(): boolean;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 惰性（待启动）会话句柄（2026-09-15）：
 *
 * 打开会话页不再冷启动完整 runtime（只为查看不该拉起 agent）；wrapper 不存在时
 * 由本句柄先以「空闲」形态就绪——SSE 立即发 connected（否则客户端 60s 就绪超时
 * 会误判会话被拒），真实 wrapper 由后续真实交互（发送/steer 等）带起来后经
 * waitForSession 回调附着，其事件经本句柄转发给流。
 *
 * 生命周期：createAgentEventStream 在流 cleanup 时会调用 onEvent 返回的退订，
 * 本句柄据此同时停掉等待与真实订阅。
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
        try { listener(event); } catch { /* 单个监听器异常不影响其他监听器 */ }
      }
    });
  };

  return {
    isStreaming: false,
    streamingMessage: undefined,
    // connected 帧就绪时真没在跑（打开会话只为查看）；wrapper 出现后的事件流
    // 会自带 agent_start/agent_settled 等状态帧，无需这里再合成。
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
  let cancelStream: (closeController: boolean) => void = () => {};
  let releaseLease: () => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = (closeController: boolean) => {
        if (closed) return;
        closed = true;
        releaseLease();
        releaseLease = () => {};
        if (heartbeat !== null) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = null;
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        if (closeController) {
          try { controller.close(); } catch { /* stream already closed */ }
        }
      };
      cancelStream = cleanup;
      releaseLease = acquireSessionLivenessLease(sessionId).release;

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

          const bufferedEvents: AgentEventLike[] = [];
          let snapshotPublished = false;
          const handleEvent = (event: AgentEventLike) => {
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
          unsubscribe = stopListening;

          // Deep-clone the snapshot to decouple from the live streamingMessage
          // whose .content array is shared with the agent's partialMessage and
          // gets mutated in-place by subsequent thinking_delta events.
          const rawSnapshot = session.streamingMessage;
          const snapshot = (rawSnapshot !== undefined && rawSnapshot !== null)
            ? structuredClone(rawSnapshot)
            : rawSnapshot;
          // 规范 id 回显：别名/占位 id（zcode:new-* 等）解析到的句柄已换绑真实
          // 复合 id 时随 connected 帧告知客户端——session_backend_ready 是一次性
          // 事件，rebind 后才（重）连的流永远错过它，客户端将一直钉在别名 id 上
          // （侧栏同会话双行：真身行 + 草稿行）。wrapper 带 sessionId，扩展
          // handle 带 id；取得到且与请求 id 不同才回显。
          const asIded = session as { sessionId?: unknown; id?: unknown };
          const canonicalId = typeof asIded.sessionId === "string" && asIded.sessionId
            ? asIded.sessionId
            : typeof asIded.id === "string" && asIded.id ? asIded.id : undefined;
          encode({
            type: "connected",
            sessionId,
            ...(canonicalId && canonicalId !== sessionId ? { canonicalSessionId: canonicalId } : {}),
            isStreaming: session.isStreaming,
            // 重连/新开页面时前端据此立即恢复「运行中」——isStreaming 会漏掉压缩中
            // （manual compact 先 abort，run 已不活跃）等忙态，前端表现为「显示没运行」。
            isRunning: session.isRunning?.() ?? session.isStreaming,
          });
          // 【重复首字根因修复】buffer 里的事件（listener 装好 → snapshot 发布之间到达）
          // 其效果已全部体现在 snapshot（live partialMessage 的克隆）里：pi 在 emit
          // message_update 之前就已把 delta 应用到 partialMessage。若先重放 buffer
          // 再发 snapshot，前端会先拼接重放 delta、又被 snapshot 覆盖，接着 rAF flush
          // 的批内 delta 在 snapshot 之上再次拼接 → 流式期间开头内容重复
          // （“重复第一个字母/词”），直到 thinking_end/text_end 的全量覆盖才修正。
          // 因此：有 snapshot 时只重放非内容类事件（agent_start 等状态事件），
          // 内容类（message_update/message_start）一律以 snapshot 为准；
          // 无 snapshot（streamingMessage 未建立）时才用 buffer 重放重建。
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

      // 心跳必须是可感知的 data 事件而非注释行：注释行（":\n\n"）不触发
      // EventSource.onmessage，客户端无法据此判断通道活跃，只能靠高频状态
      // 轮询兜底。data 事件让客户端能把「静默超阈」可靠地判定为通道死亡。
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
