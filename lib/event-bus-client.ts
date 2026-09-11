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

import { isExtBootSettled, notifyExtBootSettled, onExtBootSettled } from "./ext-boot-signal";

// boot-settle 信号同图重导出：置位方（ExtSlots）/消费方/测试在同一模块图内驱动（§3-C1 定案锚点）
export { isExtBootSettled, notifyExtBootSettled, onExtBootSettled };

export const BUS_FRAME_HEARTBEAT = "heartbeat";
/** 硬超时兑底：等待机制（ready 广播 / boot settle 信号）失效时的最后防线。常态下定案
 *  由启动批量 settle 锚定（§3-C1，配合 materialize 优先级总线先挂槽），远早于它。 */
const FALLBACK_WAIT_MS = 10_000;

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

/** 总线缺席定案：等待窗口耗尽仍未见槽 → 置位。此后 getEventBus 直接返回 null，
 *  调用方现有的「?? new EventSource / if (!bus)」原 SSE 回退才真正生效（否则
 *  adapter 恒真值，回退分支是死代码——无 aiti-event-bus 的部署会永远连不上）。
 *  总线注册（piwe-event-bus-ready）时复位，之后新连接自动切回总线通道。 */
let busAbsent = false;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // 中途启用（扩展启用/装上后 reload）：复位缺席定案——之后的 getEventBus 重新探测走
  // 总线；已回退的原生连接由各调用方既有断线重连语义在下次重连时自动切回（重连重走
  // getEventBus 探测）。不主动关闭已回退连接：缺席只在真缺席（禁用/卸载）时定案，
  // 此时回退是正确终态，主动切回反而破坏降级（§3-C2 裁决，见方案文档 §3-C 注）。
  window.addEventListener("piwe-event-bus-ready", () => { busAbsent = false; });
}

/**
 * 返回总线适配器（EventSource 兼容面）；总线能力最终不在 → 适配器转 CLOSED 并
 * 触发一次 onerror，调用方按各自重试语义回退原 SSE（下次 connect 重新探测——
 * 总线后续就绪时自动切回总线通道）。
 */
export function getEventBus(route: string, opts: GetEventBusOptions = {}): BusEventSource | null {
  if (typeof window === "undefined") return null;
  // 启动批量已 settle 而槽仍不在 → 立即定案缺席（同步回退，调用方走原生 SSE）。
  // §3-C1：部署了总线的页面 settle 时槽必已在（materialize 优先级），不会误伤。
  if (!readSlot() && isExtBootSettled()) busAbsent = true;
  // 缺席已定案 → 同步回退（slot 又挂上的极端窗口由 readSlot 兜底照常走总线）
  if (busAbsent && !readSlot()) return null;
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
  // onmessage 是 EventSource 的属性式句柄（订阅方 bus.onmessage = fn 直接赋值），不进
  // 任何集合——必须单独保存并在 emitMessage 里调用。曾漏接线：赋值落在普通数据属性上，
  // 总线模式下数据帧永远进不了订阅方（named/心跳/onopen 均正常，极难察觉）。
  let onmessageHandler: ((event: MessageEvent<string>) => void) | null = null;

  const emitMessage = (data: string) => {
    const event = new MessageEvent("message", { data });
    for (const fn of [...messageListeners]) {
      try { fn(event); } catch { /* 订阅方异常不扩散 */ }
    }
    try { onmessageHandler?.(event); } catch { /* noop */ }
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
    get onmessage() { return onmessageHandler; },
    set onmessage(fn: ((event: MessageEvent<string>) => void) | null) { onmessageHandler = fn; },
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
    // 展开顺序：type: evt 必须写在 payload 之后——payload 里残留的 topic type 否则会
    // 覆盖掉 evt（重组产物 type 错成 topic，订阅方按 evt 分派全部落空）
    const data = evt !== undefined
      ? JSON.stringify({ ...payload, type: evt })
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

  // 槽未挂（loader 懒加载竞态）：三源先到先定案（统一 SSE 端口方案 §3-C1）——
  //   1. piwe-event-bus-ready 广播（register 时派发）：槽在 → 立即上总线
  //   2. 启动批量 settle 信号：部署了总线的页面此时槽必已在；仍未挂 → 定案缺席回退
  //   3. 硬超时兑底：仅作信号机制失效的最后防线（BOOT_SETTLED 前 3s 固定窗口已废——
  //      它把「正常但慢的加载」误判成缺席，是 SSE 泄露的根因之一）
  if (typeof window.addEventListener !== "function") {
    // 无事件面的极简环境（单测桩等）：无从等待也无从挂槽，立即定案缺席
    busAbsent = true;
    return null;
  }
  const markAbsent = () => {
    busAbsent = true;
    closed = true;
    readyState = CLOSED;
    fireError();
    messageListeners.clear();
    namedListeners.clear();
  };
  const onReady = () => {
    const s = readSlot();
    if (!s) return; // 广播时槽不在（异常时序）：不定案，继续等 settle/超时
    cleanupWait();
    beginSubscribe(s);
  };
  const onSettle = () => {
    cleanupWait();
    if (closed) return;
    const s = readSlot();
    if (s) beginSubscribe(s);
    else markAbsent();
  };
  const timer = setTimeout(() => onSettle(), FALLBACK_WAIT_MS);
  let unwaitSettle: () => void = () => {}; // 占位：onExtBootSettled 同步回调时 cleanupWait 已可用
  const cleanupWait = () => {
    window.removeEventListener("piwe-event-bus-ready", onReady);
    unwaitSettle();
    clearTimeout(timer);
  };
  window.addEventListener("piwe-event-bus-ready", onReady);
  unwaitSettle = onExtBootSettled(onSettle);
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
