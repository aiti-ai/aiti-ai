// core 宿主的标准总线入口：getEventBus(route)（页面事件唯一 SSE 收敛）。
//
// 背景：浏览器 HTTP/1.1 同 host 仅 ~6 条并发连接，页面上 running/events、
// agent/[id]/events、terminal/[id]/events、files watch 各自建连（扩展页面事件已
// 收敛 aiti-event-bus，拍板 2026-09-09），叠加后仍可能占满配额。本工厂把 core
// 各 SSE 通道收敛到同一总线：系统提供总线能力（aiti-event-bus 扩展部署，
// window.__piEventBus 在）→ 按分发 type 走唯一 SSE；最终不提供 → 适配器转
// CLOSED + 一次性 onerror，调用方按各自重试语义回退原样 EventSource(route)。
//
// 帧协议（总线分发约定）：服务端按 { type: <topic>, evt?: "<原事件type>", ...payload }
// 发布；本适配器把帧重组回原 SSE 帧形状（{type: evt, ...payload}）后：
//   - 无 evt（如 running 帧原样）→ data = 整帧，走 onmessage
//   - 有 evt（terminal output/exit、file connected/change、agent 业务帧）→
//     data = {type: evt, ...payload}，同时派发 onmessage 与 named event <evt>
//     （调用方用 onmessage 或 addEventListener("change",…) 都行，与原 SSE 等价）
// 总线传输层 named heartbeat（30s）→ 派发 named "heartbeat"（running broker 判活用）。

export const BUS_FRAME_HEARTBEAT = "heartbeat";
/** 槽就绪等待窗口：扩展 client 是 loader 懒加载，broker 首连可能早于 register 挂槽 */
const FALLBACK_WAIT_MS = 3_000;

/** 与 lib/agent-event-connection.ts 的 AgentEventSourceLike / 原生 EventSource 的公共面 */
export interface BusEventSource {
  readonly readyState: number; // 0 CONNECTING / 1 OPEN / 2 CLOSED（模拟语义）
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
  /** 派发 named event（适配器封装的建连语义用：如 file-watch 的票据成功 → "connected"）。
   *  非帧分发通道——普通订阅方只用 addEventListener/onmessage。 */
  dispatchNamed(name: string, data: unknown): void;
}

interface PiEventBusSlot {
  /** aiti-event-bus client broker 的主题订阅（同一单例，扩展 ctx 注册面共享） */
  subscribeTopics(
    handler: (frame: Record<string, unknown>) => void,
    types: string[],
    onStatus?: (status: "up" | "down" | "reconnecting") => void,
  ): { ready: Promise<void>; off: () => void };
}

interface EventBusWindow {
  __piEventBus?: PiEventBusSlot;
}

export interface GetEventBusOptions {
  /** 分发 type（总线 topic）。缺省从 route 派生：/api/xxx/y → "xxx-y"。 */
  topic?: string;
  /**
   * 总线就绪前的前置动作（如 agent 会话 attach POST——有建连副作用的通道必须
   * 在订阅生效前完成服务端注册）。失败以 startup_error 帧投递 onmessage
   * （AgentEventConnection 协议帧，语义：不重试）。
   */
  onSetup?: () => Promise<void>;
}

