import {
  isEventIncludedInSnapshot,
  toClientAgentEvent,
  type AgentEventLike,
} from "./agent-event-wire";

export interface AgentEventStreamSession {
  readonly isStreaming: boolean;
  readonly streamingMessage: unknown;
  onEvent(listener: (event: AgentEventLike) => void): () => void;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
        if (heartbeat !== null) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = null;
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        if (closeController) {
          try { controller.close(); } catch { /* stream already closed */ }
        }
      };
      cancelStream = cleanup;

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
          encode({
            type: "connected",
            sessionId,
            isStreaming: session.isStreaming,
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

      heartbeat = setInterval(() => enqueueText(":\n\n"), HEARTBEAT_INTERVAL_MS);

      // Force the response headers through without claiming that the agent is
      // ready. The client waits for the later `connected` data event.
      enqueueText(":\n\n");
    },
    cancel() {
      cancelStream(false);
    },
  });
}
