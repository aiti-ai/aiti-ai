import type { AgentEventLike } from "./agent-event-wire";

export interface AgentEventSourceLike {
  readonly readyState: number;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type AgentEventConnectionStatus = "ready_timeout" | "startup_error" | "closed";

export class AgentEventConnectionError extends Error {
  constructor(public readonly status: AgentEventConnectionStatus, message?: string) {
    super(message ?? (
      status === "ready_timeout"
        ? "会话后端启动超时（服务可能刚重启、正在冷恢复），请稍后重试"
        : "会话事件流连接失败（服务可能刚重启或网络波动），请稍后重试"
    ));
    this.name = "AgentEventConnectionError";
  }
}

type Attempt = {
  promise: Promise<void>;
  ready: boolean;
  succeed(): void;
  fail(error: AgentEventConnectionError): void;
};

type Connection = {
  sessionId: string;
  source: AgentEventSourceLike;
  attempt: Attempt;
};

export interface AgentEventConnectionOptions {
  createSource(sessionId: string): AgentEventSourceLike;
  onEvent(event: AgentEventLike): void;
  shouldMaintain(sessionId: string): boolean;
  readinessTimeoutMs: number;
  reconnectDelayMs: number;
  onUnexpectedError?(error: unknown): void;
  /** 任何 data 事件（含服务端心跳 ping）到达时调用——通道活跃信号。 */
  onActivity?(): void;
  /** 连接出错（onerror → 进入重连调度）时调用——通道可疑信号。 */
  onTrouble?(): void;
}

const EVENT_SOURCE_OPEN = 1;
const EVENT_SOURCE_CLOSED = 2;
/** 重连退避上限：base 1s → 2s → 4s → … → 30s 封顶，避免服务不可用时高频重连风暴。 */
const MAX_RECONNECT_DELAY_MS = 30_000;

/** Owns the EventSource, agent-readiness handshake, and passive reconnect. */
export class AgentEventConnection {
  private current: Connection | null = null;
  private retry: { sessionId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private retryGeneration = 0;
  /** 连续重连次数（指数退避用；连接成功 / 终止重试时清零）。 */
  private retryCount = 0;

  constructor(private readonly options: AgentEventConnectionOptions) {}

  close(): void {
    this.stopRetrying();
    if (this.current) this.discard(this.current, new AgentEventConnectionError("closed"));
  }

  maintain(sessionId: string): void {
    if (!this.options.shouldMaintain(sessionId)) return;
    const retryGeneration = this.retryGeneration;
    void this.ensureConnected(sessionId).catch((error) => {
      if (retryGeneration !== this.retryGeneration) return;
      if (error instanceof AgentEventConnectionError) {
        if (error.status === "startup_error") this.stopRetrying();
        else this.scheduleRetry(sessionId);
      } else {
        this.options.onUnexpectedError?.(error);
      }
    });
  }

  async ensureConnected(sessionId: string): Promise<void> {
    while (true) {
      let connection = this.current;
      if (!connection || connection.sessionId !== sessionId) {
        connection = this.open(sessionId);
      } else if (
        connection.attempt.ready
        && connection.source.readyState === EVENT_SOURCE_OPEN
      ) {
        return;
      }

      await connection.attempt.promise;
      if (this.current !== connection) {
        if (this.current?.sessionId === sessionId) continue;
        throw new AgentEventConnectionError("closed");
      }
      if (connection.source.readyState === EVENT_SOURCE_OPEN) return;

      // A once-ready EventSource may otherwise remain CONNECTING indefinitely.
      this.discard(connection, new AgentEventConnectionError("closed"));
    }
  }

  private open(sessionId: string): Connection {
    if (this.current) this.discard(this.current, new AgentEventConnectionError("closed"));

    let source: AgentEventSourceLike;
    try {
      source = this.options.createSource(sessionId);
    } catch (error) {
      throw new AgentEventConnectionError(
        "closed",
        error instanceof Error ? error.message : String(error),
      );
    }

    let settled = false;
    let resolve!: () => void;
    let reject!: (error: AgentEventConnectionError) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const timeout = setTimeout(() => {
      this.fail(connection, new AgentEventConnectionError("ready_timeout"));
    }, this.options.readinessTimeoutMs);
    const attempt: Attempt = {
      promise,
      ready: false,
      succeed() {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      },
      fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    };
    const connection: Connection = { sessionId, source, attempt };
    this.current = connection;

    source.onmessage = (message) => {
      if (this.current !== connection) return;
      let event: AgentEventLike;
      try {
        event = JSON.parse(message.data) as AgentEventLike;
      } catch {
        return;
      }

      // 心跳 ping 只刷新活跃度，不投递给业务层（调用方无需处理）。
      if (event.type === "ping") {
        this.options.onActivity?.();
        return;
      }
      this.options.onActivity?.();

      if (event.type === "connected") {
        attempt.ready = true;
        attempt.succeed();
        this.stopRetrying();
      } else if (event.type === "startup_error") {
        const message = typeof event.errorMessage === "string" ? event.errorMessage : undefined;
        this.fail(connection, new AgentEventConnectionError("startup_error", message));
        return;
      }
      this.options.onEvent(event);
    };
    source.onerror = () => {
      this.options.onTrouble?.();
      // EventSource readyState 语义（error 事件时）：
      //   CONNECTING(0) = 网络层闪断（浏览器正在自动重连）——手动退避重试即可；
      //   CLOSED(2)     = HTTP 层失败（4xx/5xx，如会话 404），浏览器不会自动重连。
      // 对 CLOSED 以 startup_error 语义终止：会话被服务端拒绝时固定 1s 手动重连是
      // 纯浪费（实测一个失效 session 触发 404 风暴：每秒 1 个 events + 1 个探针上报）。
      // 会话恢复后由上层 maintain() 触发点重建（agent 开始 run / 会话切换 / starve 恢复）。
      if (source.readyState === EVENT_SOURCE_CLOSED) {
        this.fail(connection, new AgentEventConnectionError(
          "startup_error",
          "会话事件流被服务端拒绝（HTTP 层错误），已停止重连；会话恢复后自动重建",
        ));
        return;
      }
      this.fail(connection, new AgentEventConnectionError("closed"));
    };

    return connection;
  }

  private fail(connection: Connection, error: AgentEventConnectionError): void {
    if (this.current !== connection) return;
    this.discard(connection, error);
    if (error.status === "startup_error") this.stopRetrying();
    else this.scheduleRetry(connection.sessionId);
  }

  private discard(connection: Connection, error: AgentEventConnectionError): void {
    connection.attempt.fail(error);
    connection.source.close();
    if (this.current === connection) this.current = null;
  }

  private scheduleRetry(sessionId: string): void {
    if (!this.options.shouldMaintain(sessionId)) return;
    if (this.retry?.sessionId === sessionId) return;
    this.clearRetry();

    // 指数退避：base 1s → 2s → 4s → … → 30s 封顶（retryCount 在连接成功时清零）。
    const delay = Math.min(
      this.options.reconnectDelayMs * 2 ** this.retryCount,
      MAX_RECONNECT_DELAY_MS,
    );
    this.retryCount += 1;
    const timer = setTimeout(() => {
      if (this.retry?.timer !== timer) return;
      this.retry = null;
      this.maintain(sessionId);
    }, delay);
    this.retry = { sessionId, timer };
  }

  private stopRetrying(): void {
    this.retryGeneration += 1;
    this.clearRetry();
    this.retryCount = 0;
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry.timer);
    this.retry = null;
  }
}