function topicFromRoute(route: string): string {
  const path = route.replace(/^\//, "").split("?")[0].replace(/\[|\]/g, "");
  return path.split("/").filter(Boolean).join("-");
}

function readSlot(): PiEventBusSlot | null {
  if (typeof window === "undefined") return null;
  const bus = (window as unknown as EventBusWindow).__piEventBus;
  return bus?.subscribeTopics ? bus : null;
}

/**
 * 返回总线适配器（EventSource 兼容面）；总线能力最终不在 → 适配器转 CLOSED 并
 * 触发一次 onerror，调用方按各自重试语义回退原 SSE（下次 connect 重新探测——
 * 总线后续就绪时自动切回总线通道）。
 */
export function getEventBus(route: string, opts: GetEventBusOptions = {}): BusEventSource | null {
  if (typeof window === "undefined") return null;
  const topic = opts.topic ?? topicFromRoute(route);
  const slot = readSlot();

  // —— 适配器状态（连接生命周期内共享）——
  const CONNECTING = 0, OPEN = 1, CLOSED = 2;
  let readyState: number = CONNECTING;
  let closed = false;
  let subscribed = false;
  let off: (() => void) | null = null;

  const messageListeners = new Set<(e: MessageEvent<string>) => void>();
  const namedListeners = new Map<string, Set<(e: MessageEvent<string>) => void>>();

  const emitMessage = (data: string) => {
    for (const fn of [...messageListeners]) {
      try { fn(new MessageEvent("message", { data })); } catch { /* 订阅方异常不扩散 */ }
    }
  };
  const emitNamed = (name: string, data: string) => {
    for (const fn of [...(namedListeners.get(name) ?? [])]) {
      try { fn(new MessageEvent(name, { data })); } catch { /* 订阅方异常不扩散 */ }
    }
  };
  const fireError = () => {
    try { adapter.onerror?.(new Event("error")); } catch { /* noop */ }
  };

  const adapter: BusEventSource = {
    get readyState() { return readyState; },
    onmessage: null,
    onerror: null,
    onopen: null,
    addEventListener(type, listener) {
      if (!namedListeners.has(type)) namedListeners.set(type, new Set());
      namedListeners.get(type)!.add(listener);
    },
    dispatchNamed(name, data) {
      emitNamed(name, JSON.stringify(data ?? {}));
    },
    close() {
      if (closed) return;
      closed = true;
      readyState = CLOSED;
      try { off?.(); } catch { /* noop */ }
      off = null;
      messageListeners.clear();
      namedListeners.clear();
    },
  };

  // 分发：帧 {type: topic, evt?, ...payload} → 重组原形状后 onmessage + named
  const handler = (frame: Record<string, unknown>) => {
    if (closed) return;
    const { evt, ...payload } = frame as { evt?: string };
    const data = evt !== undefined
      ? JSON.stringify({ type: evt, ...payload })
      : JSON.stringify(frame);
    emitMessage(data);
    if (evt !== undefined) emitNamed(evt, data);
  };

  const onStatus = (status: "up" | "down" | "reconnecting") => {
    if (closed) return;
    if (status === "up") {
      if (readyState !== OPEN) {
        readyState = OPEN;
        try { adapter.onopen?.(new Event("open")); } catch { /* noop */ }
      }
      return;
    }
    // down / reconnecting：一次性 onerror（broker 自动重连，恢复 up 即 onopen 复位）
    if (readyState === OPEN) {
      readyState = CONNECTING;
      fireError();
    }
  };

  const beginSubscribe = (busSlot: PiEventBusSlot) => {
    if (closed || subscribed) return;
    subscribed = true;
    void (async () => {
      if (opts.onSetup) {
        try {
          await opts.onSetup();
        } catch (e) {
          if (closed) return;
          closed = true;
          readyState = CLOSED;
          const message = e instanceof Error ? e.message : String(e);
          // startup_error 协议帧（AgentEventConnection 语义：不重试）
          emitMessage(JSON.stringify({ type: "startup_error", errorMessage: message }));
          return;
        }
      }
      if (closed) return;
      const sub = busSlot.subscribeTopics(handler, [topic], onStatus);
      off = sub.off;
      try {
        await sub.ready;
      } catch {
        // 总线不可达：转 CLOSED + 一次性 onerror（调用方回退原 SSE；下次 connect 重新探测）
        if (!closed) {
          closed = true;
          readyState = CLOSED;
          fireError();
        }
        return;
      }
      if (closed) return;
      readyState = OPEN;
      try { adapter.onopen?.(new Event("open")); } catch { /* noop */ }
    })();
  };

  if (slot) {
    beginSubscribe(slot);
    return adapter;
  }

  // 槽未挂（loader 懒加载竞态）：等待 ready 广播（register 时派发，立即唤醒），
  // 超时槽仍不在 → 转 CLOSED + 一次性 onerror（调用方回退原 SSE）
  const onReady = () => {
    cleanupWait();
    const s = readSlot();
    if (s) beginSubscribe(s);
    else {
      closed = true;
      readyState = CLOSED;
      fireError();
      messageListeners.clear();
      namedListeners.clear();
    }
  };
  const timer = setTimeout(() => {
    cleanupWait();
    if (closed) return;
    const s = readSlot();
    if (s) beginSubscribe(s);
    else {
      closed = true;
      readyState = CLOSED;
      fireError();
      messageListeners.clear();
      namedListeners.clear();
    }
  }, FALLBACK_WAIT_MS);
  const cleanupWait = () => {
    window.removeEventListener("piwe-event-bus-ready", onReady);
    clearTimeout(timer);
  };
  window.addEventListener("piwe-event-bus-ready", onReady, { once: true });
  const originalClose = adapter.close.bind(adapter);
  adapter.close = () => {
    cleanupWait();
    originalClose();
  };
  return adapter;
}

/** 总线能力探测（订阅方决定 UI 提示/降级语义用） */
export function hasEventBus(): boolean {
  if (typeof window === "undefined") return false;
  const bus = (window as unknown as EventBusWindow).__piEventBus;
  return typeof bus?.subscribeTopics === "function";
}

declare global {
  interface Window {
    __piEventBus?: PiEventBusSlot;
  }
}
